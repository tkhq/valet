#![forbid(unsafe_code)]

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use valet_policy_engine::{
    evaluate_bundle, CanonicalJson, CanonicalSourceBundle, EvaluationOptions, ExplainMode,
    SourceBundleFile, ENGINE_IDENTITY,
};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFile {
    path: String,
    content_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireBundle {
    manifest_json: String,
    files: Vec<WireFile>,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    ValidateBundle {
        bundle: WireBundle,
    },
    Evaluate {
        bundle: WireBundle,
        input: serde_json::Value,
        max_work_units: Option<u64>,
        explain: ExplainMode,
    },
    Identity,
    VerifyMemoryContainment,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleIdentity {
    source_bundle_digest: String,
    policy_digest: String,
    engine_digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvaluationResponse {
    source_bundle_digest: String,
    policy_digest: String,
    engine_digest: String,
    input_digest: String,
    decision_digest: String,
    decision: valet_policy_engine::PolicyDecisionV1,
    usage: valet_policy_engine::EvaluationUsage,
    explain: Option<valet_policy_engine::ExplainSummary>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Response<T: Serialize> {
    Ok { value: T },
    Error { code: &'static str, message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityResponse {
    engine_digest: String,
    target: &'static str,
    max_wall_time_ms: u64,
    max_engine_memory_bytes: u64,
}

#[wasm_bindgen]
pub fn run(command_json: &str) -> String {
    let response = match execute(command_json) {
        Ok(value) => value,
        Err((code, message)) => {
            serde_json::to_string(&Response::<serde_json::Value>::Error { code, message })
        }
    };
    response.unwrap_or_else(|_| {
        r#"{"status":"error","code":"boundary_serialization","message":"The WebAssembly boundary could not serialize its response"}"#.to_owned()
    })
}

fn execute(
    command_json: &str,
) -> Result<Result<String, serde_json::Error>, (&'static str, String)> {
    let command: Command = serde_json::from_str(command_json)
        .map_err(|error| ("malformed_request", error.to_string()))?;
    match command {
        Command::ValidateBundle { bundle } => {
            let validated = decode_bundle(bundle)?.validate().map_err(engine_error)?;
            Ok(serde_json::to_string(&Response::Ok {
                value: BundleIdentity {
                    source_bundle_digest: validated.source_bundle_digest,
                    policy_digest: validated.policy_digest,
                    engine_digest: engine_digest(),
                },
            }))
        }
        Command::Evaluate {
            bundle,
            input,
            max_work_units,
            explain,
        } => {
            let validated = decode_bundle(bundle)?.validate().map_err(engine_error)?;
            let canonical_input = serde_jcs::to_string(&input)
                .map_err(|error| ("malformed_request", error.to_string()))?;
            let input = CanonicalJson::parse(&canonical_input).map_err(engine_error)?;
            let result = evaluate_bundle(
                &validated.loaded,
                &input,
                EvaluationOptions {
                    max_work_units,
                    explain,
                },
            )
            .map_err(engine_error)?;
            let decision_bytes = serde_jcs::to_vec(&result.decision)
                .map_err(|error| ("boundary_serialization", error.to_string()))?;
            Ok(serde_json::to_string(&Response::Ok {
                value: EvaluationResponse {
                    source_bundle_digest: validated.source_bundle_digest,
                    policy_digest: validated.policy_digest,
                    engine_digest: engine_digest(),
                    input_digest: format!("{:x}", Sha256::digest(canonical_input.as_bytes())),
                    decision_digest: format!("{:x}", Sha256::digest(decision_bytes)),
                    decision: result.decision,
                    usage: result.usage,
                    explain: result.explain,
                },
            }))
        }
        Command::Identity => {
            let profile = valet_policy_engine::capability_profile().map_err(engine_error)?;
            Ok(serde_json::to_string(&Response::Ok {
                value: IdentityResponse {
                    engine_digest: engine_digest(),
                    target: "wasm32-unknown-unknown-worker",
                    max_wall_time_ms: profile.limits.adapter_deferred.max_wall_time_ms,
                    max_engine_memory_bytes: profile
                        .limits
                        .adapter_deferred
                        .max_engine_memory_bytes,
                },
            }))
        }
        Command::VerifyMemoryContainment => {
            let mut allocation = Vec::<u8>::new();
            allocation
                .try_reserve_exact(64 * 1024 * 1024)
                .map_err(|error| ("memory_limit", error.to_string()))?;
            Err((
                "memory_limit_missing",
                "The WebAssembly allocator exceeded its declared 64 MiB limit".to_owned(),
            ))
        }
    }
}

fn decode_bundle(bundle: WireBundle) -> Result<CanonicalSourceBundle, (&'static str, String)> {
    let files = bundle
        .files
        .into_iter()
        .map(|file| {
            STANDARD
                .decode(file.content_base64)
                .map(|bytes| SourceBundleFile {
                    path: file.path,
                    bytes,
                })
                .map_err(|error| ("malformed_bundle", error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CanonicalSourceBundle {
        manifest_json: bundle.manifest_json,
        files,
    })
}

fn engine_error(error: valet_policy_engine::EngineError) -> (&'static str, String) {
    let code = match error {
        valet_policy_engine::EngineError::EvaluationBudget { .. }
        | valet_policy_engine::EngineError::InputLimit { .. }
        | valet_policy_engine::EngineError::DecisionLimit { .. }
        | valet_policy_engine::EngineError::DecisionValueLimit { .. }
        | valet_policy_engine::EngineError::DocumentDepthLimit { .. }
        | valet_policy_engine::EngineError::DocumentValueLimit { .. } => "limit",
        valet_policy_engine::EngineError::IncompatibleBundle { .. } => "incompatible_bundle",
        valet_policy_engine::EngineError::DecisionContract(_) => "malformed_output",
        _ => "invalid_bundle_or_evaluation",
    };
    (code, error.to_string())
}

fn engine_digest() -> String {
    let identity =
        serde_jcs::to_vec(&ENGINE_IDENTITY).expect("the static engine identity serializes");
    format!("{:x}", Sha256::digest(identity))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_digest_is_stable_sha256() {
        assert_eq!(engine_digest().len(), 64);
        assert_eq!(engine_digest(), engine_digest());
    }
}
