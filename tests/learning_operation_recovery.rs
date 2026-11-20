mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture() -> (AppState, String, Value) {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("learning-recovery-{}", Uuid::new_v4());
    let state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db,
        grants: Arc::new(vec![Grant {
            token: "learning-recovery-test".into(),
            principal_id: "learning-recovery-principal".into(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
        provider: None,
    };
    let app = router(state.clone());
    let setup = call(&app, "POST", &format!("/v1/workspaces/{project}/bundle-setups"), "seed", &json!({
        "name":"learning recovery fixture", "origin":"created", "channel":"stable",
        "payload":{"schemaVersion":1,"files":[{"path":"AGENTS.md","kind":"instruction","text":"Baseline."}]},
        "reason":"Explicit disposable model-free setup"
    }), false).await;
    assert_eq!(setup.0, 201, "{}", setup.1);
    (state, project, setup.1)
}
fn with_rights(state: &AppState, rights: &[&str]) -> AppState {
    let mut changed = state.clone();
    let mut grants = changed.grants.as_ref().clone();
    grants[0].rights = rights.iter().map(|value| (*value).into()).collect();
    changed.grants = Arc::new(grants);
    changed
}
async fn call(
    app: &axum::Router,
    method: &str,
    route: &str,
    key: &str,
    body: &Value,
    marked: bool,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(route)
        .header("authorization", "Bearer learning-recovery-test")
        .header("content-type", "application/json")
        .header("idempotency-key", key);
    if marked {
        request = request.header("x-acclimate-durable-operation", "true");
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
fn lookup(project: &str, key: &str, path: &str) -> String {
    format!(
        "/v1/workspaces/{project}/operations/{key}?operationPath={}",
        path.replace('/', "%2F")
    )
}
fn candidate(seed: &Value, text: &str) -> Value {
    json!({"parentVersionId":seed["version"]["id"], "payload":{"schemaVersion":1,"files":[
        {"path":"AGENTS.md","kind":"instruction","text":text}
    ]}})
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn retained_version_recovery_survives_transient_expiry_and_requires_current_write_right() {
    let (state, project, seed) = fixture().await;
    // The learner need not have promotion authority to publish or recover a candidate.
    let writer = router(with_rights(&state, &["write"]));
    let versions = format!(
        "/v1/workspaces/{project}/bundles/{}/versions",
        seed["bundle"]["id"].as_str().unwrap()
    );
    let key = Uuid::new_v4().to_string();
    let body = candidate(&seed, "Candidate.");
    let published = call(&writer, "POST", &versions, &key, &body, true).await;
    assert_eq!(published.0, 201, "{}", published.1);
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 minute' WHERE project_id=$1 AND key=$2")
        .bind(&project).bind(&key).execute(&state.db).await.unwrap();
    let observed = call(
        &writer,
        "GET",
        &lookup(&project, &key, &versions),
        "unused",
        &json!({}),
        false,
    )
    .await;
    assert_eq!(observed.0, 200, "{}", observed.1);
    assert_eq!(observed.1["status"], "committed");
    assert_eq!(observed.1["path"], versions);
    assert_eq!(observed.1["result"], published.1);
    assert!(
        observed.1["requestFingerprint"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        call(&writer, "POST", &versions, &key, &body, false).await,
        published
    );
    let changed = call(
        &writer,
        "POST",
        &versions,
        &key,
        &candidate(&seed, "Different bytes."),
        true,
    )
    .await;
    assert_eq!(changed.0, 409);
    assert_eq!(changed.1["error"]["code"], "idempotency_conflict");
    let reader = router(with_rights(&state, &["read"]));
    assert_eq!(
        call(
            &reader,
            "GET",
            &lookup(&project, &key, &versions),
            "unused",
            &json!({}),
            false
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(&reader, "POST", &versions, &key, &body, true).await.0,
        403
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM versions WHERE project_id=$1 AND bundle_id=$2")
            .bind(&project)
            .bind(Uuid::parse_str(seed["bundle"]["id"].as_str().unwrap()).unwrap())
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn legacy_version_receipt_can_be_observed_then_adopted_without_reexecuting() {
    let (state, project, seed) = fixture().await;
    let app = router(with_rights(&state, &["write"]));
    let versions = format!(
        "/v1/workspaces/{project}/bundles/{}/versions",
        seed["bundle"]["id"].as_str().unwrap()
    );
    let key = Uuid::new_v4().to_string();
    let body = candidate(&seed, "Legacy candidate.");
    let published = call(&app, "POST", &versions, &key, &body, false).await;
    assert_eq!(published.0, 201);
    let observed = call(
        &app,
        "GET",
        &lookup(&project, &key, &versions),
        "unused",
        &json!({}),
        false,
    )
    .await;
    assert_eq!(observed.0, 200);
    assert_eq!(observed.1["result"], published.1);
    assert_eq!(
        call(&app, "POST", &versions, &key, &body, true).await,
        published
    );
    sqlx::query("DELETE FROM idempotency WHERE project_id=$1 AND key=$2")
        .bind(&project)
        .bind(&key)
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "POST", &versions, &key, &body, false).await,
        published
    );
    let retained: i64 = sqlx::query_scalar("SELECT count(*) FROM operation_records WHERE project_id=$1 AND key=$2 AND status='committed'")
        .bind(&project).bind(&key).fetch_one(&state.db).await.unwrap();
    assert_eq!(retained, 1);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn closing_an_unobserved_version_prevents_late_marked_and_unmarked_publication() {
    let (state, project, seed) = fixture().await;
    let app = router(with_rights(&state, &["write"]));
    let versions = format!(
        "/v1/workspaces/{project}/bundles/{}/versions",
        seed["bundle"]["id"].as_str().unwrap()
    );
    for marked in [false, true] {
        let key = Uuid::new_v4().to_string();
        let closed = call(
            &app,
            "POST",
            &format!("/v1/workspaces/{project}/operations/{key}/close"),
            &key,
            &json!({"operationPath":versions}),
            false,
        )
        .await;
        assert_eq!(closed.0, 200, "{}", closed.1);
        assert_eq!(closed.1["status"], "closed");
        let delayed = call(
            &app,
            "POST",
            &versions,
            &key,
            &candidate(&seed, "Must not publish."),
            marked,
        )
        .await;
        assert_eq!(delayed.0, 409);
        assert_eq!(delayed.1["error"]["code"], "operation_closed");
        let again = call(
            &app,
            "GET",
            &lookup(&project, &key, &versions),
            "unused",
            &json!({}),
            false,
        )
        .await;
        assert_eq!(again.1["status"], "closed");
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM versions WHERE project_id=$1 AND bundle_id=$2")
            .bind(&project)
            .bind(Uuid::parse_str(seed["bundle"]["id"].as_str().unwrap()).unwrap())
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
}
