#![forbid(unsafe_code)]

pub mod compatibility;
pub mod contract;
pub mod explain;
pub mod host;
mod interpreter;
pub mod limits;
pub mod provenance;
pub mod source_bundle;
mod syntax;

pub use compatibility::{
    capability_profile, BuiltinCapability, BuiltinClass, BuiltinStatus, CapabilityProfile,
    CompatibilityStatus, EngineIdentity, CAPABILITY_PROFILE_VERSION, ENGINE_CONTRACT_VERSION,
    ENGINE_IDENTITY, ENGINE_NAME, ENGINE_VERSION, REGORUS_REPOSITORY, REGORUS_REVISION,
    REGORUS_VERSION, REGO_VERSION,
};
pub use contract::{
    ApprovalReplay, ApprovalRequirement, ApproverType, AuthorizationEffect, Obligation,
    PolicyDecisionV1, RedactionDirective, RedactionTarget,
};
pub use explain::{ExplainMode, ExplainSummary};
pub use interpreter::{evaluate_bundle, EvaluationOptions, EvaluationResult, EvaluationUsage};
pub use limits::{CapabilityLimits, DeclaredLimits, EnforcedLimits};
pub use provenance::{ProvenanceEntry, ProvenanceMap};
pub use source_bundle::{
    BundleCompatibility, CanonicalJson, EvaluationRequest, LoadedSourceBundle, SourceBundle,
    SourceMetadata, SourceModule, REQUIRED_ENTRYPOINT, REQUIRED_PACKAGE,
};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("The embedded capability profile is invalid: {0}")]
    CapabilityProfile(String),
    #[error(
        "The bundle compatibility field `{field}` expected `{expected}` but received `{actual}`"
    )]
    IncompatibleBundle {
        field: &'static str,
        expected: String,
        actual: String,
    },
    #[error("The source bundle has no policy modules")]
    MissingModules,
    #[error("The source bundle has {actual} modules, which exceeds the limit of {limit}")]
    ModuleCountLimit { actual: usize, limit: usize },
    #[error("The policy source has {actual} bytes, which exceeds the limit of {limit}")]
    PolicySourceLimit { actual: usize, limit: usize },
    #[error("The source bundle has {actual} bytes, which exceeds the limit of {limit}")]
    SourceBundleLimit { actual: usize, limit: usize },
    #[error("The policy data has {actual} bytes, which exceeds the limit of {limit}")]
    PolicyDataLimit { actual: usize, limit: usize },
    #[error("The policy input has {actual} bytes, which exceeds the limit of {limit}")]
    InputLimit { actual: usize, limit: usize },
    #[error("The policy source structure has {actual} tokens, which exceeds the limit of {limit}")]
    SourceTokenLimit { actual: usize, limit: usize },
    #[error("The policy source nesting depth is {actual}, which exceeds the limit of {limit}")]
    SourceDepthLimit { actual: usize, limit: usize },
    #[error("The document reference depth is {actual}, which exceeds the limit of {limit}")]
    ReferenceDepthLimit { actual: usize, limit: usize },
    #[error("The JSON document depth is {actual}, which exceeds the limit of {limit}")]
    DocumentDepthLimit { actual: usize, limit: usize },
    #[error("The JSON document has {actual} values, which exceeds the limit of {limit}")]
    DocumentValueLimit { actual: usize, limit: usize },
    #[error("The JSON document is invalid: {0}")]
    InvalidJson(String),
    #[error("The JSON document is not RFC 8785 canonical JSON")]
    NonCanonicalJson,
    #[error("The source module ID `{0}` is invalid")]
    InvalidModuleId(String),
    #[error("The source module ID `{0}` occurs more than once")]
    DuplicateModuleId(String),
    #[error("The source bundle must define package `valet.authz`")]
    MissingPackage,
    #[error("The source bundle must define `data.valet.authz.decision`")]
    MissingEntrypoint,
    #[error("The policy declares a function that collides with built-in `{0}`")]
    BuiltinDeclarationCollision(String),
    #[error("The policy uses unsupported bracket callable syntax after `{0}`")]
    UnsupportedCallableSyntax(String),
    #[error("The policy uses rejected built-in `{0}`")]
    RejectedBuiltin(String),
    #[error("The policy uses unavailable built-in `{0}`")]
    UnavailableBuiltin(String),
    #[error("The policy uses undeclared built-in or function `{0}`")]
    UndeclaredBuiltin(String),
    #[error("Regorus rejected policy module `{module_id}`: {message}")]
    Policy { module_id: String, message: String },
    #[error("Regorus rejected the policy data: {0}")]
    PolicyData(String),
    #[error("Regorus rejected the policy input: {0}")]
    Input(String),
    #[error("Regorus could not evaluate the policy: {0}")]
    Evaluation(String),
    #[error(
        "The policy exceeded its deterministic work budget (consumed={consumed}, limit={limit})"
    )]
    EvaluationBudget { consumed: u64, limit: u64 },
    #[error("The decision has {actual} bytes, which exceeds the limit of {limit}")]
    DecisionLimit { actual: usize, limit: usize },
    #[error("The decision has {actual} values, which exceeds the limit of {limit}")]
    DecisionValueLimit { actual: usize, limit: usize },
    #[error("The policy returned an invalid PolicyDecisionV1: {0}")]
    DecisionContract(String),
    #[error("Detailed explain traces are not supported by this compatibility profile")]
    DetailedExplainUnsupported,
    #[error("The explain summary has {actual} events, which exceeds the limit of {limit}")]
    ExplainLimit { actual: usize, limit: usize },
    #[error("The provenance map is invalid: {0}")]
    Provenance(String),
}

/// Compatibility wrapper for the PR 3 single-module boundary.
pub fn evaluate(request: &EvaluationRequest<'_>) -> Result<PolicyDecisionV1, EngineError> {
    if request.entrypoint != REQUIRED_ENTRYPOINT {
        return Err(EngineError::MissingEntrypoint);
    }
    let bundle = SourceBundle {
        compatibility: BundleCompatibility::current(),
        modules: vec![SourceModule {
            id: request.module_id.to_owned(),
            source: request.policy_source.to_owned(),
            metadata: SourceMetadata::valet_generated(),
        }],
        data_json: request.policy_data_json.to_owned(),
        provenance: ProvenanceMap::default(),
    };
    let loaded = LoadedSourceBundle::load(bundle)?;
    let profile = capability_profile()?;
    if request.input_json.len() > profile.limits.enforced.max_input_bytes {
        return Err(EngineError::InputLimit {
            actual: request.input_json.len(),
            limit: profile.limits.enforced.max_input_bytes,
        });
    }
    let input = CanonicalJson::parse(request.input_json)?;
    Ok(evaluate_bundle(
        &loaded,
        &input,
        EvaluationOptions {
            max_work_units: request.max_evaluation_work_units,
            explain: ExplainMode::Off,
        },
    )?
    .decision)
}
