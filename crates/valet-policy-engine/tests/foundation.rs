use std::collections::BTreeSet;

use valet_policy_engine::{
    capability_profile, evaluate, AuthorizationEffect, BuiltinClass, BuiltinStatus, EngineError,
    EvaluationRequest, CAPABILITY_PROFILE_VERSION, ENGINE_IDENTITY, REGORUS_VERSION,
};

const POLICY: &str = include_str!("fixtures/decision.rego");
const DATA: &str = include_str!("fixtures/data.json");
const INPUT: &str = include_str!("fixtures/input.json");

fn request(policy_source: &str) -> EvaluationRequest<'_> {
    EvaluationRequest {
        module_id: "foundation.rego",
        policy_source,
        policy_data_json: DATA,
        input_json: INPUT,
        entrypoint: "data.valet.foundation.decision",
    }
}

#[test]
fn identity_pins_the_foundation_substrate_and_profile() {
    assert_eq!(ENGINE_IDENTITY.name, "valet-policy-engine");
    assert_eq!(ENGINE_IDENTITY.substrate_name, "regorus");
    assert_eq!(ENGINE_IDENTITY.substrate_version, REGORUS_VERSION);
    assert_eq!(
        ENGINE_IDENTITY.capability_profile_version,
        CAPABILITY_PROFILE_VERSION
    );
    assert_eq!(ENGINE_IDENTITY.rego_version, "v1");
}

#[test]
fn capability_profile_is_explicit_about_current_coverage() {
    let profile = capability_profile().expect("checked-in profile must be valid");
    assert_eq!(profile.substrate.version, REGORUS_VERSION);
    assert!(!profile.full_rego_v1_compatible);
    assert!(profile.default_host_capabilities.is_empty());
    assert_eq!(profile.inventory_builtin_count, 163);
    assert_eq!(profile.builtins.len(), profile.inventory_builtin_count);

    let names: BTreeSet<_> = profile
        .builtins
        .iter()
        .map(|builtin| builtin.name.as_str())
        .collect();
    assert_eq!(names.len(), profile.builtins.len());

    for name in [
        "http.send",
        "opa.runtime",
        "rand.intn",
        "test.sleep",
        "time.now_ns",
        "trace",
        "uuid.rfc4122",
    ] {
        let builtin = profile
            .builtins
            .iter()
            .find(|builtin| builtin.name == name)
            .expect("ambient built-in must be inventoried");
        assert_eq!(builtin.class, BuiltinClass::Rejected);
        assert_eq!(builtin.status, BuiltinStatus::Rejected);
    }
}

#[test]
fn explicit_input_produces_a_typed_deterministic_decision() {
    let first = evaluate(&request(POLICY)).expect("fixture must evaluate");
    let second = evaluate(&request(POLICY)).expect("fixture must evaluate again");

    assert_eq!(first, second);
    assert_eq!(first.effect, AuthorizationEffect::Allow);
    assert_eq!(first.reason_code, "foundation_fixture");
    assert_eq!(first.matched_rule_ids, ["foundation.explicit_input"]);
    assert!(first.obligations.is_empty());
    assert!(first.redactions.is_empty());
}

#[test]
fn rejected_ambient_builtins_fail_before_evaluation() {
    let policy = r#"
        package valet.foundation
        import rego.v1
        decision := {"effect": "deny"} if { time.now_ns() > 0 }
    "#;

    assert!(matches!(
        evaluate(&request(policy)),
        Err(EngineError::UnavailableBuiltin(name)) if name == "time.now_ns"
    ));
}

#[test]
fn strings_and_comments_do_not_request_host_capabilities() {
    let policy = r#"
        package valet.foundation
        import rego.v1
        # time.now_ns() is unavailable.
        decision := {
          "effect": "deny",
          "reasonCode": `http.send() is only text`,
          "matchedRuleIds": [],
          "obligations": [],
          "redactions": [],
        }
    "#;

    let decision = evaluate(&request(policy)).expect("text must not activate a built-in");
    assert_eq!(decision.effect, AuthorizationEffect::Deny);
}

#[test]
fn invalid_decision_output_fails_the_valet_contract() {
    let policy = r#"
        package valet.foundation
        import rego.v1
        decision := {"effect": "allow"}
    "#;

    assert!(matches!(
        evaluate(&request(policy)),
        Err(EngineError::DecisionContract(_))
    ));
}
