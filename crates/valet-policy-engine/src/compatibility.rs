use crate::limits::CapabilityLimits;
use crate::EngineError;
use regorus::EVALUATION_ACCOUNTING_VERSION;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const CAPABILITY_PROFILE_JSON: &str = include_str!("../capabilities/profile-v1.json");

pub const ENGINE_NAME: &str = "valet-policy-engine";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ENGINE_CONTRACT_VERSION: u32 = 1;
pub const CAPABILITY_PROFILE_VERSION: u32 = 1;
pub const REGORUS_VERSION: &str = "0.12.0";
pub const REGORUS_REPOSITORY: &str = "https://github.com/tkhq/regorus";
pub const REGORUS_REVISION: &str = "309ba35067d2118aafd696198a33037f5af9e1bd";
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
    pub substrate_repository: &'static str,
    pub substrate_revision: &'static str,
    pub accounting_version: u32,
    pub semantic_path: &'static str,
}

pub const ENGINE_IDENTITY: EngineIdentity = EngineIdentity {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    contract_version: ENGINE_CONTRACT_VERSION,
    capability_profile_version: CAPABILITY_PROFILE_VERSION,
    rego_version: REGO_VERSION,
    substrate_name: "regorus",
    substrate_version: REGORUS_VERSION,
    substrate_repository: REGORUS_REPOSITORY,
    substrate_revision: REGORUS_REVISION,
    accounting_version: EVALUATION_ACCOUNTING_VERSION,
    semantic_path: "interpreter",
};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct CapabilityProfile {
    pub schema_version: u32,
    pub profile_id: String,
    pub rego_version: String,
    pub contract_version: u32,
    pub engine_version: String,
    pub substrate: SubstrateIdentity,
    pub semantic_path: String,
    pub compatibility_status: CompatibilityStatus,
    pub full_rego_v1_compatible: bool,
    pub default_host_capabilities: Vec<String>,
    pub enabled_features: Vec<String>,
    pub inventory_source: String,
    pub inventory_builtin_count: usize,
    pub enabled_builtin_count: usize,
    pub limits: CapabilityLimits,
    pub targets: Vec<TargetCapability>,
    pub ambient_capabilities: Vec<AmbientCapability>,
    pub language_features: Vec<LanguageFeature>,
    pub known_gaps: Vec<KnownGap>,
    pub conformance: ConformanceEvidence,
    pub builtins: Vec<BuiltinCapability>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct SubstrateIdentity {
    pub name: String,
    pub version: String,
    pub repository: String,
    pub revision: String,
    pub evaluation_accounting_version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityStatus {
    PartialInterpreter,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct TargetCapability {
    pub target: String,
    pub status: String,
    pub evidence: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct AmbientCapability {
    pub name: String,
    pub class: BuiltinClass,
    pub status: BuiltinStatus,
    pub replacement: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct LanguageFeature {
    pub name: String,
    pub status: String,
    pub evidence: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct KnownGap {
    pub id: String,
    pub area: String,
    pub description: String,
    pub enforcement: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ConformanceEvidence {
    pub corpus_manifest: String,
    pub corpus_version: u32,
    pub license: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct BuiltinCapability {
    pub name: String,
    pub class: BuiltinClass,
    pub status: BuiltinStatus,
    pub enabled: bool,
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

pub fn capability_profile() -> Result<CapabilityProfile, EngineError> {
    let profile: CapabilityProfile = serde_json::from_str(CAPABILITY_PROFILE_JSON)
        .map_err(|error| EngineError::CapabilityProfile(error.to_string()))?;
    validate_profile_identity(&profile)?;
    Ok(profile)
}

fn validate_profile_identity(profile: &CapabilityProfile) -> Result<(), EngineError> {
    let checks = [
        ("rego_version", REGO_VERSION, profile.rego_version.as_str()),
        (
            "engine_version",
            ENGINE_VERSION,
            profile.engine_version.as_str(),
        ),
        (
            "substrate.version",
            REGORUS_VERSION,
            profile.substrate.version.as_str(),
        ),
        (
            "substrate.repository",
            REGORUS_REPOSITORY,
            profile.substrate.repository.as_str(),
        ),
        (
            "substrate.revision",
            REGORUS_REVISION,
            profile.substrate.revision.as_str(),
        ),
        (
            "semantic_path",
            "interpreter",
            profile.semantic_path.as_str(),
        ),
    ];
    for (field, expected, actual) in checks {
        if expected != actual {
            return Err(EngineError::IncompatibleBundle {
                field,
                expected: expected.to_owned(),
                actual: actual.to_owned(),
            });
        }
    }
    if profile.contract_version != ENGINE_CONTRACT_VERSION
        || profile.substrate.evaluation_accounting_version != EVALUATION_ACCOUNTING_VERSION
    {
        return Err(EngineError::CapabilityProfile(
            "contract or evaluation accounting version does not match the engine".to_owned(),
        ));
    }
    let names: BTreeSet<_> = profile
        .builtins
        .iter()
        .map(|builtin| builtin.name.as_str())
        .collect();
    let enabled: BTreeSet<_> = profile
        .builtins
        .iter()
        .filter(|builtin| builtin.enabled)
        .map(|builtin| builtin.name.as_str())
        .collect();
    let substrate: BTreeSet<_> = regorus::unstable::BUILTINS.keys().copied().collect();
    if names.len() != profile.inventory_builtin_count
        || names.len() != profile.builtins.len()
        || enabled.len() != profile.enabled_builtin_count
        || enabled != substrate
    {
        return Err(EngineError::CapabilityProfile(
            "built-in inventory counts or enabled registry do not match the pinned substrate"
                .to_owned(),
        ));
    }
    Ok(())
}
