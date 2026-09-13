use serde::Deserialize;
use std::collections::BTreeSet;
use valet_policy_engine::{
    capability_profile, evaluate_bundle, AuthorizationEffect, BundleCompatibility, CanonicalJson,
    EngineError, EvaluationOptions, ExplainMode, LoadedSourceBundle, ProvenanceEntry,
    ProvenanceMap, SourceBundle, SourceMetadata, SourceModule,
};

fn module(id: &str, source: &str) -> SourceModule {
    SourceModule {
        id: id.to_owned(),
        source: source.to_owned(),
        metadata: SourceMetadata::valet_generated(),
    }
}

fn load(modules: Vec<SourceModule>) -> Result<LoadedSourceBundle, EngineError> {
    LoadedSourceBundle::load(SourceBundle {
        compatibility: BundleCompatibility::current(),
        modules,
        data_json: "{}".to_owned(),
        provenance: ProvenanceMap::default(),
    })
}

const DECISION: &str =
    r#"{"effect":"allow","reasonCode":"ok","matchedRuleIds":[],"obligations":[],"redactions":[]}"#;

#[test]
fn enabled_inventory_matches_the_exact_pinned_registry() {
    let checked_in: BTreeSet<String> =
        serde_json::from_str(include_str!("../compatibility/enabled-builtins-v1.json"))
            .expect("enabled registry inventory must parse");
    let substrate: BTreeSet<String> = regorus::unstable::BUILTINS
        .keys()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(checked_in, substrate);

    let profile = capability_profile().expect("profile must parse");
    let enabled: BTreeSet<String> = profile
        .builtins
        .iter()
        .filter(|builtin| builtin.enabled)
        .map(|builtin| builtin.name.clone())
        .collect();
    assert_eq!(enabled, substrate);
    assert_eq!(profile.enabled_builtin_count, substrate.len());

    let manifest: CorpusManifest = serde_json::from_str(include_str!("../corpus/manifest-v1.json"))
        .expect("corpus manifest must parse");
    let case_ids: BTreeSet<_> = manifest.cases.iter().map(|case| case.id.as_str()).collect();
    assert_eq!(
        case_ids.len(),
        manifest.cases.len(),
        "duplicate corpus case ID"
    );
    for feature in &profile.language_features {
        let case_id = feature
            .evidence
            .strip_prefix("corpus.")
            .expect("language feature evidence must reference a corpus case");
        let case = manifest
            .cases
            .iter()
            .find(|case| case.id == case_id)
            .unwrap_or_else(|| panic!("{} references missing corpus case {case_id}", feature.name));
        assert_eq!(case.feature, feature.name, "{case_id} feature mismatch");
    }
}

#[test]
fn tokenizer_distinguishes_declarations_calls_and_inert_text() {
    let helper = r#"
package valet.helpers
import rego.v1
allowed(subject) if startswith(subject, "user")
"#;
    let policy = format!(
        r#"
package valet.authz
import rego.v1
import data.valet.helpers as helpers
# time.now_ns() and unknown.comment() are inert.
note := `http.send() unknown.raw()`
quoted := "rand.intn() unknown.string()"
decision := {DECISION} if {{
    helpers.allowed("user-1")
    data.valet.helpers.allowed("user-2")
}}
"#
    );
    let loaded = load(vec![
        module("authz.rego", &policy),
        module("helpers.rego", helper),
    ])
    .expect("normal Rego calls and declarations must validate");
    let result = evaluate_bundle(
        &loaded,
        &CanonicalJson::parse("{}").unwrap(),
        EvaluationOptions::default(),
    )
    .expect("policy must evaluate");
    assert_eq!(result.decision.effect, AuthorizationEffect::Allow);
}

