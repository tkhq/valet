use crate::compatibility::{BuiltinStatus, CapabilityProfile};
use crate::limits::EnforcedLimits;
use crate::EngineError;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
enum Token {
    Name(String),
    Dot,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    Newline,
    Other,
}

#[derive(Debug)]
pub(crate) struct SourceAnalysis {
    pub package: Option<String>,
    pub has_decision_rule: bool,
    calls: BTreeSet<String>,
    declared_functions: BTreeSet<String>,
    import_aliases: BTreeMap<String, String>,
}

pub(crate) fn analyze(
    source: &str,
    limits: &EnforcedLimits,
) -> Result<SourceAnalysis, EngineError> {
    let tokens = tokenize(source);
    if tokens.len() > limits.max_source_tokens {
        return Err(EngineError::SourceTokenLimit {
            actual: tokens.len(),
            limit: limits.max_source_tokens,
        });
    }

    let mut package = None;
    let mut has_decision_rule = false;
    let mut calls = BTreeSet::new();
    let mut declared_functions = BTreeSet::new();
    let mut import_aliases = BTreeMap::new();
    let mut nesting_depth = 0_usize;
    let mut max_nesting_depth = 0_usize;
    let mut max_reference_depth = 0_usize;
    let mut index = 0_usize;

    while index < tokens.len() {
        match &tokens[index] {
            Token::LeftBrace | Token::LeftParen => {
                nesting_depth = nesting_depth.saturating_add(1);
                max_nesting_depth = max_nesting_depth.max(nesting_depth);
            }
            Token::RightBrace | Token::RightParen => {
                nesting_depth = nesting_depth.saturating_sub(1);
            }
            Token::Name(name) => {
                let line_start = at_line_start(&tokens, index);
                let (path, next) = name_path(&tokens, index);
                max_reference_depth = max_reference_depth.max(path.split('.').count());

                if nesting_depth == 0 && line_start && name == "package" {
                    let (value, after) = name_path(&tokens, index.saturating_add(1));
                    if !value.is_empty() {
                        package = Some(value);
                    }
                    index = after;
                    continue;
                }
                if nesting_depth == 0 && line_start && name == "import" {
                    let (imported, after) = name_path(&tokens, index.saturating_add(1));
                    if !imported.is_empty() {
                        let default_alias = imported
                            .rsplit('.')
                            .next()
                            .unwrap_or(imported.as_str())
                            .to_owned();
                        let (alias, end) = import_alias(&tokens, after, default_alias);
                        import_aliases.insert(alias, imported);
                        index = end;
                    }
                    continue;
                }

                let followed_by_paren = matches!(tokens.get(next), Some(Token::LeftParen));
                let declaration =
                    nesting_depth == 0 && line_start && !path.contains('.') && followed_by_paren;
                if declaration {
                    declared_functions.insert(path);
                } else if followed_by_paren {
                    calls.insert(path);
                }
                let follows_default = index > 0
                    && matches!(tokens.get(index - 1), Some(Token::Name(previous)) if previous == "default")
                    && (index == 1 || matches!(tokens.get(index - 2), Some(Token::Newline)));
                if nesting_depth == 0
                    && (line_start || follows_default)
                    && name == "decision"
                    && !followed_by_paren
                {
                    has_decision_rule = true;
                }
                index = next;
                continue;
            }
            _ => {}
        }
        index = index.saturating_add(1);
    }

    if max_nesting_depth > limits.max_source_nesting_depth {
        return Err(EngineError::SourceDepthLimit {
            actual: max_nesting_depth,
            limit: limits.max_source_nesting_depth,
        });
    }
    if max_reference_depth > limits.max_reference_depth {
        return Err(EngineError::ReferenceDepthLimit {
            actual: max_reference_depth,
            limit: limits.max_reference_depth,
        });
    }
    Ok(SourceAnalysis {
        package,
        has_decision_rule,
        calls,
        declared_functions,
        import_aliases,
    })
}

