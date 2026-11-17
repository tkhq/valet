use crate::contract::AuthorizationEffect;
use crate::source_bundle::LoadedSourceBundle;
use crate::EngineError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplainMode {
    #[default]
    Off,
    Summary,
    Detailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExplainSummary {
    pub schema_version: u32,
    pub entrypoint: &'static str,
    pub effect: AuthorizationEffect,
    pub module_ids: Vec<String>,
    pub redacted: bool,
    pub detailed_trace_supported: bool,
}

pub(crate) fn build_summary(
    bundle: &LoadedSourceBundle,
    effect: AuthorizationEffect,
    max_events: usize,
) -> Result<ExplainSummary, EngineError> {
    let actual = bundle.module_ids().len().saturating_add(1);
    if actual > max_events {
        return Err(EngineError::ExplainLimit {
            actual,
            limit: max_events,
        });
    }
    Ok(ExplainSummary {
        schema_version: 1,
        entrypoint: crate::source_bundle::REQUIRED_ENTRYPOINT,
        effect,
        module_ids: bundle.module_ids().to_vec(),
        redacted: true,
        detailed_trace_supported: false,
    })
}