#[test]
fn newline_and_comment_trivia_cannot_hide_rejected_calls() {
    for trivia in ["\n", "\n\n", " # comment\n", " # comment\n\n # second\n"] {
        let policy = format!(
            "package valet.authz\nimport rego.v1\ndecision := {DECISION} if {{ trace{trivia}(\"m\") }}\n"
        );
        assert!(
            regorus::Engine::new()
                .add_policy("laundered.rego".to_owned(), policy.clone())
                .is_ok(),
            "Regorus must accept the focused repro"
        );
        assert!(matches!(
            load(vec![module("laundered.rego", &policy)]),
            Err(EngineError::RejectedBuiltin(name)) if name == "trace"
        ));
    }
}

#[test]
fn declarations_are_package_scoped_and_cannot_shadow_builtins() {
    let decision =
        format!("package valet.authz\nimport rego.v1\ndecision := {DECISION} if trace(\"m\")\n");
    let decoy = "package decoy\nimport rego.v1\ntrace(x) := x\n";
    let mut parser = regorus::Engine::new();
    parser
        .add_policy("authz.rego".to_owned(), decision.clone())
        .expect("Regorus must accept the builtin call");
    parser
        .add_policy("decoy.rego".to_owned(), decoy.to_owned())
        .expect("Regorus must accept the decoy declaration");
    assert!(matches!(
        load(vec![module("authz.rego", &decision), module("decoy.rego", decoy)]),
        Err(EngineError::BuiltinDeclarationCollision(name)) if name == "trace"
    ));

    let unqualified = format!(
        "package valet.authz\nimport rego.v1\ndecision := {DECISION} if allowed(\"user\")\n"
    );
    let other_package =
        "package valet.helpers\nimport rego.v1\nallowed(subject) if startswith(subject, \"user\")\n";
    assert!(matches!(
        load(vec![
            module("authz.rego", &unqualified),
            module("helpers.rego", other_package),
        ]),
        Err(EngineError::UndeclaredBuiltin(name)) if name == "allowed"
    ));
}

#[test]
fn package_qualified_builtin_declarations_collide() {
    let decoy = "package time\nimport rego.v1\nnow_ns(x) := 0\n";
    for (imports, call) in [
        ("", "time.now_ns(1)"),
        ("", "data.time.now_ns(1)"),
        ("import data.time as clock\n", "clock.now_ns(1)"),
    ] {
        let policy = format!(
            "package valet.authz\nimport rego.v1\n{imports}decision := {DECISION} if {call} == 0\n"
        );
        assert!(matches!(
            load(vec![module("authz.rego", &policy), module("time.rego", decoy)]),
            Err(EngineError::BuiltinDeclarationCollision(name)) if name == "time.now_ns"
        ));
    }
}

#[test]
fn bracket_callable_syntax_fails_validation() {
    for (imports, call, path) in [
        ("", "time[\"now_ns\"](1)", "time.now_ns"),
        ("", "data.time[\"now_ns\"](1)", "data.time.now_ns"),
        (
            "import data.time as clock\n",
            "clock[\"now_ns\"](1)",
            "clock.now_ns",
        ),
        (
            "",
            "azure[\"policy\"] # comment\n [\"fn\"]\n[\"add_days\"] (1, 2)",
            "azure.policy.fn.add_days",
        ),
        ("", "azure[input.key](1)", "azure"),
    ] {
        let policy = format!(
            "package valet.authz\nimport rego.v1\n{imports}decision := {DECISION} if {call} == 0\n"
        );
        assert!(matches!(
            load(vec![module("bracket.rego", &policy)]),
            Err(EngineError::UnsupportedCallableSyntax(name)) if name == path
        ));
    }
}

#[test]
fn numeric_index_before_a_new_parenthesized_statement_is_not_a_call() {
    let policy = format!(
        r#"
package valet.authz
import rego.v1
decision := {DECISION} if {{
    arr := [1]
    v := arr[0]
    (v + 1) == 2
}}
"#
    );
    let loaded = load(vec![module("numeric-index.rego", &policy)])
        .expect("numeric indexing must not become a callable reference");
    let result = evaluate_bundle(
        &loaded,
        &CanonicalJson::parse("{}").unwrap(),
        EvaluationOptions::default(),
    )
    .expect("numeric indexing must evaluate");
    assert_eq!(result.decision.effect, AuthorizationEffect::Allow);
}

