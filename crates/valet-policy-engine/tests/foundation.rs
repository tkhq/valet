use std::collections::BTreeSet;

use valet_policy_engine::{
    capability_profile, evaluate, AuthorizationEffect, BuiltinClass, BuiltinStatus, EngineError,
    EvaluationRequest, CAPABILITY_PROFILE_VERSION, ENGINE_IDENTITY, REGORUS_REPOSITORY,
    REGORUS_REVISION, REGORUS_VERSION,
};

const POLICY: &str = include_str!("fixtures/decision.rego");
const DATA: &str = include_str!("fixtures/data.json");
const INPUT: &str = include_str!("fixtures/input.json");

fn request(policy_source: &str) -> EvaluationRequest<'_> {
    EvaluationRequest {
        module_id: "foundation.rego",
        policy_source,
        policy_data_json: DATA.trim(),
        input_json: INPUT.trim(),
        entrypoint: "data.valet.authz.decision",
        max_evaluation_work_units: None,
    }
}

#[test]
fn identity_pins_the_foundation_substrate_and_profile() {
    assert_eq!(ENGINE_IDENTITY.name, "valet-policy-engine");
    assert_eq!(ENGINE_IDENTITY.substrate_name, "regorus");
    assert_eq!(ENGINE_IDENTITY.substrate_version, REGORUS_VERSION);
    assert_eq!(ENGINE_IDENTITY.substrate_repository, REGORUS_REPOSITORY);
    assert_eq!(REGORUS_REVISION, "309ba35067d2118aafd696198a33037f5af9e1bd");
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
    assert_eq!(profile.substrate.repository, REGORUS_REPOSITORY);
    assert_eq!(profile.substrate.revision, REGORUS_REVISION);
    assert!(!profile.full_rego_v1_compatible);
    assert!(profile.default_host_capabilities.is_empty());
    assert_eq!(profile.inventory_builtin_count, 164);
    assert_eq!(profile.builtins.len(), profile.inventory_builtin_count);

    let serialized = serde_json::to_value(&profile).expect("profile must serialize");
    let enforced = &serialized["limits"]["enforced"];
    let unsupported = &serialized["limits"]["unsupported"];
    for name in [
        "max_rego_source_bytes",
        "max_policy_data_bytes",
        "max_input_bytes",
        "max_decision_output_bytes",
        "max_evaluation_work_units",
    ] {
        assert!(enforced.get(name).is_some());
        assert!(unsupported.get(name).is_none());
    }
    for name in [
        "recursion_depth",
        "intermediate_comprehension_values",
        "detailed_trace_events",
    ] {
        assert!(unsupported.get(name).is_some());
        assert!(enforced.get(name).is_none());
    }

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
fn low_deterministic_budget_rejects_large_range_through_valet_boundary() {
    let policy = r#"
        package valet.authz
        import rego.v1
        decision := {
          "effect": "deny",
          "reasonCode": "large_range",
          "matchedRuleIds": [],
          "obligations": [],
          "redactions": [],
        } if { count(numbers.range(0, 10000000)) > 0 }
    "#;
    let mut bounded_request = request(policy);
    bounded_request.max_evaluation_work_units = Some(100);

    assert!(matches!(
        evaluate(&bounded_request),
        Err(EngineError::EvaluationBudget { limit: 100, .. })
    ));
}

#[test]
fn rejected_ambient_builtins_fail_before_evaluation() {
    let policy = r#"
        package valet.authz
        import rego.v1
        decision := {"effect": "deny"} if { time.now_ns() > 0 }
    "#;

    assert!(matches!(
        evaluate(&request(policy)),
        Err(EngineError::RejectedBuiltin(name)) if name == "time.now_ns"
    ));
}

#[test]
fn strings_and_comments_do_not_request_host_capabilities() {
    let policy = r#"
        package valet.authz
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
        package valet.authz
        import rego.v1
        decision := {"effect": "allow"}
    "#;

    assert!(matches!(
        evaluate(&request(policy)),
        Err(EngineError::DecisionContract(_))
    ));
}

#[test]
fn enforced_byte_limits_fail_closed() {
    let profile = capability_profile().expect("checked-in profile must be valid");
    let enforced = profile.limits.enforced;

    let oversized_source = " ".repeat(enforced.max_rego_source_bytes + 1);
    assert!(matches!(
        evaluate(&request(&oversized_source)),
        Err(EngineError::PolicySourceLimit { .. })
    ));

    let oversized_data = " ".repeat(enforced.max_policy_data_bytes + 1);
    let mut oversized_data_request = request(POLICY);
    oversized_data_request.policy_data_json = &oversized_data;
    assert!(matches!(
        evaluate(&oversized_data_request),
        Err(EngineError::PolicyDataLimit { .. })
    ));

    let oversized_input = " ".repeat(enforced.max_input_bytes + 1);
    let mut oversized_input_request = request(POLICY);
    oversized_input_request.input_json = &oversized_input;
    assert!(matches!(
        evaluate(&oversized_input_request),
        Err(EngineError::InputLimit { .. })
    ));

    let output_policy = r#"
        package valet.authz
        import rego.v1
        decision := {
          "effect": "deny",
          "reasonCode": data.reason,
          "matchedRuleIds": [],
          "obligations": [],
          "redactions": [],
        }
    "#;
    let large_reason = "x".repeat(enforced.max_decision_output_bytes + 1);
    let output_data = serde_json::to_string(&serde_json::json!({ "reason": large_reason }))
        .expect("output data must serialize");
    let mut output_request = request(output_policy);
    output_request.policy_data_json = &output_data;
    assert!(matches!(
        evaluate(&output_request),
        Err(EngineError::DecisionLimit { .. })
    ));
}

#[test]
fn unknown_decision_fields_fail_the_valet_contract() {
    let top_level = r#"
        package valet.authz
        import rego.v1
        decision := {
          "effect": "allow",
          "reasonCode": "unknown_field",
          "matchedRuleIds": [],
          "obligations": [],
          "redactions": [],
          "unexpected": true,
        }
    "#;
    let nested = r#"
        package valet.authz
        import rego.v1
        decision := {
          "effect": "allow",
          "reasonCode": "unknown_nested_field",
          "matchedRuleIds": [],
          "obligations": [{"type": "approval_tier", "tier": "low", "unexpected": true}],
          "redactions": [],
        }
    "#;

    for policy in [top_level, nested] {
        assert!(matches!(
            evaluate(&request(policy)),
            Err(EngineError::DecisionContract(_))
        ));
    }
}

#[test]
fn target_idempotency_requires_true() {
    let policy = r#"
        package valet.authz
        import rego.v1
        decision := {
          "effect": "allow",
          "reasonCode": "invalid_literal",
          "matchedRuleIds": [],
          "obligations": [{"type": "target_idempotency", "required": false}],
          "redactions": [],
        }
    "#;

    assert!(matches!(
        evaluate(&request(policy)),
        Err(EngineError::DecisionContract(_))
    ));
}
