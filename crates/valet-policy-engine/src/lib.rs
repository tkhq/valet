#![forbid(unsafe_code)]

use regorus::{Engine as RegorusEngine, Value as RegorusValue};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use thiserror::Error;

const CAPABILITY_PROFILE_JSON: &str = include_str!("../capabilities/profile-v1.json");

pub const ENGINE_NAME: &str = "valet-policy-engine";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ENGINE_CONTRACT_VERSION: u32 = 1;
pub const CAPABILITY_PROFILE_VERSION: u32 = 1;
pub const REGORUS_VERSION: &str = "0.12.0";
pub const REGO_VERSION: &str = "v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EngineIdentity {
    pub name: &'static str,
    pub version: &'static str,
    pub contract_version: u32,
    pub capability_profile_version: u32,
    pub rego_version: &'static str,
    pub substrate_name: &'static str,
    pub substrate_version: &'static str,
}

pub const ENGINE_IDENTITY: EngineIdentity = EngineIdentity {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    contract_version: ENGINE_CONTRACT_VERSION,
    capability_profile_version: CAPABILITY_PROFILE_VERSION,
    rego_version: REGO_VERSION,
    substrate_name: "regorus",
    substrate_version: REGORUS_VERSION,
};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct CapabilityProfile {
    pub schema_version: u32,
    pub profile_id: String,
    pub rego_version: String,
    pub substrate: SubstrateIdentity,
    pub compatibility_status: CompatibilityStatus,
    pub full_rego_v1_compatible: bool,
    pub default_host_capabilities: Vec<String>,
    pub inventory_source: String,
    pub inventory_builtin_count: usize,
    pub limits: CapabilityLimits,
    pub builtins: Vec<BuiltinCapability>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct SubstrateIdentity {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityStatus {
    FoundationOnly,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct CapabilityLimits {
    pub enforced: EnforcedLimits,
    pub declared_v2: DeclaredV2Limits,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct EnforcedLimits {
    pub max_rego_source_bytes: usize,
    pub max_policy_data_bytes: usize,
    pub max_input_bytes: usize,
    pub max_decision_output_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct DeclaredV2Limits {
    pub max_modules: usize,
    pub max_parsed_nodes: usize,
    pub max_compiled_policy_bytes: usize,
    pub max_evaluation_instructions: usize,
    pub max_document_depth: usize,
    pub max_comprehension_values: usize,
    pub max_explain_events: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct BuiltinCapability {
    pub name: String,
    pub class: BuiltinClass,
    pub status: BuiltinStatus,
    pub evidence: String,
    pub known_gap: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinClass {
    Pure,
    FactBacked,
    Injected,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinStatus {
    Verified,
    AvailableUnverified,
    Disabled,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluationRequest<'a> {
    pub module_id: &'a str,
    pub policy_source: &'a str,
    pub policy_data_json: &'a str,
    pub input_json: &'a str,
    pub entrypoint: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationEffect {
    Allow,
    Deny,
    RequireApproval,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "snake_case")]
pub enum Obligation {
    ApprovalTier {
        tier: String,
    },
    CredentialOwner {
        #[serde(rename = "ownerType")]
        owner_type: String,
        #[serde(rename = "ownerId")]
        owner_id: String,
    },
    EgressHosts {
        hosts: Vec<String>,
    },
    SandboxCapabilities {
        capabilities: Vec<String>,
    },
    TargetIdempotency {
        #[serde(deserialize_with = "deserialize_required_true")]
        required: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionTarget {
    Audit,
    Explanation,
    UserOutput,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RedactionDirective {
    pub target: RedactionTarget,
    #[serde(rename = "jsonPaths")]
    pub json_paths: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApproverType {
    User,
    Team,
    Org,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalReplay {
    Once,
    Session,
    Workflow,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRequirement {
    pub tier: String,
    #[serde(rename = "approverType")]
    pub approver_type: ApproverType,
    #[serde(rename = "approverId")]
    pub approver_id: Option<String>,
    pub replay: ApprovalReplay,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyDecisionV1 {
    pub effect: AuthorizationEffect,
    #[serde(rename = "reasonCode")]
    pub reason_code: String,
    #[serde(rename = "matchedRuleIds")]
    pub matched_rule_ids: Vec<String>,
    pub obligations: Vec<Obligation>,
    pub redactions: Vec<RedactionDirective>,
    #[serde(rename = "approvalRequirement")]
    pub approval_requirement: Option<ApprovalRequirement>,
}

fn deserialize_required_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let required = bool::deserialize(deserializer)?;
    if required {
        Ok(true)
    } else {
        Err(serde::de::Error::custom(
            "target_idempotency.required must be true",
        ))
    }
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("The embedded capability profile is invalid: {0}")]
    CapabilityProfile(String),
    #[error("The policy source exceeds the capability profile limit")]
    PolicySourceLimit,
    #[error("The policy data exceeds the capability profile limit")]
    PolicyDataLimit,
    #[error("The policy input exceeds the capability profile limit")]
    InputLimit,
    #[error("The entrypoint must be a data document path")]
    InvalidEntrypoint,
    #[error("The policy uses unavailable built-in `{0}`")]
    UnavailableBuiltin(String),
    #[error("Regorus rejected the policy module: {0}")]
    Policy(String),
    #[error("Regorus rejected the policy data: {0}")]
    PolicyData(String),
    #[error("Regorus rejected the policy input: {0}")]
    Input(String),
    #[error("Regorus could not evaluate the policy: {0}")]
    Evaluation(String),
    #[error("The decision exceeds the capability profile limit")]
    DecisionLimit,
    #[error("The policy returned an invalid PolicyDecisionV1: {0}")]
    DecisionContract(String),
}

pub fn capability_profile() -> Result<CapabilityProfile, EngineError> {
    serde_json::from_str(CAPABILITY_PROFILE_JSON)
        .map_err(|error| EngineError::CapabilityProfile(error.to_string()))
}

pub fn evaluate(request: &EvaluationRequest<'_>) -> Result<PolicyDecisionV1, EngineError> {
    let profile = capability_profile()?;
    enforce_limits(request, &profile.limits.enforced)?;
    validate_entrypoint(request.entrypoint)?;
    validate_source_capabilities(request.policy_source, &profile)?;

    let mut engine = RegorusEngine::new();
    engine
        .add_policy(
            request.module_id.to_owned(),
            request.policy_source.to_owned(),
        )
        .map_err(|error| EngineError::Policy(error.to_string()))?;
    engine
        .add_data_json(request.policy_data_json)
        .map_err(|error| EngineError::PolicyData(error.to_string()))?;
    engine
        .set_input_json(request.input_json)
        .map_err(|error| EngineError::Input(error.to_string()))?;

    let value = engine
        .eval_rule(request.entrypoint.to_owned())
        .map_err(|error| EngineError::Evaluation(error.to_string()))?;
    decision_from_regorus(value, &profile.limits.enforced)
}

fn enforce_limits(
    request: &EvaluationRequest<'_>,
    limits: &EnforcedLimits,
) -> Result<(), EngineError> {
    if request.policy_source.len() > limits.max_rego_source_bytes {
        return Err(EngineError::PolicySourceLimit);
    }
    if request.policy_data_json.len() > limits.max_policy_data_bytes {
        return Err(EngineError::PolicyDataLimit);
    }
    if request.input_json.len() > limits.max_input_bytes {
        return Err(EngineError::InputLimit);
    }
    Ok(())
}

fn validate_entrypoint(entrypoint: &str) -> Result<(), EngineError> {
    let valid = entrypoint
        .strip_prefix("data.")
        .is_some_and(|path| !path.is_empty() && path.split('.').all(valid_identifier));
    if valid {
        Ok(())
    } else {
        Err(EngineError::InvalidEntrypoint)
    }
}

fn valid_identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn validate_source_capabilities(
    policy_source: &str,
    profile: &CapabilityProfile,
) -> Result<(), EngineError> {
    let unavailable: BTreeSet<&str> = profile
        .builtins
        .iter()
        .filter(|builtin| {
            matches!(
                builtin.status,
                BuiltinStatus::Disabled | BuiltinStatus::Rejected
            )
        })
        .map(|builtin| builtin.name.as_str())
        .collect();

    for call in called_functions(policy_source) {
        if unavailable.contains(call.as_str()) {
            return Err(EngineError::UnavailableBuiltin(call));
        }
    }
    Ok(())
}

fn called_functions(source: &str) -> BTreeSet<String> {
    let characters: Vec<char> = source.chars().collect();
    let mut calls = BTreeSet::new();
    let mut index = 0;

    while index < characters.len() {
        match characters[index] {
            '#' => {
                while index < characters.len() && characters[index] != '\n' {
                    index += 1;
                }
            }
            '"' => {
                index += 1;
                while index < characters.len() {
                    match characters[index] {
                        '\\' => index += 2,
                        '"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            '`' => {
                index += 1;
                while index < characters.len() && characters[index] != '`' {
                    index += 1;
                }
                index += usize::from(index < characters.len());
            }
            character if character == '_' || character.is_ascii_alphabetic() => {
                let start = index;
                index += 1;
                while index < characters.len()
                    && (characters[index] == '_'
                        || characters[index] == '.'
                        || characters[index].is_ascii_alphanumeric())
                {
                    index += 1;
                }
                let end = index;
                loop {
                    while index < characters.len() && characters[index].is_ascii_whitespace() {
                        index += 1;
                    }
                    if index >= characters.len() || characters[index] != '#' {
                        break;
                    }
                    while index < characters.len() && characters[index] != '\n' {
                        index += 1;
                    }
                }
                if index < characters.len() && characters[index] == '(' {
                    calls.insert(characters[start..end].iter().collect());
                }
            }
            _ => index += 1,
        }
    }
    calls
}

fn decision_from_regorus(
    value: RegorusValue,
    limits: &EnforcedLimits,
) -> Result<PolicyDecisionV1, EngineError> {
    let json = value
        .to_json_str()
        .map_err(|error| EngineError::DecisionContract(error.to_string()))?;
    if json.len() > limits.max_decision_output_bytes {
        return Err(EngineError::DecisionLimit);
    }
    serde_json::from_str(&json).map_err(|error| EngineError::DecisionContract(error.to_string()))
}
