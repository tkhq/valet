use crate::EngineError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct CapabilityLimits {
    pub enforced: EnforcedLimits,
    pub adapter_deferred: AdapterDeferredLimits,
    pub unsupported: DeclaredLimits,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct EnforcedLimits {
    pub max_modules: usize,
    pub max_rego_source_bytes: usize,
    pub max_source_bundle_bytes: usize,
    pub max_source_tokens: usize,
    pub max_source_nesting_depth: usize,
    pub max_reference_depth: usize,
    pub max_policy_data_bytes: usize,
    pub max_input_bytes: usize,
    pub max_document_depth: usize,
    pub max_document_values: usize,
    pub max_evaluation_work_units: u64,
    pub max_decision_output_bytes: usize,
    pub max_decision_values: usize,
    pub max_explain_events: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct AdapterDeferredLimits {
    pub max_wall_time_ms: u64,
    pub max_engine_memory_bytes: u64,
    pub owner: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct DeclaredLimits {
    pub recursion_depth: String,
    pub intermediate_comprehension_values: String,
    pub detailed_trace_events: String,
}

pub(crate) fn validate_json_shape(
    value: &Value,
    limits: &EnforcedLimits,
) -> Result<(), EngineError> {
    let mut stack = vec![(value, 1_usize)];
    let mut values = 0_usize;
    let mut max_depth = 0_usize;
    while let Some((current, depth)) = stack.pop() {
        values = values.saturating_add(1);
        max_depth = max_depth.max(depth);
        if values > limits.max_document_values {
            return Err(EngineError::DocumentValueLimit {
                actual: values,
                limit: limits.max_document_values,
            });
        }
        if max_depth > limits.max_document_depth {
            return Err(EngineError::DocumentDepthLimit {
                actual: max_depth,
                limit: limits.max_document_depth,
            });
        }
        match current {
            Value::Array(items) => stack.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(items) => stack.extend(items.values().map(|item| (item, depth + 1))),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn value_count(value: &Value, stop_after: usize) -> usize {
    let mut stack = vec![value];
    let mut values = 0_usize;
    while let Some(current) = stack.pop() {
        values = values.saturating_add(1);
        if values > stop_after {
            return values;
        }
        match current {
            Value::Array(items) => stack.extend(items),
            Value::Object(items) => stack.extend(items.values()),
            _ => {}
        }
    }
    values
}
