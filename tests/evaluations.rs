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
async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
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
    let s = r.status();
    let b = to_bytes(r.into_body(), 2_097_152).await.unwrap();
    (s, serde_json::from_slice(&b).unwrap())
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn evaluation_attempts_bind_principal_settings_inventory_and_terminal_state() {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let p = format!("eval-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    let b = Uuid::new_v4();
    let parent = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'evaluation test')")
        .bind(b)
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    for (id, base, digest) in [
        (parent, None, "parent"),
        (candidate, Some(parent), "candidate"),
    ] {
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,'fixture-author')").bind(id).bind(&p).bind(b).bind(base).bind(digest).bind(b"{}".to_vec()).execute(&db).await.unwrap();
    }
    let grants = [("one", "evaluator-one"), ("two", "evaluator-two")]
        .into_iter()
        .map(|(token, principal)| Grant {
            token: token.into(),
            principal_id: principal.into(),
            project_id: p.clone(),
            rights: vec!["read".into(), "write".into()],
        })
        .collect();
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(grants),
        provider: None,
    });
    let root = format!("/v1/projects/{p}/bundles/{b}");
    let collection = format!("{root}/evaluation-requests");
    let identity = json!({"parentVersionId":parent,"parentDigest":"parent","candidateVersionId":candidate,"candidateDigest":"candidate","datasetRevision":"fixtures-v1","runtime":{"model":"fixture"},"graderRevision":"grader-v1","expectedCases":[{"caseId":"a","repetition":0}]});
    let (s, e) = call(&app, "POST", &collection, "one", identity.clone()).await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    assert!(e["proposalId"].is_null());
    let path = format!("{collection}/{}", e["id"].as_str().unwrap());
    for token in ["one", "one"] {
        let (s, v) = call(
            &app,
            "POST",
            &format!("{path}/start"),
            token,
            json!({"attemptId":"attempt"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
    }
    for (token, attempt) in [("two", "attempt"), ("one", "other")] {
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/start"),
                token,
                json!({"attemptId":attempt})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    let outcome = json!({"executionStatus":"completed","gradingStatus":"scored","reward":1});
    let mut comparison = identity.clone();
    comparison["results"] =
        json!([{"caseId":"a","repetition":0,"parent":outcome,"candidate":outcome}]);
    let (s, foreign) = call(
        &app,
        "POST",
        &format!("{root}/comparisons"),
        "two",
        comparison.clone(),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{foreign}");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/finish"),
            "one",
            json!({"attemptId":"attempt","comparisonId":foreign["id"]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    comparison["evaluation"] = json!({"requestId":e["id"],"attemptId":"attempt"});
    let mut mismatch = comparison.clone();
    mismatch["runtime"] = json!({"model":"wrong"});
    let (s, c) = call(
        &app,
        "POST",
        &format!("{root}/comparisons"),
        "one",
        mismatch,
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{c}");
    let (s, c) = call(
        &app,
        "POST",
        &format!("{root}/comparisons"),
        "one",
        comparison,
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{c}");
    for _ in 0..2 {
        let (s, v) = call(
            &app,
            "POST",
            &format!("{path}/finish"),
            "one",
            json!({"attemptId":"attempt","comparisonId":c["id"]}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["status"], "completed");
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/interrupt"),
            "one",
            json!({"reason":"late"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, e) = call(&app, "POST", &collection, "one", identity.clone()).await;
    let path = format!("{collection}/{}", e["id"].as_str().unwrap());
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/interrupt"),
            "one",
            json!({"reason":"operator stopped"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/start"),
            "one",
            json!({"attemptId":"late"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, e) = call(&app, "POST", &collection, "one", identity).await;
    let path = format!("{collection}/{}", e["id"].as_str().unwrap());
    call(
        &app,
        "POST",
        &format!("{path}/start"),
        "one",
        json!({"attemptId":"crashed"}),
    )
    .await;
    let (s, v) = call(&app, "GET", &path, "one", Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["status"], "running");
    let (s, v) = call(
        &app,
        "POST",
        &format!("{path}/interrupt"),
        "two",
        json!({"reason":"stop crashed attempt"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/finish"),
            "one",
            json!({"attemptId":"crashed","comparisonId":c["id"]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    let mut identity2 = json!({"parentVersionId":parent,"parentDigest":"parent","candidateVersionId":candidate,"candidateDigest":"candidate","datasetRevision":"fixtures-v1","runtime":{"model":"fixture"},"graderRevision":"grader-v1","expectedCases":[{"caseId":"a","repetition":0}]});
    let (_, e) = call(&app, "POST", &collection, "one", identity2.clone()).await;
    let partial_path = format!("{collection}/{}", e["id"].as_str().unwrap());
    call(
        &app,
        "POST",
        &format!("{partial_path}/start"),
        "one",
        json!({"attemptId":"partial"}),
    )
    .await;
    identity2["evaluation"] = json!({"requestId":e["id"],"attemptId":"partial"});
    identity2["results"] = json!([]);
    let (s, c) = call(
        &app,
        "POST",
        &format!("{root}/comparisons"),
        "one",
        identity2,
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{c}");
    let (s, e) = call(
        &app,
        "POST",
        &format!("{partial_path}/finish"),
        "one",
        json!({"attemptId":"partial","comparisonId":c["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{e}");
    assert_eq!(e["status"], "failed");
    assert!(e["error"].is_string());
    let (s, v) = call(
        &app,
        "GET",
        &format!("{root}/comparisons"),
        "one",
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(v["items"].as_array().unwrap().len() >= 3);
    let (s, v) = call(
        &app,
        "GET",
        &format!("{root}/proposals"),
        "one",
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["items"], json!([]));
    let (s, v) = call(
        &app,
        "GET",
        &format!("{collection}?limit=1"),
        "one",
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert!(v["nextCursor"].is_string());
}
