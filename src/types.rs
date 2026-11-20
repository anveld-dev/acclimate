use serde::{Deserialize, Serialize};

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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromoteRequest {
    pub version_id: String,
    pub expected_revision: String,
    pub unevaluated_reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub id: String,
    pub channel: String,
    pub revision: String,
    pub version: VersionMetadata,
    pub previous_version_id: Option<String>,
    pub unevaluated_reason: Option<String>,
    pub reviewer: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionPage {
    pub items: Vec<Promotion>,
    pub next_before_revision: Option<String>,
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
    pub details: Option<serde_json::Value>,
}
