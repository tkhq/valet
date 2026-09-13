use serde::{Deserialize, Serialize};

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
    #[serde(rename = "approverId", skip_serializing_if = "Option::is_none")]
    pub approver_id: Option<String>,
    pub replay: ApprovalReplay,
    #[serde(rename = "expiresAtMs", skip_serializing_if = "Option::is_none")]
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
    #[serde(
        rename = "approvalRequirement",
        skip_serializing_if = "Option::is_none"
    )]
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

#[cfg(test)]
mod tests {
    use super::*;

    fn requirement(approver_id: Option<&str>, expires_at_ms: Option<u64>) -> ApprovalRequirement {
        ApprovalRequirement {
            tier: "high".to_owned(),
            approver_type: ApproverType::Team,
            approver_id: approver_id.map(str::to_owned),
            replay: ApprovalReplay::Once,
            expires_at_ms,
        }
    }

    #[test]
    fn approval_requirement_omits_absent_optional_fields() {
        let value = serde_json::to_value(requirement(None, None)).expect("requirement serializes");
        assert_eq!(
            value,
            serde_json::json!({
                "tier": "high",
                "approverType": "team",
                "replay": "once"
            })
        );
    }

    #[test]
    fn approval_requirement_serializes_present_optional_fields() {
        let value = serde_json::to_value(requirement(Some("team-1"), Some(123)))
            .expect("requirement serializes");
        assert_eq!(
            value,
            serde_json::json!({
                "tier": "high",
                "approverType": "team",
                "approverId": "team-1",
                "replay": "once",
                "expiresAtMs": 123
            })
        );
    }
}
