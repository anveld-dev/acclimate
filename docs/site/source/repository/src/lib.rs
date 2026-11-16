use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
pub mod access_config;
mod auth;
pub mod runtime;
pub use access_config::{AccessConfig, OperatorIdentity};
pub use auth::{validate_access_config, validate_grants};
pub use runtime::RuntimeStatus;
mod bundles;
mod channels;
mod commands;
pub mod compatibility;
mod drafts;
mod evaluations;
mod improvement;
mod integrations;
pub mod pagination;
pub mod proposal_edits;
mod store;
mod types;
mod workspaces;
pub use improvement::proposal_worker;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::Arc;
pub use types::*;
use uuid::Uuid;
pub use workspaces::backfill_projects;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub grants: Arc<Vec<Grant>>,
    pub access: Arc<AccessConfig>,
    pub runtime: Arc<RuntimeStatus>,
    pub provider: Option<Arc<dyn ProposalModel>>,
}
pub type ProposalFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(BundlePayload, String), String>> + Send + 'a>,
>;
pub trait ProposalModel: Send + Sync {
    fn propose<'a>(&'a self, parent: BundlePayload, request: ProposalRequest)
    -> ProposalFuture<'a>;
}

#[derive(Debug)]
pub(crate) struct ApiErr(StatusCode, &'static str, String, Option<Value>);
impl ApiErr {
    pub(crate) fn with_details(mut self, details: Value) -> Self {
        self.3 = Some(details);
        self
    }
}
impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        let b = Json(ApiError {
            error: ErrorDetail {
                code: self.1.into(),
                message: self.2,
                request_id: Uuid::new_v4().to_string(),
                details: self.3,
            },
        });
        (self.0, b).into_response()
    }
}
pub(crate) type ApiResult<T> = Result<T, ApiErr>;
pub(crate) fn err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> ApiErr {
    ApiErr(status, code, msg.into(), None)
}

pub(crate) fn encode_payload(p: &BundlePayload) -> Result<Vec<u8>, ApiErr> {
    let mut b = serde_json::to_vec(p).map_err(|_| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Cannot encode payload",
        )
    })?;
    b.push(b'\n');
    if b.len() > 1_048_576 {
        return Err(err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Payload exceeds 1MiB",
        ));
    }
    Ok(b)
}
pub(crate) fn digest(b: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(b)))
}

pub(crate) fn path(s: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(s).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_content", "Invalid UUID"))
}
async fn request_limits(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    static REQUESTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let semaphore = REQUESTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(64)));
    let Ok(_permit) = semaphore.try_acquire() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Service is busy",
        )
        .into_response();
    };
    match tokio::time::timeout(std::time::Duration::from_secs(30), next.run(request)).await {
        Ok(response) if response.status() == StatusCode::PAYLOAD_TOO_LARGE => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Request exceeds 2MiB",
        )
        .into_response(),
        Ok(response) => response,
        Err(_) => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Request timed out",
        )
        .into_response(),
    }
}
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(commands::routes())
        .merge(integrations::routes())
        .merge(drafts::routes())
        .merge(evaluations::routes())
        .merge(workspaces::routes())
        .route("/health", get(|| async { "ok" }))
        .route("/ready", get(runtime::readiness))
        .route(
            "/v1/projects/{project}/bundles",
            post(bundles::create_bundle),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/versions",
            post(bundles::create_version),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/versions/{version}",
            get(bundles::get_version),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/versions/{version}/payload",
            get(bundles::get_payload),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/channels/{channel}",
            get(channels::resolve),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/channels/{channel}/promotions",
            get(channels::list_promotions).post(channels::promote),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/comparisons",
            post(improvement::create_comparison).get(improvement::list_comparisons),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/comparisons/{id}",
            get(improvement::get_comparison),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/proposals",
            post(improvement::create_proposal).get(improvement::list_proposals),
        )
        .route(
            "/v1/projects/{project}/bundles/{bundle}/proposals/{id}",
            get(improvement::get_proposal),
        )
        .fallback(|| async { err(StatusCode::NOT_FOUND, "not_found", "Route not found") })
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::session_context,
        ))
        .layer(axum::middleware::from_fn(request_limits))
        .with_state(state)
}

pub(crate) fn db(_e: impl std::fmt::Display) -> ApiErr {
    ApiErr(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "Database operation failed".into(),
        None,
    )
}