pub(crate) fn validate_calls(
    analyses: &[SourceAnalysis],
    profile: &CapabilityProfile,
) -> Result<(), EngineError> {
    let mut declared = BTreeSet::new();
    for analysis in analyses {
        for function in &analysis.declared_functions {
            declared.insert(function.clone());
            if let Some(package) = &analysis.package {
                declared.insert(format!("{package}.{function}"));
                declared.insert(format!("data.{package}.{function}"));
            }
        }
    }

    for analysis in analyses {
        for call in &analysis.calls {
            let expanded = expand_alias(call, &analysis.import_aliases);
            if declared.contains(call) || declared.contains(&expanded) {
                continue;
            }
            let builtin = profile.builtins.iter().find(|item| item.name == *call);
            match builtin {
                Some(item) if item.status == BuiltinStatus::Rejected => {
                    return Err(EngineError::RejectedBuiltin(call.clone()));
                }
                Some(item)
                    if item.enabled
                        && matches!(
                            item.status,
                            BuiltinStatus::Verified | BuiltinStatus::AvailableUnverified
                        ) => {}
                Some(_) => return Err(EngineError::UnavailableBuiltin(call.clone())),
                None => return Err(EngineError::UndeclaredBuiltin(call.clone())),
            }
        }
    }
    Ok(())
}

fn at_line_start(tokens: &[Token], index: usize) -> bool {
    index == 0 || matches!(tokens.get(index.saturating_sub(1)), Some(Token::Newline))
}

fn import_alias(tokens: &[Token], index: usize, default_alias: String) -> (String, usize) {
    if matches!(tokens.get(index), Some(Token::Name(name)) if name == "as") {
        if let Some(Token::Name(alias)) = tokens.get(index.saturating_add(1)) {
            return (alias.clone(), index.saturating_add(2));
        }
    }
    (default_alias, index)
}

fn expand_alias(call: &str, aliases: &BTreeMap<String, String>) -> String {
    let (first, rest) = call.split_once('.').unwrap_or((call, ""));
    let Some(prefix) = aliases.get(first) else {
        return call.to_owned();
    };
    if rest.is_empty() {
        prefix.clone()
    } else {
        format!("{prefix}.{rest}")
    }
}

fn name_path(tokens: &[Token], start: usize) -> (String, usize) {
    let Some(Token::Name(first)) = tokens.get(start) else {
        return (String::new(), start);
    };
    let mut path = first.clone();
    let mut index = start.saturating_add(1);
    while matches!(tokens.get(index), Some(Token::Dot)) {
        let Some(Token::Name(next)) = tokens.get(index.saturating_add(1)) else {
            break;
        };
        path.push('.');
        path.push_str(next);
        index = index.saturating_add(2);
    }
    (path, index)
}

fn tokenize(source: &str) -> Vec<Token> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0_usize;
    while index < chars.len() {
        match chars[index] {
            '#' => {
                while index < chars.len() && chars[index] != '\n' {
                    index = index.saturating_add(1);
                }
            }
            '"' => {
                index = skip_quoted(&chars, index.saturating_add(1), '"', true);
                tokens.push(Token::Other);
            }
            '`' => {
                index = skip_quoted(&chars, index.saturating_add(1), '`', false);
                tokens.push(Token::Other);
            }
            '\n' => {
                tokens.push(Token::Newline);
                index = index.saturating_add(1);
            }
            '.' => {
                tokens.push(Token::Dot);
                index = index.saturating_add(1);
            }
            '(' => {
                tokens.push(Token::LeftParen);
                index = index.saturating_add(1);
            }
            ')' => {
                tokens.push(Token::RightParen);
                index = index.saturating_add(1);
            }
            '{' | '[' => {
                tokens.push(Token::LeftBrace);
                index = index.saturating_add(1);
            }
            '}' | ']' => {
                tokens.push(Token::RightBrace);
                index = index.saturating_add(1);
            }
            character if character == '_' || character.is_ascii_alphabetic() => {
                let start = index;
                index = index.saturating_add(1);
                while index < chars.len()
                    && (chars[index] == '_' || chars[index].is_ascii_alphanumeric())
                {
                    index = index.saturating_add(1);
                }
                tokens.push(Token::Name(chars[start..index].iter().collect()));
            }
            character if character.is_whitespace() => index = index.saturating_add(1),
            _ => {
                tokens.push(Token::Other);
                index = index.saturating_add(1);
            }
        }
    }
    tokens
}

fn skip_quoted(chars: &[char], mut index: usize, delimiter: char, escapes: bool) -> usize {
    while index < chars.len() {
        if escapes && chars[index] == '\\' {
            index = index.saturating_add(2);
        } else if chars[index] == delimiter {
            return index.saturating_add(1);
        } else {
            index = index.saturating_add(1);
        }
    }
    index
}
