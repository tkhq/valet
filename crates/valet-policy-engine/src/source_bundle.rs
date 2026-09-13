use crate::compatibility::{
    capability_profile, CAPABILITY_PROFILE_VERSION, ENGINE_CONTRACT_VERSION, ENGINE_VERSION,
    REGO_VERSION,
};
use crate::limits::validate_json_shape;
use crate::provenance::ProvenanceMap;
use crate::syntax::{analyze, validate_calls};
use crate::EngineError;
use regorus::Engine as RegorusEngine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;

pub const REQUIRED_PACKAGE: &str = "valet.authz";
pub const REQUIRED_ENTRYPOINT: &str = "data.valet.authz.decision";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BundleCompatibility {
    pub rego_version: String,
    pub capability_profile_version: u32,
    pub contract_version: u32,
    pub engine_version: String,
}

impl BundleCompatibility {
    pub fn current() -> Self {
        Self {
            rego_version: REGO_VERSION.to_owned(),
            capability_profile_version: CAPABILITY_PROFILE_VERSION,
            contract_version: ENGINE_CONTRACT_VERSION,
            engine_version: ENGINE_VERSION.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMetadata {
    pub origin: String,
    pub license: String,
    pub revision: Option<String>,
}

impl SourceMetadata {
    pub fn valet_generated() -> Self {
        Self {
            origin: "valet".to_owned(),
            license: "MIT".to_owned(),
            revision: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceModule {
    pub id: String,
    pub source: String,
    pub metadata: SourceMetadata,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBundle {
    pub compatibility: BundleCompatibility,
    pub modules: Vec<SourceModule>,
    pub data_json: String,
    pub provenance: ProvenanceMap,
}

#[derive(Clone, Debug)]
pub struct LoadedSourceBundle(Arc<LoadedSourceBundleInner>);

#[derive(Debug)]
struct LoadedSourceBundleInner {
    compatibility: BundleCompatibility,
    modules: Vec<SourceModule>,
    data: CanonicalJson,
    provenance: ProvenanceMap,
    module_ids: Vec<String>,
}

impl LoadedSourceBundle {
    pub fn load(bundle: SourceBundle) -> Result<Self, EngineError> {
        let profile = capability_profile()?;
        validate_compatibility(&bundle.compatibility)?;
        let limits = &profile.limits.enforced;
        if bundle.modules.is_empty() {
            return Err(EngineError::MissingModules);
        }
        if bundle.modules.len() > limits.max_modules {
            return Err(EngineError::ModuleCountLimit {
                actual: bundle.modules.len(),
                limit: limits.max_modules,
            });
        }
        let source_bytes = bundle.modules.iter().fold(0_usize, |total, module| {
            total.saturating_add(module.source.len())
        });
        if source_bytes > limits.max_rego_source_bytes {
            return Err(EngineError::PolicySourceLimit {
                actual: source_bytes,
                limit: limits.max_rego_source_bytes,
            });
        }
        let bundle_bytes = bundle
            .modules
            .iter()
            .fold(
                bundle
                    .data_json
                    .len()
                    .saturating_add(bundle.compatibility.rego_version.len())
                    .saturating_add(bundle.compatibility.engine_version.len()),
                |total, module| {
                    total
                        .saturating_add(module.id.len())
                        .saturating_add(module.source.len())
                        .saturating_add(module.metadata.origin.len())
                        .saturating_add(module.metadata.license.len())
                        .saturating_add(module.metadata.revision.as_deref().map_or(0, str::len))
                },
            )
            .saturating_add(
                serde_json::to_vec(&bundle.provenance)
                    .map_err(|error| EngineError::Provenance(error.to_string()))?
                    .len(),
            );
        if bundle_bytes > limits.max_source_bundle_bytes {
            return Err(EngineError::SourceBundleLimit {
                actual: bundle_bytes,
                limit: limits.max_source_bundle_bytes,
            });
        }

        let mut ids = BTreeSet::new();
        let mut analyses = Vec::with_capacity(bundle.modules.len());
        let mut has_package = false;
        let mut has_entrypoint = false;
        let mut parser = RegorusEngine::new();
        for module in &bundle.modules {
            validate_module_id(&module.id)?;
            if !ids.insert(module.id.clone()) {
                return Err(EngineError::DuplicateModuleId(module.id.clone()));
            }
            let analysis = analyze(&module.source, limits)?;
            if analysis.package.as_deref() == Some(REQUIRED_PACKAGE) {
                has_package = true;
                has_entrypoint |= analysis.has_decision_rule;
            }
            parser
                .add_policy(module.id.clone(), module.source.clone())
                .map_err(|error| EngineError::Policy {
                    module_id: module.id.clone(),
                    message: error.to_string(),
                })?;
            analyses.push(analysis);
        }
        if !has_package {
            return Err(EngineError::MissingPackage);
        }
        if !has_entrypoint {
            return Err(EngineError::MissingEntrypoint);
        }
        validate_calls(&analyses, &profile)?;
        if bundle.data_json.len() > limits.max_policy_data_bytes {
            return Err(EngineError::PolicyDataLimit {
                actual: bundle.data_json.len(),
                limit: limits.max_policy_data_bytes,
            });
        }
        let data =
            CanonicalJson::parse_with_limit(&bundle.data_json, limits.max_policy_data_bytes)?;
        validate_json_shape(data.value(), limits)?;
        parser
            .add_data_json(data.as_str())
            .map_err(|error| EngineError::PolicyData(error.to_string()))?;
        bundle.provenance.validate(&bundle.modules)?;
        let module_ids = ids.into_iter().collect();
        Ok(Self(Arc::new(LoadedSourceBundleInner {
            compatibility: bundle.compatibility,
            modules: bundle.modules,
            data,
            provenance: bundle.provenance,
            module_ids,
        })))
    }

    pub fn compatibility(&self) -> &BundleCompatibility {
        &self.0.compatibility
    }

    pub fn modules(&self) -> &[SourceModule] {
        &self.0.modules
    }

    pub fn data(&self) -> &CanonicalJson {
        &self.0.data
    }

    pub fn provenance(&self) -> &ProvenanceMap {
        &self.0.provenance
    }

    pub fn module_ids(&self) -> &[String] {
        &self.0.module_ids
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalJson {
    bytes: String,
    value: Value,
}

impl CanonicalJson {
    pub fn parse(input: &str) -> Result<Self, EngineError> {
        Self::parse_with_limit(input, usize::MAX)
    }

    pub(crate) fn parse_with_limit(input: &str, limit: usize) -> Result<Self, EngineError> {
        if input.len() > limit {
            return Err(EngineError::InputLimit {
                actual: input.len(),
                limit,
            });
        }
        let value: Value = serde_json::from_str(input)
            .map_err(|error| EngineError::InvalidJson(error.to_string()))?;
        let canonical = serde_jcs::to_string(&value)
            .map_err(|error| EngineError::InvalidJson(error.to_string()))?;
        if canonical != input {
            return Err(EngineError::NonCanonicalJson);
        }
        Ok(Self {
            bytes: input.to_owned(),
            value,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.bytes
    }

    pub(crate) const fn value(&self) -> &Value {
        &self.value
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluationRequest<'a> {
    pub module_id: &'a str,
    pub policy_source: &'a str,
    pub policy_data_json: &'a str,
    pub input_json: &'a str,
    pub entrypoint: &'a str,
    pub max_evaluation_work_units: Option<u64>,
}

fn validate_compatibility(compatibility: &BundleCompatibility) -> Result<(), EngineError> {
    let current = BundleCompatibility::current();
    check(
        "rego_version",
        &current.rego_version,
        &compatibility.rego_version,
    )?;
    check(
        "engine_version",
        &current.engine_version,
        &compatibility.engine_version,
    )?;
    if compatibility.capability_profile_version != current.capability_profile_version {
        return Err(EngineError::IncompatibleBundle {
            field: "capability_profile_version",
            expected: current.capability_profile_version.to_string(),
            actual: compatibility.capability_profile_version.to_string(),
        });
    }
    if compatibility.contract_version != current.contract_version {
        return Err(EngineError::IncompatibleBundle {
            field: "contract_version",
            expected: current.contract_version.to_string(),
            actual: compatibility.contract_version.to_string(),
        });
    }
    Ok(())
}

fn check(field: &'static str, expected: &str, actual: &str) -> Result<(), EngineError> {
    if expected == actual {
        Ok(())
    } else {
        Err(EngineError::IncompatibleBundle {
            field,
            expected: expected.to_owned(),
            actual: actual.to_owned(),
        })
    }
}

fn validate_module_id(id: &str) -> Result<(), EngineError> {
    let valid = !id.is_empty()
        && id.len() <= 255
        && !id.starts_with('/')
        && !id.contains("..")
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(EngineError::InvalidModuleId(id.to_owned()))
    }
}
