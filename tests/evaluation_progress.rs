mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    session: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("idempotency-key", Uuid::new_v4().to_string());
    if let Some(session) = session {
        builder = builder.header("x-acclimate-session", session);
    }
    let response = app
        .clone()
        .oneshot(
            builder
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
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn observations_bind_live_owner_preserve_order_expire_and_never_control_lifecycle() {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("progress-{}", Uuid::new_v4());
    let bundle = Uuid::new_v4();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'progress')")
        .bind(bundle)
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let request = json!({"parentVersionId":Uuid::new_v4(),"parentDigest":"parent","candidateVersionId":Uuid::new_v4(),"candidateDigest":"candidate","datasetRevision":"d","runtime":{"model":"fixture"},"graderRevision":"g","expectedCases":[{"caseId":"a","repetition":0}]});
    sqlx::query("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status,evaluator_principal,attempt_id) VALUES($1,$2,$3,$4,'owner','running','owner','attempt')").bind(id).bind(&project).bind(bundle).bind(request.clone()).execute(&db).await.unwrap();
    let state = AppState {
        db: db.clone(),
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        provider: None,
        grants: Arc::new(vec![
            Grant {
                token: "owner".into(),
                principal_id: "owner".into(),
                project_id: project.clone(),
                rights: vec!["read".into(), "write".into()],
            },
            Grant {
                token: "foreign".into(),
                principal_id: "foreign".into(),
                project_id: project.clone(),
                rights: vec!["read".into(), "write".into()],
            },
            Grant {
                token: "reader".into(),
                principal_id: "reader".into(),
                project_id: project.clone(),
                rights: vec!["read".into()],
            },
        ]),
    };
    let app = router(state.clone());
    let path =
        format!("/v1/workspaces/{project}/bundles/{bundle}/evaluation-requests/{id}/progress");
    let report = json!({"attemptId":"attempt","sequence":1,"phase":"executing","completed":0,"total":2,"case":{"caseId":"a","repetition":0}});
    assert_eq!(
        call(&app, "GET", &path, "reader", None, Value::Null)
            .await
            .1["activity"],
        "absent"
    );
    assert_eq!(
        call(&app, "POST", &path, "reader", None, report.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "POST", &path, "foreign", None, report.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    for patch in [
        json!({"attemptId":"wrong"}),
        json!({"total":1}),
        json!({"case":{"caseId":"other","repetition":0}}),
    ] {
        let mut bad = report.clone();
        for (k, v) in patch.as_object().unwrap() {
            bad[k] = v.clone();
        }
        assert_eq!(
            call(&app, "POST", &path, "owner", None, bad).await.0,
            StatusCode::CONFLICT
        );
    }
    for patch in [
        json!({"phase":"private error"}),
        json!({"sequence":0}),
        json!({"rawOutput":"private"}),
        json!({"total":2001}),
        json!({"completed":3}),
    ] {
        let mut bad = report.clone();
        for (k, v) in patch.as_object().unwrap() {
            bad[k] = v.clone();
        }
        assert_eq!(
            call(&app, "POST", &path, "owner", None, bad).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let initial_updated_at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT updated_at FROM evaluation_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    let wrong_scope = path.replace(&bundle.to_string(), &Uuid::new_v4().to_string());
    assert_eq!(
        call(&app, "GET", &wrong_scope, "reader", None, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let mut oversized = report.clone();
    oversized["attemptId"] = json!("x".repeat(3000));
    assert_eq!(
        call(&app, "POST", &path, "owner", None, oversized).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let mut private_case = report.clone();
    private_case["case"]["rawOutput"] = json!("private-canary");
    assert_eq!(
        call(&app, "POST", &path, "owner", None, private_case)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (status, first) = call(&app, "POST", &path, "owner", None, report.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["activity"], "fresh");
    let repeated = call(&app, "POST", &path, "owner", None, report.clone())
        .await
        .1;
    assert_eq!(first["observation"], repeated["observation"]);
    assert_eq!(
        call(&app, "GET", &path, "reader", None, Value::Null)
            .await
            .1["observation"],
        first["observation"]
    );
    let mut conflicting = report.clone();
    conflicting["phase"] = json!("grading");
    assert_eq!(
        call(&app, "POST", &path, "owner", None, conflicting)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut next = report.clone();
    next["sequence"] = json!(2);
    next["completed"] = json!(1);
    assert_eq!(
        call(&app, "POST", &path, "owner", None, next.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "POST", &path, "owner", None, report.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut backwards = next.clone();
    backwards["sequence"] = json!(3);
    backwards["completed"] = json!(0);
    assert_eq!(
        call(&app, "POST", &path, "owner", None, backwards).await.0,
        StatusCode::CONFLICT
    );
    // Concurrent out-of-order arrivals retain the highest coherent sequence.
    let mut three = next.clone();
    three["sequence"] = json!(3);
    let mut four = next.clone();
    four["sequence"] = json!(4);
    let (a, b) = tokio::join!(
        call(&app, "POST", &path, "owner", None, three),
        call(&app, "POST", &path, "owner", None, four.clone())
    );
    assert!(a.0 == StatusCode::OK || a.0 == StatusCode::CONFLICT);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(
        call(&app, "GET", &path, "owner", None, Value::Null).await.1["observation"]["sequence"],
        4
    );
    sqlx::query("UPDATE evaluation_progress SET received_at=now()-interval '61 seconds' WHERE request_id=$1").bind(id).execute(&db).await.unwrap();
    assert_eq!(
        call(&app, "GET", &path, "owner", None, Value::Null).await.1["activity"],
        "stale"
    );
    sqlx::query(
        "UPDATE evaluation_progress SET expires_at=now()-interval '1 second' WHERE request_id=$1",
    )
    .bind(id)
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        call(&app, "GET", &path, "owner", None, Value::Null).await.1["activity"],
        "absent"
    );
    // Expired exact retry neither refreshes the receipt nor loses the watermark.
    assert_eq!(
        call(&app, "POST", &path, "owner", None, four).await.1["activity"],
        "absent"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM evaluation_progress WHERE request_id=$1"
        )
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        call(&app, "POST", &path, "owner", None, report).await.0,
        StatusCode::CONFLICT
    );
    let mut backward_after_expiry = next.clone();
    backward_after_expiry["sequence"] = json!(5);
    backward_after_expiry["completed"] = json!(0);
    assert_eq!(
        call(&app, "POST", &path, "owner", None, backward_after_expiry)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
            "SELECT updated_at FROM evaluation_requests WHERE id=$1"
        )
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap(),
        initial_updated_at
    );
    let mut five = next;
    five["sequence"] = json!(5);
    assert_eq!(
        call(&app, "POST", &path, "owner", None, five.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM evaluation_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap(),
        "running"
    );
    // At most one payload per request; one report bounds expiry work to 100 rows.
    let expired:Vec<Uuid>=sqlx::query_scalar("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status) SELECT gen_random_uuid(),$1,$2,$3,'owner','requested' FROM generate_series(1,105) RETURNING id")
        .bind(&project).bind(bundle).bind(request).fetch_all(&db).await.unwrap();
    sqlx::query("INSERT INTO evaluation_progress(request_id,body,expires_at) SELECT unnest($1::uuid[]),'{}'::jsonb,now()-interval '1 second'").bind(&expired).execute(&db).await.unwrap();
    five["sequence"] = json!(6);
    assert_eq!(
        call(&app, "POST", &path, "owner", None, five.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM evaluation_progress WHERE request_id=ANY($1)"
        )
        .bind(&expired)
        .fetch_one(&db)
        .await
        .unwrap(),
        5
    );
    // Revoked machine rights take effect with the current configured authorization.
    let mut revoked = state.clone();
    revoked.grants = Arc::new(vec![]);
    assert_eq!(
        call(&router(revoked), "POST", &path, "owner", None, five.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // Browser membership/session revocation gates reading current observations.
    let user = Uuid::new_v4();
    let session = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'progress',$2)")
        .bind(user)
        .bind(user.to_string())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'viewer')")
        .bind(&project)
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO browser_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(user).bind(format!("sha256:{}",hex::encode(Sha256::digest(secret.as_bytes())))).execute(&db).await.unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &path,
            common::CONSOLE_TOKEN,
            Some(&secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(&project)
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &path,
            common::CONSOLE_TOKEN,
            Some(&secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE browser_sessions SET revoked_at=now() WHERE id=$1")
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &path,
            common::CONSOLE_TOKEN,
            Some(&secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // Ordinary interruption is independent: recent activity becomes stale and writes fail.
    let interrupt = path.strip_suffix("progress").unwrap().to_owned() + "interrupt";
    assert_eq!(
        call(
            &app,
            "POST",
            &interrupt,
            "foreign",
            None,
            json!({"reason":"operator interrupted"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &path, "owner", None, Value::Null).await.1["activity"],
        "stale"
    );
    five["sequence"] = json!(6);
    assert_eq!(
        call(&app, "POST", &path, "owner", None, five).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM evaluation_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap(),
        "interrupted"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM operation_records WHERE project_id=$1 AND path LIKE '%/progress'"
        )
        .bind(&project)
        .fetch_one(&db)
        .await
        .unwrap(),
        0
    );
}
