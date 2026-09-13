use crate::compatibility::capability_profile;
use crate::contract::PolicyDecisionV1;
use crate::explain::{build_summary, ExplainMode, ExplainSummary};
use crate::limits::{validate_json_shape, value_count, EnforcedLimits};
use crate::source_bundle::{CanonicalJson, LoadedSourceBundle, REQUIRED_ENTRYPOINT};
use crate::EngineError;
use regorus::{
    Engine as RegorusEngine, EvaluationBudgetConfig, EvaluationBudgetError, Value as RegorusValue,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EvaluationOptions {
    pub max_work_units: Option<u64>,
    pub explain: ExplainMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EvaluationResult {
    pub decision: PolicyDecisionV1,
    pub usage: EvaluationUsage,
    pub explain: Option<ExplainSummary>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct EvaluationUsage {
    pub work_units: u64,
}

pub fn evaluate_bundle(
    bundle: &LoadedSourceBundle,
    input: &CanonicalJson,
    options: EvaluationOptions,
) -> Result<EvaluationResult, EngineError> {
    let profile = capability_profile()?;
    let limits = &profile.limits.enforced;
    if input.as_str().len() > limits.max_input_bytes {
        return Err(EngineError::InputLimit {
            actual: input.as_str().len(),
            limit: limits.max_input_bytes,
        });
    }
    validate_json_shape(input.value(), limits)?;
    if options.explain == ExplainMode::Detailed {
        return Err(EngineError::DetailedExplainUnsupported);
    }

    let mut engine = RegorusEngine::new();
    let work_limit = options
        .max_work_units
        .unwrap_or(limits.max_evaluation_work_units)
        .min(limits.max_evaluation_work_units);
    engine.set_evaluation_budget_config(EvaluationBudgetConfig { limit: work_limit });
    for module in bundle.modules() {
        engine
            .add_policy(module.id.clone(), module.source.clone())
            .map_err(|error| EngineError::Policy {
                module_id: module.id.clone(),
                message: error.to_string(),
            })?;
    }
    engine
        .add_data_json(bundle.data().as_str())
        .map_err(|error| EngineError::PolicyData(error.to_string()))?;
    engine
        .set_input_json(input.as_str())
        .map_err(|error| EngineError::Input(error.to_string()))?;
    let value = engine
        .eval_rule(REQUIRED_ENTRYPOINT.to_owned())
        .map_err(|error| map_evaluation_error(&error))?;
    let usage = EvaluationUsage {
        work_units: engine.evaluation_metrics().consumed,
    };
    let decision = decision_from_regorus(value, limits)?;
    let explain = match options.explain {
        ExplainMode::Off => None,
        ExplainMode::Summary => Some(build_summary(
            bundle,
            decision.effect.clone(),
            limits.max_explain_events,
        )?),
        ExplainMode::Detailed => return Err(EngineError::DetailedExplainUnsupported),
    };
    Ok(EvaluationResult {
        decision,
        usage,
        explain,
    })
}

fn map_evaluation_error(error: &anyhow::Error) -> EngineError {
    if let Some(budget) = error.downcast_ref::<EvaluationBudgetError>() {
        EngineError::EvaluationBudget {
            consumed: budget.consumed,
            limit: budget.limit,
        }
    } else {
        EngineError::Evaluation(error.to_string())
    }
}

fn decision_from_regorus(
    value: RegorusValue,
    limits: &EnforcedLimits,
) -> Result<PolicyDecisionV1, EngineError> {
    let json = value
        .to_json_str()
        .map_err(|error| EngineError::DecisionContract(error.to_string()))?;
    if json.len() > limits.max_decision_output_bytes {
        return Err(EngineError::DecisionLimit {
            actual: json.len(),
            limit: limits.max_decision_output_bytes,
        });
    }
    let value: serde_json::Value = serde_json::from_str(&json)
        .map_err(|error| EngineError::DecisionContract(error.to_string()))?;
    let values = value_count(&value, limits.max_decision_values);
    if values > limits.max_decision_values {
        return Err(EngineError::DecisionValueLimit {
            actual: values,
            limit: limits.max_decision_values,
        });
    }
    serde_json::from_value(value).map_err(|error| EngineError::DecisionContract(error.to_string()))
}