#[test]
fn same_package_and_dotted_ref_head_functions_are_accepted() {
    let helpers = r#"
package valet.authz
import rego.v1
allowed
# declaration trivia
(subject) if startswith(subject, "user")
util.allowed(subject) := allowed(subject)
"#;
    let policy = format!(
        r#"
package valet.authz
import rego.v1
decision := {DECISION} if {{
    allowed("user-local")
    util.allowed("user-dotted")
    data.valet.authz.util.allowed("user-qualified")
}}
"#
    );
    let loaded = load(vec![
        module("authz.rego", &policy),
        module("helpers.rego", helpers),
    ])
    .expect("same-package and dotted functions must validate");
    let result = evaluate_bundle(
        &loaded,
        &CanonicalJson::parse("{}").unwrap(),
        EvaluationOptions::default(),
    )
    .expect("same-package and dotted functions must evaluate");
    assert_eq!(result.decision.effect, AuthorizationEffect::Allow);
}

#[test]
fn malformed_or_unclosed_source_fails_closed() {
    for policy in [
        "package valet.authz\nimport rego.v1\ndecision := {\n",
        "package valet.authz\nimport rego.v1\ndecision := \"unterminated\n",
        "package valet.authz\nimport rego.v1\ndecision := `unterminated\n",
    ] {
        assert!(matches!(
            load(vec![module("malformed.rego", policy)]),
            Err(EngineError::Policy { .. })
        ));
    }
}

#[test]
fn unknown_dynamic_or_builtin_style_calls_fail_closed() {
    let policy = format!(
        "package valet.authz\nimport rego.v1\ndecision := {DECISION} if unknown.call(input)\n"
    );
    assert!(matches!(
        load(vec![module("unknown.rego", &policy)]),
        Err(EngineError::UndeclaredBuiltin(name)) if name == "unknown.call"
    ));
}

#[test]
fn source_bundle_checks_compatibility_structure_canonical_json_and_provenance() {
    let policy = format!("package valet.authz\nimport rego.v1\ndecision := {DECISION}\n");
    let mut incompatible = BundleCompatibility::current();
    incompatible.engine_version = "different".to_owned();
    assert!(matches!(
        LoadedSourceBundle::load(SourceBundle {
            compatibility: incompatible,
            modules: vec![module("authz.rego", &policy)],
            data_json: "{}".to_owned(),
            provenance: ProvenanceMap::default(),
        }),
        Err(EngineError::IncompatibleBundle {
            field: "engine_version",
            ..
        })
    ));
    assert!(matches!(
        CanonicalJson::parse("{ \"a\": 1 }"),
        Err(EngineError::NonCanonicalJson)
    ));
    assert!(matches!(
        load(vec![module(
            "other.rego",
            "package other\nimport rego.v1\ndecision := true\n"
        )]),
        Err(EngineError::MissingPackage)
    ));

    let provenance = ProvenanceMap {
        entries: vec![ProvenanceEntry {
            module_id: "missing.rego".to_owned(),
            rule_id: "allow".to_owned(),
            source_id: "test".to_owned(),
            start_line: 1,
            end_line: 1,
        }],
    };
    assert!(matches!(
        LoadedSourceBundle::load(SourceBundle {
            compatibility: BundleCompatibility::current(),
            modules: vec![module("authz.rego", &policy)],
            data_json: "{}".to_owned(),
            provenance,
        }),
        Err(EngineError::Provenance(_))
    ));
}