pub struct OpenAiModel {
    client: reqwest::Client,
    endpoint: String,
    token: String,
    model: String,
}
impl OpenAiModel {
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(endpoint) = std::env::var("ACCLIMATE_MODEL_ENDPOINT") else {
            return Ok(None);
        };
        let token = std::env::var("ACCLIMATE_MODEL_TOKEN")
            .map_err(|_| "ACCLIMATE_MODEL_TOKEN required".to_string())?;
        let model =
            std::env::var("ACCLIMATE_MODEL").map_err(|_| "ACCLIMATE_MODEL required".to_string())?;
        if !matches!(model.as_str(), "gpt-6-luna" | "gpt-5.6-luna") {
            return Err("Only Luna model identifiers are permitted".into());
        }
        Ok(Some(Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|e| e.to_string())?,
            endpoint,
            token,
            model,
        }))
    }
}
impl ProposalModel for OpenAiModel {
    fn propose<'a>(
        &'a self,
        parent: BundlePayload,
        request: ProposalRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(BundlePayload, String), String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let prompt=serde_json::json!({"parent":parent,"request":request,"instruction":crate::proposal_edits::INSTRUCTION}).to_string();
            let resp=self.client.post(&self.endpoint).bearer_auth(&self.token).json(&serde_json::json!({"model":self.model,"messages":[{"role":"user","content":prompt}],"response_format":{"type":"json_object"},"max_completion_tokens":8192})).send().await.map_err(|e|e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("provider returned {}", resp.status()));
            }
            if resp.content_length().unwrap_or(0) > 262144 {
                return Err("provider response too large".into());
            }
            let mut response = resp;
            let mut raw = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                if raw.len() + chunk.len() > 262144 {
                    return Err("provider response too large".into());
                }
                raw.extend_from_slice(&chunk);
            }
            let outer: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            if outer["choices"][0]["finish_reason"].as_str() != Some("stop") {
                return Err("provider did not finish a complete response".into());
            }
            let content = outer["choices"][0]["message"]["content"]
                .as_str()
                .ok_or("provider response missing content")?;
            if content.len() > 32768 {
                return Err("model output too large".into());
            }
            crate::proposal_edits::reconstruct(&parent, &request, content)
        })
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    use std::collections::HashMap;
    #[test]
    fn exact_fixture_encoding_and_digest() {
        let payload: BundlePayload =
            serde_json::from_slice(include_bytes!("../contracts/fixtures/bundle-v1.json")).unwrap();
        let bytes = encode_payload(&payload).unwrap();
        assert_eq!(
            bytes,
            include_bytes!("../contracts/fixtures/bundle-v1.json")
        );
        assert_eq!(
            digest(&bytes),
            "sha256:0067f5c5211d303528a731b3b2e4c169935dd62b40e8444c671204605a53557b"
        );
    }
    #[test]
    fn rejects_path_collisions_and_bad_scores() {
        let p = BundlePayload {
            schema_version: 1,
            files: vec![
                BundleFile {
                    path: "a".into(),
                    kind: "skill".into(),
                    text: "".into(),
                },
                BundleFile {
                    path: "a/b".into(),
                    kind: "skill".into(),
                    text: "".into(),
                },
            ],
        };
        assert!(bundles::validate_payload(&p).is_err());
        let q = ComparisonRequest {
            evaluation: None,
            parent_version_id: "p".into(),
            candidate_version_id: "c".into(),
            parent_digest: "x".into(),
            candidate_digest: "y".into(),
            dataset_revision: "d".into(),
            runtime: HashMap::from([("model".into(), "gpt-6-luna".into())]),
            grader_revision: "g".into(),
            expected_cases: vec![CaseKey {
                case_id: "c".into(),
                repetition: 0,
            }],
            results: vec![CasePair {
                key: CaseKey {
                    case_id: "c".into(),
                    repetition: 0,
                },
                parent: Outcome {
                    execution_status: "completed".into(),
                    grading_status: "scored".into(),
                    reward: Some(f64::NAN),
                    output_ref: None,
                    error: None,
                    usage: None,
                },
                candidate: Outcome {
                    execution_status: "completed".into(),
                    grading_status: "scored".into(),
                    reward: Some(1.0),
                    output_ref: None,
                    error: None,
                    usage: None,
                },
            }],
        };
        assert!(improvement::validate_comparison(&q).is_err());
    }
    struct Fake;
    impl ProposalModel for Fake {
        fn propose<'a>(
            &'a self,
            parent: BundlePayload,
            _: ProposalRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(BundlePayload, String), String>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Ok((parent, "unchanged fixture".into())) })
        }
    }
    #[tokio::test]
    async fn fake_model_is_deterministic() {
        let p = BundlePayload {
            schema_version: 1,
            files: vec![BundleFile {
                path: "a.md".into(),
                kind: "skill".into(),
                text: "x".into(),
            }],
        };
        let req = ProposalRequest {
            parent_version_id: "p".into(),
            allowed_paths: vec!["a.md".into()],
            hypothesis: "h".into(),
            evidence: vec![],
        };
        let a = Fake.propose(p.clone(), req.clone()).await.unwrap();
        let b = Fake.propose(p, req).await.unwrap();
        assert_eq!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap()
        );
    }
}
