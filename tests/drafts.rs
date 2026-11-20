mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
async fn call(
    app: &axum::Router,
    method: &str,
    url: &str,
    key: &str,
    value: Value,
) -> (u16, Value) {
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(url)
                .header("authorization", "Bearer draft-test")
                .header("content-type", "application/json")
                .header("idempotency-key", key)
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status().as_u16();
    let body = to_bytes(r.into_body(), 2 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn draft_snapshots_replay_and_discard_but_cannot_publish() {
    // Explicit fixture URL prevents accidentally migrating or mutating the demo database.
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("draft-test-{}", uuid::Uuid::new_v4());
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "draft-test".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
        provider: None,
    });
    let payload = |text: &str| json!({"schemaVersion":1,"files":[{"path":"AGENTS.md","kind":"instruction","text":text}]});
    let setup_url = format!("/v1/workspaces/{project}/bundle-setups");
    let (status,setup)=call(&app,"POST",&setup_url,"setup",json!({"name":"fixture","origin":"created","channel":"stable","payload":payload("base"),"reason":"initial seed"})).await;
    assert_eq!(status, 201, "{setup}");
    let base = setup["version"]["id"].as_str().unwrap();
    let bundle = setup["bundle"]["id"].as_str().unwrap();
    let drafts = format!("/v1/workspaces/{project}/bundles/{bundle}/channels/stable/drafts");
    let (status, d1) = call(
        &app,
        "POST",
        &drafts,
        "create",
        json!({"baseVersionId":base,"baseRevision":"1","payload":payload("one")}),
    )
    .await;
    assert_eq!(status, 201, "{d1}");
    let url = format!("{drafts}/{}", d1["id"].as_str().unwrap());
    let save = json!({"expectedGeneration":1,"payload":payload("two")});
    let (status, d2) = call(&app, "POST", &format!("{url}/save"), "save", save.clone()).await;
    assert_eq!(status, 200, "{d2}");
    assert_eq!(d2["generation"], 2);
    assert_eq!(d2["snapshotVersion"]["parentVersionId"], base);
    assert_ne!(d1["snapshotVersion"]["id"], d2["snapshotVersion"]["id"]);
    let (status, conflict) =
        call(&app, "POST", &format!("{url}/save"), "stale", save.clone()).await;
    assert_eq!(status, 409);
    assert_eq!(conflict["error"]["code"], "generation_conflict");
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 second' WHERE project_id=$1")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let (status, replay) = call(&app, "POST", &format!("{url}/save"), "save", save).await;
    assert_eq!(status, 200);
    assert_eq!(replay, d2);
    let (_, history) = call(
        &app,
        "GET",
        &format!("{url}/history"),
        "unused",
        Value::Null,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{url}/publish"),
        "publish",
        json!({"expectedGeneration":2,"expectedRevision":"1","unevaluatedReason":"manual"}),
    )
    .await;
    assert_eq!(status, 404);
    let (_, open) = call(&app, "GET", &url, "read", Value::Null).await;
    assert_eq!(open["generation"], 2);
    assert!(open["promotionId"].is_null());
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM bundles WHERE project_id=$1")
        .bind(&project)
        .fetch_one(&db)
        .await
        .unwrap();
    let (status,_)=call(&app,"POST",&setup_url,"bad-seed",json!({"name":"must rollback","origin":"imported","channel":"stable","payload":payload("bad"),"reason":" "})).await;
    assert_eq!(status, 400);
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM bundles WHERE project_id=$1")
        .bind(&project)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(before, after);
    let (status, closed) = call(
        &app,
        "POST",
        &format!("{url}/discard"),
        "discard",
        json!({"expectedGeneration":2}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(closed["status"], "discarded");
}