#[test]
fn explain_is_bounded_redacted_and_does_not_claim_semantic_events() {
    let policy = format!("package valet.authz\nimport rego.v1\ndecision := {DECISION}\n");
    let loaded = load(vec![module("authz.rego", &policy)]).unwrap();
    let input = CanonicalJson::parse("{}").unwrap();
    let result = evaluate_bundle(
        &loaded,
        &input,
        EvaluationOptions {
            max_work_units: None,
            explain: ExplainMode::Summary,
        },
    )
    .unwrap();
    let explain = result.explain.unwrap();
    assert!(explain.redacted);
    assert!(!explain.detailed_trace_supported);
    assert_eq!(explain.module_ids, ["authz.rego"]);
    assert!(matches!(
        evaluate_bundle(
            &loaded,
            &input,
            EvaluationOptions {
                max_work_units: None,
                explain: ExplainMode::Detailed
            }
        ),
        Err(EngineError::DetailedExplainUnsupported)
    ));
}

#[derive(Deserialize)]
struct CorpusManifest {
    schema_version: u32,
    license: String,
    cases: Vec<CorpusCase>,
}

#[derive(Deserialize)]
struct CorpusCase {
    id: String,
    feature: String,
    policy: String,
    origin: String,
    license: String,
    input: String,
    data: String,
    max_work_units: Option<u64>,
    expected_parse: String,
    required: bool,
    expected: CorpusExpected,
}

#[derive(Deserialize)]
struct CorpusExpected {
    kind: String,
    effect: Option<String>,
    error: Option<String>,
}

#[test]
fn licensed_versioned_corpus_matches_declared_results() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus");
    let manifest: CorpusManifest = serde_json::from_str(include_str!("../corpus/manifest-v1.json"))
        .expect("corpus manifest must parse");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.license, "MIT");
    assert!(root.join("LICENSE.md").is_file());

    for case in manifest.cases {
        assert_eq!(case.origin, "Valet", "{} origin", case.id);
        assert_eq!(case.license, "MIT", "{} license", case.id);
        assert!(!case.feature.is_empty(), "{} feature", case.id);
        assert!(case.required, "{} must be required", case.id);
        let source = std::fs::read_to_string(root.join(case.policy)).unwrap();
        let parse_result = regorus::Engine::new().add_policy(case.id.clone(), source.clone());
        assert_eq!(
            parse_result.is_ok(),
            case.expected_parse == "accept",
            "{} parse status",
            case.id
        );
        let loaded = LoadedSourceBundle::load(SourceBundle {
            compatibility: BundleCompatibility::current(),
            modules: vec![module(&format!("{}.rego", case.id), &source)],
            data_json: case.data,
            provenance: ProvenanceMap::default(),
        });
        let result = loaded.and_then(|bundle| {
            let input = CanonicalJson::parse(&case.input)?;
            evaluate_bundle(
                &bundle,
                &input,
                EvaluationOptions {
                    max_work_units: case.max_work_units,
                    explain: ExplainMode::Off,
                },
            )
        });
        match (case.expected.kind.as_str(), result) {
            ("decision", Ok(result)) => assert_eq!(
                result.decision.effect,
                match case.expected.effect.as_deref() {
                    Some("allow") => AuthorizationEffect::Allow,
                    Some("deny") => AuthorizationEffect::Deny,
                    other => panic!("unexpected effect {other:?}"),
                },
                "{} effect",
                case.id
            ),
            ("error", Err(error)) => {
                let expected = case.expected.error.as_deref().unwrap();
                let matches = matches!(
                    (expected, &error),
                    ("decision_contract", EngineError::DecisionContract(_))
                        | ("policy", EngineError::Policy { .. })
                        | ("rejected_builtin", EngineError::RejectedBuiltin(_))
                        | ("evaluation_budget", EngineError::EvaluationBudget { .. })
                );
                assert!(matches, "{} expected {expected}, got {error:?}", case.id);
            }
            (kind, result) => panic!("{} expected {kind}, got {result:?}", case.id),
        }
    }
}
