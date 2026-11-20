use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub token: String,
    pub principal_id: String,
    #[serde(rename = "workspaceId")]
    pub project_id: String,
    pub rights: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleFile {
    pub path: String,
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundlePayload {
    pub schema_version: u8,
    pub files: Vec<BundleFile>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub compatibility_target: String,
    pub id: String,
    pub name: String,
    #[serde(rename = "workspaceId")]
    pub project_id: String,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMetadata {
    pub id: String,
    pub bundle_id: String,
    pub parent_version_id: Option<String>,
    pub digest: String,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelResolution {
    pub channel: String,
    pub revision: String,
    pub version: VersionMetadata,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateVersionRequest {
    pub parent_version_id: Option<String>,
    pub payload: BundlePayload,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyReceiptReference {
    pub comparison_id: uuid::Uuid,
    pub policy_digest: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyOverride {
    pub reason: String,
    pub receipts: Vec<PolicyReceiptReference>,
}

impl PolicyOverride {
    pub(crate) fn normalized(mut self) -> Self {
        self.reason = self.reason.trim().to_owned();
        self.receipts.sort();
        self
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromoteRequest {
    pub version_id: String,
    pub expected_revision: String,
    pub comparison_id: Option<String>,
    pub unevaluated_reason: Option<String>,
    pub policy_override: Option<PolicyOverride>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub id: String,
    pub channel: String,
    pub revision: String,
    pub version: VersionMetadata,
    pub previous_version_id: Option<String>,
    pub comparison_id: Option<String>,
    pub unevaluated_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_override: Option<PolicyOverride>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_approval_promotion_id: Option<uuid::Uuid>,
    pub reviewer: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionPage {
    pub items: Vec<Promotion>,
    pub next_before_revision: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalRequest {
    pub parent_version_id: String,
    pub allowed_paths: Vec<String>,
    pub hypothesis: String,
    pub evidence: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub parent_version_id: String,
    pub status: String,
    pub attempts: i32,
    pub candidate: Option<VersionMetadata>,
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screening: Vec<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_source_comparison_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<EvaluationBinding>,
    pub parent_version_id: String,
    pub candidate_version_id: String,
    pub parent_digest: String,
    pub candidate_digest: String,
    pub dataset_revision: String,
    pub runtime: HashMap<String, String>,
    pub grader_revision: String,
    pub expected_cases: Vec<CaseKey>,
    pub results: Vec<CasePair>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationBinding {
    pub request_id: String,
    pub attempt_id: String,
}

#[derive(Clone, Serialize, Deserialize, Hash, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaseKey {
    pub case_id: String,
    pub repetition: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub execution_status: String,
    pub grading_status: String,
    pub reward: Option<f64>,
    pub output_ref: Option<String>,
    pub error: Option<String>,
    pub usage: Option<Usage>,
    /// Optional named numeric grade components, such as correctness and citations. A policy
    /// can gate on one with `metric.component`. Omitted when the grader reports none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub components: Option<std::collections::BTreeMap<String, f64>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CasePair {
    #[serde(flatten)]
    pub key: CaseKey,
    pub parent: Outcome,
    pub candidate: Outcome,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    #[serde(flatten)]
    pub request: ComparisonRequest,
    pub id: String,
    pub complete: bool,
    pub submitter: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub error: ErrorDetail,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}
