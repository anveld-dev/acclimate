mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;
async fn call(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer native-fixture")
                .header("idempotency-key", Uuid::new_v4().to_string())
                .body(Body::from(if method == "GET" {
                    String::new()
                } else {
                    body.to_string()
                }))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2_097_152).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn payload(complete: bool) -> Value {
    json!({"schemaVersion":1,"files":[{"path":"skills/review/SKILL.md","kind":"skill","text":if complete {"---\nname: review\ndescription: Review changes\n---\nInstructions"} else {"Incomplete metadata"}}]})
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn native_version_upload_release_compatibility_and_rollback() {
    let url = common::database_url();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("native-{}", Uuid::new_v4());
    let state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "native-fixture".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
    };
    let app = router(state);
    let root = format!("/v1/workspaces/{project}");
    for target in ["unknown", "codex"] {
        let (status,_)=call(&app,"POST",&format!("{root}/bundle-setups"),json!({"name":"incomplete","origin":"created","channel":"stable","reason":"initial","compatibilityTarget":target,"payload":payload(false)})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status,generic)=call(&app,"POST",&format!("{root}/bundle-setups"),json!({"name":"generic","origin":"created","channel":"stable","reason":"initial","payload":payload(false)})).await;
    assert_eq!(status, StatusCode::CREATED, "{generic}");
    assert_eq!(generic["bundle"]["compatibilityTarget"], "generic");
    let (status,native)=call(&app,"POST",&format!("{root}/bundle-setups"),json!({"name":"native","origin":"created","channel":"stable","reason":"initial","compatibilityTarget":"codex","payload":payload(true)})).await;
    assert_eq!(status, StatusCode::CREATED, "{native}");
    assert_eq!(native["bundle"]["compatibilityTarget"], "codex");
    let base = format!(
        "{root}/bundles/{}",
        native["bundle"]["id"].as_str().unwrap()
    );
    let initial = &native["version"]["id"];
    let versions = format!("{base}/versions");
    let releases = format!("{base}/channels/stable/releases");
    let (status, incomplete) = call(
        &app,
        "POST",
        &versions,
        json!({"parentVersionId":initial,"payload":payload(false)}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{incomplete}");
    let snapshot = format!("{versions}/{}/payload", incomplete["id"].as_str().unwrap());
    let (status, saved) = call(&app, "GET", &snapshot, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved, payload(false));
    let (status, failed) = call(
        &app,
        "POST",
        &releases,
        json!({"versionId":incomplete["id"],"expectedRevision":"1","unevaluatedReason":"review"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_compatibility");
    let (status, repaired) = call(
        &app,
        "POST",
        &versions,
        json!({"parentVersionId":incomplete["id"],"payload":payload(true)}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{repaired}");
    let (status, published) = call(&app, "POST", &releases,
        json!({"versionId":repaired["id"],"expectedRevision":"1","unevaluatedReason":"reviewed repair"})).await;
    assert_eq!(status, StatusCode::CREATED, "{published}");
    let (status, rollback) = call(&app, "POST", &releases,
        json!({"versionId":initial,"expectedRevision":"2","unevaluatedReason":"compatible rollback"})).await;
    assert_eq!(status, StatusCode::CREATED, "{rollback}");
    assert_eq!(rollback["version"]["id"], *initial);
    db.close().await;
}
