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
decision := {DECISION} if helpers.allowed("user-1")
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
        assert_eq!(case.expected_parse, "accept", "{} parse status", case.id);
        assert!(case.required, "{} must be required", case.id);
        let source = std::fs::read_to_string(root.join(case.policy)).unwrap();
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
                        | ("rejected_builtin", EngineError::RejectedBuiltin(_))
                        | ("evaluation_budget", EngineError::EvaluationBudget { .. })
                );
                assert!(matches, "{} expected {expected}, got {error:?}", case.id);
            }
            (kind, result) => panic!("{} expected {kind}, got {result:?}", case.id),
        }
    }
}
