mod common;
use acclimate_service::{AppState, Grant, proposal_worker, router};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::json;
use std::sync::Arc;
use tower::ServiceExt;

#[tokio::test]
async fn postgres_bundle_scope_and_immutable_payload() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let grants = vec![
        Grant {
            token: "reader".into(),
            principal_id: "p1".into(),
            project_id: "project-a".into(),
            rights: vec![
                "read".into(),
                "write".into(),
                "propose".into(),
                "promote".into(),
            ],
        },
        Grant {
            token: "other".into(),
            principal_id: "p2".into(),
            project_id: "project-b".into(),
            rights: vec!["read".into()],
        },
    ];
    let state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(grants),
        provider: None,
    };
    let app = router(state.clone());
    let bundle_key = format!("bundle-key-{}", uuid::Uuid::new_v4());
    let version_key = format!("version-key-{}", uuid::Uuid::new_v4());
    let proposal_key = format!("proposal-key-{}", uuid::Uuid::new_v4());
    let bundle_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/projects/project-a/bundles")
                .header("authorization", "Bearer reader")
                .header("idempotency-key", bundle_key.clone())
                .body(Body::from(r#"{"name":"test"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bundle_resp.status(), StatusCode::CREATED);
    let bundle: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(bundle_resp.into_body(), 10000)
            .await
            .unwrap(),
    )
    .unwrap();
    let bid = bundle["id"].as_str().unwrap();
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 second' WHERE project_id='project-a' AND path='/v1/projects/project-a/bundles' AND key=$1").bind(&bundle_key).execute(&db).await.unwrap();
    let reused = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/projects/project-a/bundles")
                .header("authorization", "Bearer reader")
                .header("idempotency-key", bundle_key.clone())
                .body(Body::from(r#"{"name":"test-after-expiry"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(reused.status(), StatusCode::CREATED);
    let req = json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"x.md","kind":"instruction","text":"hello"}]}});
    let uri = format!("/v1/projects/project-a/bundles/{bid}/versions");
    let ver_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&uri)
                .header("authorization", "Bearer reader")
                .header("idempotency-key", version_key)
                .body(Body::from(req.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ver_resp.status(), StatusCode::CREATED);
    let ver: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(ver_resp.into_body(), 10000)
            .await
            .unwrap(),
    )
    .unwrap();
    let channel = format!("seed-{}", uuid::Uuid::new_v4());
    let promote_uri = format!("/v1/projects/project-a/bundles/{bid}/channels/{channel}/promotions");
    let make_promote = |key: String| {
        Request::builder().method("POST").uri(&promote_uri).header("authorization","Bearer reader").header("idempotency-key",key).header("content-type","application/json").body(Body::from(json!({"versionId":ver["id"],"expectedRevision":"0","unevaluatedReason":"test seed"}).to_string())).unwrap()
    };
    let (race_a, race_b) = tokio::join!(
        app.clone()
            .oneshot(make_promote(format!("seed-a-{}", uuid::Uuid::new_v4()))),
        app.clone()
            .oneshot(make_promote(format!("seed-b-{}", uuid::Uuid::new_v4())))
    );
    let statuses = [race_a.unwrap().status(), race_b.unwrap().status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let proposal_body = json!({"parentVersionId":ver["id"],"allowedPaths":["x.md"],"hypothesis":"small edit","evidence":[]});
    let proposal_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/projects/project-a/bundles/{bid}/proposals"))
                .header("authorization", "Bearer reader")
                .header("idempotency-key", proposal_key)
                .body(Body::from(proposal_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(proposal_resp.status(), StatusCode::ACCEPTED);
    let proposal: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(proposal_resp.into_body(), 10000)
            .await
            .unwrap(),
    )
    .unwrap();
    let proposal_get = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v1/projects/project-a/bundles/{bid}/proposals/{}",
                    proposal["id"].as_str().unwrap()
                ))
                .header("authorization", "Bearer reader")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(proposal_get.status(), StatusCode::OK);
    let queued: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(proposal_get.into_body(), 10000)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(queued["candidate"], serde_json::Value::Null);
    assert_eq!(queued["status"], "queued");
    let worker = tokio::spawn(proposal_worker(state));
    let mut final_status = String::new();
    for _ in 0..20 {
        let got = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/projects/project-a/bundles/{bid}/proposals/{}",
                        proposal["id"].as_str().unwrap()
                    ))
                    .header("authorization", "Bearer reader")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(got.into_body(), 10000).await.unwrap())
                .unwrap();
        final_status = value["status"].as_str().unwrap_or_default().to_owned();
        if final_status == "failed" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    worker.abort();
    assert_eq!(final_status, "failed");
    let payload_uri = format!("{uri}/{}/payload", ver["id"].as_str().unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(payload_uri)
                .header("authorization", "Bearer reader")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 10000)
        .await
        .unwrap();
    assert!(bytes.ends_with(b"\n"));
    let denied = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v1/projects/project-b/bundles/{bid}/versions/{}",
                    ver["id"].as_str().unwrap()
                ))
                .header("authorization", "Bearer other")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    let _ = sqlx::query("DELETE FROM bundles WHERE project_id='project-a' AND id=$1")
        .bind(uuid::Uuid::parse_str(bid).unwrap())
        .execute(&db)
        .await;
}
