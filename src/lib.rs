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
pub mod executor;
mod integrations;
mod invitations;
mod learning;
pub use learning::optimizer::{ModelError, ModelFuture, OpenAiModel, OptimizerModel};
pub use learning::worker::learning_worker;
mod machine_tokens;
pub mod mail;
pub mod proposal_edits;
pub mod proposal_scanner;
mod store;
mod types;
mod workspaces;
pub use invitations::{invitation_worker, recover_invitation_mail};
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
    pub optimizer: Option<Arc<dyn OptimizerModel>>,
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
        .merge(workspaces::routes())
        .merge(invitations::routes())
        .merge(learning::routes())
        .merge(machine_tokens::routes())
        .route("/health", get(|| async { "ok" }))
        .route("/ready", get(runtime::readiness))
        .route(
            "/v1/workspaces/{project}/bundle-setups",
            post(bundles::create_setup),
        )
        .route(
            "/v1/workspaces/{project}/bundles",
            post(bundles::create_bundle),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/versions",
            post(bundles::create_version),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/versions/{version}",
            get(bundles::get_version),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/versions/{version}/payload",
            get(bundles::get_payload),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}",
            get(channels::resolve),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}/releases",
            get(channels::list_promotions).post(channels::promote),
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

#[cfg(test)]
mod validation_tests {
    use super::*;
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
    fn rejects_path_collisions() {
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
    }
}
