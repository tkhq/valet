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
    LeftBracket,
    RightBracket,
    StringKey(String),
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
            Token::LeftBrace | Token::LeftBracket | Token::LeftParen => {
                nesting_depth = nesting_depth.saturating_add(1);
                max_nesting_depth = max_nesting_depth.max(nesting_depth);
            }
            Token::RightBrace | Token::RightBracket | Token::RightParen => {
                nesting_depth = nesting_depth.saturating_sub(1);
            }
            Token::Name(name) => {
                let line_start = at_line_start(&tokens, index);
                let (path, next) = name_path(&tokens, index);

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

                let (path, call_end, bracketed) = callable_path(&tokens, path, next);
                max_reference_depth = max_reference_depth.max(path.split('.').count());
                let followed_by_paren = matches!(tokens.get(call_end), Some(Token::LeftParen));
                if bracketed && followed_by_paren {
                    return Err(EngineError::UnsupportedCallableSyntax(path));
                }
                let declaration = nesting_depth == 0 && line_start && followed_by_paren;
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

/// Validates calls without allowing user functions to shadow inventoried built-ins.
pub(crate) fn validate_calls(
    analyses: &[SourceAnalysis],
    profile: &CapabilityProfile,
) -> Result<(), EngineError> {
    let builtin_names: BTreeSet<_> = profile
        .builtins
        .iter()
        .map(|builtin| builtin.name.as_str())
        .collect();
    let mut declarations_by_package: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut qualified_declarations = BTreeSet::new();
    for analysis in analyses {
        let package = analysis.package.as_deref().unwrap_or_default();
        for function in &analysis.declared_functions {
            let qualified = format!("{package}.{function}");
            let collision = [function.as_str(), qualified.as_str()]
                .into_iter()
                .find(|name| builtin_names.contains(name));
            if let Some(name) = collision {
                return Err(EngineError::BuiltinDeclarationCollision(name.to_owned()));
            }
            declarations_by_package
                .entry(package)
                .or_default()
                .insert(function);
            qualified_declarations.insert(qualified);
            qualified_declarations.insert(format!("data.{package}.{function}"));
        }
    }

    for analysis in analyses {
        let local = analysis
            .package
            .as_deref()
            .and_then(|package| declarations_by_package.get(package));
        for call in &analysis.calls {
            let expanded = expand_alias(call, &analysis.import_aliases);
            let declared = local.is_some_and(|functions| functions.contains(call.as_str()))
                || qualified_declarations.contains(call)
                || qualified_declarations.contains(&expanded);
            if declared {
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

fn skip_newlines(tokens: &[Token], mut index: usize) -> usize {
    while matches!(tokens.get(index), Some(Token::Newline)) {
        index = index.saturating_add(1);
    }
    index
}

fn callable_path(tokens: &[Token], mut path: String, mut index: usize) -> (String, usize, bool) {
    let mut bracketed = false;
    loop {
        let after_trivia = skip_newlines(tokens, index);
        match tokens.get(after_trivia) {
            Some(Token::Dot) => {
                let Some(Token::Name(segment)) = tokens.get(after_trivia.saturating_add(1)) else {
                    return (path, after_trivia, bracketed);
                };
                path.push('.');
                path.push_str(segment);
                index = after_trivia.saturating_add(2);
            }
            Some(Token::LeftBracket) => {
                let content = skip_newlines(tokens, after_trivia.saturating_add(1));
                let Some(Token::StringKey(segment)) = tokens.get(content) else {
                    let end = dynamic_callable_end(tokens, after_trivia);
                    return (path, end, true);
                };
                let end = skip_newlines(tokens, content.saturating_add(1));
                if !matches!(tokens.get(end), Some(Token::RightBracket)) {
                    return (path, end, true);
                }
                path.push('.');
                path.push_str(segment);
                bracketed = true;
                index = end.saturating_add(1);
            }
            _ => return (path, after_trivia, bracketed),
        }
    }
}

fn dynamic_callable_end(tokens: &[Token], start: usize) -> usize {
    let mut index = bracket_end(tokens, start).unwrap_or(start);
    loop {
        match tokens.get(index) {
            Some(Token::LeftBracket) => index = bracket_end(tokens, index).unwrap_or(index),
            Some(Token::Dot)
                if matches!(tokens.get(index.saturating_add(1)), Some(Token::Name(_))) =>
            {
                index = index.saturating_add(2);
            }
            _ => return index,
        }
    }
}

fn bracket_end(tokens: &[Token], start: usize) -> Option<usize> {
    let mut depth = 0_usize;
    for (index, token) in tokens.iter().enumerate().skip(start) {
        match token {
            Token::LeftBracket => depth = depth.saturating_add(1),
            Token::RightBracket => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(index.saturating_add(1));
                }
            }
            _ => {}
        }
    }
    None
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
                let start = index;
                index = skip_quoted(&chars, index.saturating_add(1), '"', true);
                let literal: String = chars[start..index.min(chars.len())].iter().collect();
                match serde_json::from_str(&literal) {
                    Ok(value) => tokens.push(Token::StringKey(value)),
                    Err(_) => tokens.push(Token::Other),
                }
            }
            '`' => {
                let start = index.saturating_add(1);
                index = skip_quoted(&chars, start, '`', false);
                let end = index.saturating_sub(1).min(chars.len());
                tokens.push(Token::StringKey(chars[start..end].iter().collect()));
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
            '{' => {
                tokens.push(Token::LeftBrace);
                index = index.saturating_add(1);
            }
            '}' => {
                tokens.push(Token::RightBrace);
                index = index.saturating_add(1);
            }
            '[' => {
                tokens.push(Token::LeftBracket);
                index = index.saturating_add(1);
            }
            ']' => {
                tokens.push(Token::RightBracket);
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
