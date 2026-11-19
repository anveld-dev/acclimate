mod common;

use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    state: AppState,
    project: String,
    bundle: Uuid,
    parent: Uuid,
    candidate: Uuid,
}

async fn fixture() -> Fixture {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("dx-{}", Uuid::new_v4());
    let bundle = Uuid::new_v4();
    let parent = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'DX fixture')")
        .bind(bundle)
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    for (id, base, marker) in [(parent, None, "a"), (candidate, Some(parent), "b")] {
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,'fixture-author')")
            .bind(id).bind(&project).bind(bundle).bind(base)
            .bind(format!("sha256:{}",marker.repeat(64))).bind(b"{}".as_slice())
            .execute(&db).await.unwrap();
    }
    let grants = [
        ("writer", "worker", vec!["read", "write", "promote"]),
        ("rotated", "worker", vec!["read", "write"]),
        ("reader", "reader", vec!["read"]),
        ("no-read", "no-read", vec!["write"]),
    ]
    .into_iter()
    .map(|(token, principal, rights)| Grant {
        token: token.into(),
        principal_id: principal.into(),
        project_id: project.clone(),
        rights: rights.into_iter().map(String::from).collect(),
    })
    .collect();
    Fixture {
        state: AppState {
            access: common::access(),
            runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
            db,
            grants: Arc::new(grants),
            provider: None,
        },
        project,
        bundle,
        parent,
        candidate,
    }
}

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: &Value,
    key: &str,
    retained: bool,
) -> (StatusCode, HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .header("idempotency-key", key);
    if retained {
        request = request.header("x-acclimate-durable-operation", "true");
    }
    let response = app
        .clone()
        .oneshot(
            request
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
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, headers, serde_json::from_slice(&body).unwrap())
}

fn identity(f: &Fixture) -> Value {
    json!({"parentVersionId":f.parent,"parentDigest":format!("sha256:{}","a".repeat(64)),
        "candidateVersionId":f.candidate,"candidateDigest":format!("sha256:{}","b".repeat(64)),
        "datasetRevision":"dx-v1","graderRevision":"dx-v1",
        "runtime":{"configId":"fixture","configRevision":"1"},
        "expectedCases":[{"caseId":"saved-task","repetition":0}],"requireBoundEvidence":true})
}

async fn request(f: &Fixture, app: &axum::Router) -> (String, String) {
    let collection = format!(
        "/v1/projects/{}/bundles/{}/evaluation-requests",
        f.project, f.bundle
    );
    let (s, _, e) = call(
        app,
        "POST",
        &collection,
        "writer",
        &identity(f),
        &Uuid::new_v4().to_string(),
        true,
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    (
        format!("{collection}/{}", e["id"].as_str().unwrap()),
        e["id"].as_str().unwrap().into(),
    )
}

fn report(f: &Fixture, request_id: &str, attempt: &str) -> Value {
    let mut report = identity(f);
    report
        .as_object_mut()
        .unwrap()
        .remove("requireBoundEvidence");
    report["evaluation"] = json!({"requestId":request_id,"attemptId":attempt});
    let outcome = json!({"executionStatus":"completed","gradingStatus":"scored","reward":1});
    report["results"] =
        json!([{"caseId":"saved-task","repetition":0,"parent":outcome,"candidate":outcome}]);
    report
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn capabilities_are_machine_scoped_and_never_overstate_retention() {
    let mut f = fixture().await;
    let endpoint = format!("/v1/projects/{}/evaluation-capabilities", f.project);
    let app = router(f.state.clone());
    for (token, expected_write) in [("writer", true), ("reader", false), ("rotated", true)] {
        let (s, h, value) = call(&app, "GET", &endpoint, token, &Value::Null, "read", false).await;
        assert_eq!(s, StatusCode::OK, "{value}");
        assert_eq!(h["cache-control"], "private, no-store");
        assert_eq!(value["writeEvaluation"], expected_write);
        assert_eq!(value["retainedEvaluationOperations"], true);
        assert_eq!(value["readUnpublished"], true);
        // Additive: rights, credential kind, abandonment policy, run labels and policy pins.
        assert_eq!(value.as_object().unwrap().len(), 12);
        assert_eq!(value["policyPins"], true);
        assert_eq!(value["rights"]["evaluate"], expected_write);
        assert_eq!(value["rights"]["promote"], token == "writer");
        assert_eq!(value["credential"], json!({"kind": "static"}));
        assert_eq!(value["runLabels"], true);
        assert!(!value.to_string().contains("rotated"));
    }
    for (token, expected) in [
        ("no-read", StatusCode::FORBIDDEN),
        ("invalid", StatusCode::UNAUTHORIZED),
    ] {
        assert_eq!(
            call(&app, "GET", &endpoint, token, &Value::Null, "read", false)
                .await
                .0,
            expected
        );
    }
    let user = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'dx',$2)")
        .bind(user)
        .bind(user.to_string())
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'viewer')")
        .bind(&f.project)
        .bind(user)
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO browser_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(user).bind(format!("sha256:{}",hex::encode(Sha256::digest(secret.as_bytes())))).execute(&f.state.db).await.unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&endpoint)
                .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
                .header("x-acclimate-session", &secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "machine_principal_required");
    let observations = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v1/projects/{}/integration-observations",
                    f.project
                ))
                .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
                .header("x-acclimate-session", &secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        observations.status(),
        StatusCode::OK,
        "viewer can discover safe observations"
    );
    let credential = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/projects/{}/integrations/{}/credentials",
                    f.project,
                    Uuid::new_v4()
                ))
                .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
                .header("x-acclimate-session", &secret)
                .header("content-type", "application/json")
                .header("idempotency-key", Uuid::new_v4().to_string())
                .body(Body::from(r#"{"kind":"content-read"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        credential.status(),
        StatusCode::FORBIDDEN,
        "safe observation access never grants credential administration"
    );
    for (project, uri_project, principal) in [
        ("x".repeat(129), "x".repeat(129), "worker".to_owned()),
        ("dx-δ".into(), "dx-%CE%B4".into(), "worker".to_owned()),
        (".".into(), ".".into(), "worker".to_owned()),
        ("dx/slash".into(), "dx%2Fslash".into(), "worker".to_owned()),
        (
            format!("long-principal-{}", Uuid::new_v4()),
            String::new(),
            "z".repeat(1025),
        ),
    ] {
        let uri_project = if uri_project.is_empty() {
            project.clone()
        } else {
            uri_project
        };
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
            .bind(&project)
            .execute(&f.state.db)
            .await
            .unwrap();
        f.state.grants = Arc::new(vec![Grant {
            token: "unsupported".into(),
            principal_id: principal,
            project_id: project,
            rights: vec!["read".into(), "write".into()],
        }]);
        let (s, _, v) = call(
            &router(f.state.clone()),
            "GET",
            &format!("/v1/projects/{uri_project}/evaluation-capabilities"),
            "unsupported",
            &Value::Null,
            "read",
            false,
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
        assert_eq!(v["error"]["code"], "guided_target_unsupported");
        let denied_write = call(
            &router(f.state.clone()),
            "POST",
            &format!(
                "/v1/projects/{uri_project}/bundles/{}/comparisons",
                f.bundle
            ),
            "unsupported",
            &report(&f, &Uuid::new_v4().to_string(), &Uuid::new_v4().to_string()),
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        assert_eq!(
            denied_write.0,
            StatusCode::BAD_REQUEST,
            "{}",
            denied_write.2
        );
        assert_eq!(denied_write.2["error"]["code"], "guided_target_unsupported");
    }
    f.state.grants = Arc::new(vec![Grant {
        token: "absent".into(),
        principal_id: "worker".into(),
        project_id: "missing-project".into(),
        rights: vec!["read".into(), "write".into()],
    }]);
    assert_eq!(
        call(
            &router(f.state.clone()),
            "GET",
            "/v1/projects/missing-project/evaluation-capabilities",
            "absent",
            &Value::Null,
            "read",
            false
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    f.state.db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn retained_evaluator_results_survive_expiry_and_require_current_authority() {
    let f = fixture().await;
    let app = router(f.state.clone());
    let (path, id) = request(&f, &app).await;
    let attempt = Uuid::new_v4().to_string();
    let start_key = Uuid::new_v4().to_string();
    let start = json!({"attemptId":attempt});
    let first = call(
        &app,
        "POST",
        &format!("{path}/start"),
        "writer",
        &start,
        &start_key,
        true,
    )
    .await;
    assert_eq!(first.0, StatusCode::OK, "{}", first.2);
    let comparison_path = format!(
        "/v1/projects/{}/bundles/{}/comparisons",
        f.project, f.bundle
    );
    let submit_key = Uuid::new_v4().to_string();
    let report = report(&f, &id, &attempt);
    let unsupported_route =
        comparison_path.replace(&f.bundle.to_string(), &f.bundle.simple().to_string());
    let unsupported = call(
        &app,
        "POST",
        &unsupported_route,
        "writer",
        &report,
        &Uuid::new_v4().to_string(),
        true,
    )
    .await;
    assert_eq!(unsupported.0, StatusCode::BAD_REQUEST);
    assert_eq!(unsupported.2["error"]["code"], "guided_target_unsupported");
    let submitted = call(
        &app,
        "POST",
        &comparison_path,
        "writer",
        &report,
        &submit_key,
        true,
    )
    .await;
    assert_eq!(submitted.0, StatusCode::CREATED, "{}", submitted.2);
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 minute' WHERE project_id=$1")
        .bind(&f.project)
        .execute(&f.state.db)
        .await
        .unwrap();
    let repeated = call(
        &app,
        "POST",
        &comparison_path,
        "rotated",
        &report,
        &submit_key,
        false,
    )
    .await;
    assert_eq!(repeated.0, StatusCode::CREATED, "{}", repeated.2);
    assert_eq!(
        repeated.2, submitted.2,
        "unmarked same-principal rotation must recover retained result"
    );
    let lookup = format!(
        "/v1/projects/{}/operations/{submit_key}?operationPath={comparison_path}",
        f.project
    );
    let recovered = call(&app, "GET", &lookup, "rotated", &Value::Null, "read", false).await;
    assert_eq!(recovered.0, StatusCode::OK, "{}", recovered.2);
    assert_eq!(recovered.2["result"], submitted.2);
    let mut changed = report.clone();
    changed["results"][0]["candidate"]["reward"] = json!(0);
    assert_eq!(
        call(
            &app,
            "POST",
            &comparison_path,
            "writer",
            &changed,
            &submit_key,
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let closed_key = Uuid::new_v4().to_string();
    let close_path = format!("/v1/projects/{}/operations/{closed_key}/close", f.project);
    let closed = call(
        &app,
        "POST",
        &close_path,
        "writer",
        &json!({"operationPath":comparison_path}),
        &closed_key,
        false,
    )
    .await;
    assert_eq!(closed.0, StatusCode::OK, "{}", closed.2);
    assert_eq!(closed.2["status"], "closed");
    let blocked = call(
        &app,
        "POST",
        &comparison_path,
        "writer",
        &report,
        &closed_key,
        false,
    )
    .await;
    assert_eq!(blocked.0, StatusCode::CONFLICT);
    assert_eq!(blocked.2["error"]["code"], "operation_closed");
    let finish_key = Uuid::new_v4().to_string();
    let finish = json!({"attemptId":attempt,"comparisonId":submitted.2["id"]});
    let finished = call(
        &app,
        "POST",
        &format!("{path}/finish"),
        "writer",
        &finish,
        &finish_key,
        true,
    )
    .await;
    assert_eq!(finished.0, StatusCode::OK, "{}", finished.2);
    assert_eq!(finished.2["status"], "completed");
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 minute' WHERE project_id=$1")
        .bind(&f.project)
        .execute(&f.state.db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/finish"),
            "rotated",
            &finish,
            &finish_key,
            false
        )
        .await
        .2,
        finished.2
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM comparisons WHERE project_id=$1")
        .bind(&f.project)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let mut denied = f.state.clone();
    denied.grants = Arc::new(vec![Grant {
        token: "writer".into(),
        principal_id: "worker".into(),
        project_id: f.project.clone(),
        rights: vec!["read".into()],
    }]);
    let denied = router(denied);
    assert_eq!(
        call(
            &denied,
            "POST",
            &comparison_path,
            "writer",
            &report,
            &submit_key,
            true
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &denied,
            "GET",
            &lookup,
            "writer",
            &Value::Null,
            "read",
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    f.state.db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn retained_start_is_historical_and_interruption_blocks_new_evidence() {
    let f = fixture().await;
    let app = router(f.state.clone());
    let (path, id) = request(&f, &app).await;
    let attempt = Uuid::new_v4().to_string();
    let key = Uuid::new_v4().to_string();
    let start = json!({"attemptId":attempt});
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/start"),
            "writer",
            &start,
            &key,
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let interrupt_key = Uuid::new_v4().to_string();
    let interruption = json!({"reason":"inspect original worker"});
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/interrupt"),
            "writer",
            &interruption,
            &interrupt_key,
            true
        )
        .await
        .2["status"],
        "interrupted"
    );
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 minute' WHERE project_id=$1")
        .bind(&f.project)
        .execute(&f.state.db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/start"),
            "writer",
            &start,
            &key,
            true
        )
        .await
        .2["status"],
        "running",
        "operation result remains historical"
    );
    assert_eq!(
        call(&app, "GET", &path, "reader", &Value::Null, "read", false)
            .await
            .2["status"],
        "interrupted",
        "current request is authoritative"
    );
    let comparison_path = format!(
        "/v1/projects/{}/bundles/{}/comparisons",
        f.project, f.bundle
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &comparison_path,
            "writer",
            &report(&f, &id, &attempt),
            &Uuid::new_v4().to_string(),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/interrupt"),
            "rotated",
            &interruption,
            &interrupt_key,
            false
        )
        .await
        .2["status"],
        "interrupted"
    );
    f.state.db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn maximum_report_and_retained_response_wrappers_fit_the_response_budget() {
    let f = fixture().await;
    let app = router(f.state.clone());
    let (path, id) = request(&f, &app).await;
    let attempt = Uuid::new_v4().to_string();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/start"),
            "writer",
            &json!({"attemptId":attempt}),
            &Uuid::new_v4().to_string(),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut body = report(&f, &id, &attempt);
    body["results"][0]["parent"]["outputRef"] = json!("");
    let padding = 2 * 1024 * 1024 - body.to_string().len();
    body["results"][0]["parent"]["outputRef"] = json!("x".repeat(padding));
    assert_eq!(body.to_string().len(), 2 * 1024 * 1024);
    let route = format!(
        "/v1/projects/{}/bundles/{}/comparisons",
        f.project, f.bundle
    );
    let key = Uuid::new_v4().to_string();
    let (status, _, comparison) = call(&app, "POST", &route, "writer", &body, &key, true).await;
    assert_eq!(status, StatusCode::CREATED, "{}", comparison["error"]);
    assert!(comparison.to_string().len() > 2 * 1024 * 1024);
    assert!(comparison.to_string().len() < 4 * 1024 * 1024);
    let get = call(
        &app,
        "GET",
        &format!("{route}/{}", comparison["id"].as_str().unwrap()),
        "reader",
        &Value::Null,
        "read",
        false,
    )
    .await;
    assert_eq!(get.0, StatusCode::OK);
    assert_eq!(get.2, comparison);
    let operation = call(
        &app,
        "GET",
        &format!(
            "/v1/projects/{}/operations/{key}?operationPath={route}",
            f.project
        ),
        "writer",
        &Value::Null,
        "read",
        false,
    )
    .await;
    assert_eq!(operation.0, StatusCode::OK);
    assert_eq!(operation.2["result"], comparison);
    assert!(operation.2.to_string().len() < 4 * 1024 * 1024);
    body["results"][0]["parent"]["outputRef"] = json!("x".repeat(padding + 1));
    assert_eq!(
        call(
            &app,
            "POST",
            &route,
            "writer",
            &body,
            &Uuid::new_v4().to_string(),
            true
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    f.state.db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn finish_interrupt_race_has_one_current_terminal_state() {
    let f = fixture().await;
    let app = router(f.state.clone());
    for _ in 0..4 {
        let (path, id) = request(&f, &app).await;
        let attempt = Uuid::new_v4().to_string();
        call(
            &app,
            "POST",
            &format!("{path}/start"),
            "writer",
            &json!({"attemptId":attempt}),
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        let route = format!(
            "/v1/projects/{}/bundles/{}/comparisons",
            f.project, f.bundle
        );
        let submitted = call(
            &app,
            "POST",
            &route,
            "writer",
            &report(&f, &id, &attempt),
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        assert_eq!(submitted.0, StatusCode::CREATED);
        let finish_path = format!("{path}/finish");
        let interrupt_path = format!("{path}/interrupt");
        let finish_body = json!({"attemptId":attempt,"comparisonId":submitted.2["id"]});
        let interrupt_body = json!({"reason":"operator inspected external work"});
        let finish_key = Uuid::new_v4().to_string();
        let interrupt_key = Uuid::new_v4().to_string();
        let (finish, interrupt) = tokio::join!(
            call(
                &app,
                "POST",
                &finish_path,
                "writer",
                &finish_body,
                &finish_key,
                true
            ),
            call(
                &app,
                "POST",
                &interrupt_path,
                "writer",
                &interrupt_body,
                &interrupt_key,
                true
            )
        );
        assert!(
            matches!(
                (finish.0, interrupt.0),
                (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
            ),
            "finish={} interrupt={}",
            finish.2,
            interrupt.2
        );
        let current = call(&app, "GET", &path, "reader", &Value::Null, "read", false)
            .await
            .2;
        if finish.0 == StatusCode::OK {
            assert_eq!(current["status"], "completed");
            assert_eq!(current["comparisonId"], submitted.2["id"]);
        } else {
            assert_eq!(current["status"], "interrupted");
            assert!(current["comparisonId"].is_null());
        }
    }
    f.state.db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn observations_expose_one_latest_retained_receipt_without_admin_metadata() {
    let f = fixture().await;
    let app = router(f.state.clone());
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)").bind(&f.project).bind(f.bundle).bind(f.parent).execute(&f.state.db).await.unwrap();
    let integration = Uuid::new_v4();
    let empty = Uuid::new_v4();
    for id in [integration, empty] {
        sqlx::query("INSERT INTO integrations(id,project_id,bundle_id,channel,display_name) VALUES($1,$2,$3,'stable','safe name')").bind(id).bind(&f.project).bind(f.bundle).execute(&f.state.db).await.unwrap();
    }
    let now = Utc::now();
    let low = Uuid::from_u128(1);
    let high = Uuid::from_u128(2);
    for (event, version, stage, received, occurred) in [
        (low, f.candidate, "verified", now, now),
        (high, f.parent, "started", now, now - Duration::hours(2)),
        (
            Uuid::new_v4(),
            f.candidate,
            "started",
            now - Duration::days(31),
            now,
        ),
    ] {
        let body = json!({"eventId":event,"stage":stage,"versionId":version,"digest":format!("sha256:{}",if version==f.parent{"a"}else{"b"}.repeat(64)),"occurredAt":occurred,"privateField":"CANARY"});
        sqlx::query("INSERT INTO integration_receipts(integration_id,event_id,project_id,bundle_id,version_id,body,fingerprint,received_at) VALUES($1,$2,$3,$4,$5,$6,'fixture',$7)").bind(integration).bind(event).bind(&f.project).bind(f.bundle).bind(version).bind(body).bind(received).execute(&f.state.db).await.unwrap();
    }
    let endpoint = format!("/v1/projects/{}/integration-observations", f.project);
    let (s, _, v) = call(
        &app,
        "GET",
        &endpoint,
        "reader",
        &Value::Null,
        "read",
        false,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    let item = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == integration.to_string())
        .unwrap();
    assert_eq!(item["latestObservation"]["eventId"], high.to_string());
    assert_eq!(item["latestObservation"]["versionId"], f.parent.to_string());
    assert_eq!(item["latestObservation"]["stage"], "started");
    assert_ne!(
        item["latestObservation"]["occurredAt"],
        item["latestObservation"]["receivedAt"]
    );
    assert!(!v.to_string().contains("CANARY"));
    assert!(!v.to_string().contains("credential"));
    assert!(
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == empty.to_string() && x["latestObservation"].is_null())
    );
    let page = call(
        &app,
        "GET",
        &format!("{endpoint}?limit=1"),
        "reader",
        &Value::Null,
        "read",
        false,
    )
    .await
    .2;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let cursor = page["nextCursor"].as_str().unwrap();
    let next = call(
        &app,
        "GET",
        &format!("{endpoint}?limit=1&cursor={cursor}"),
        "reader",
        &Value::Null,
        "read",
        false,
    )
    .await
    .2;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{endpoint}?limit=0"),
            "reader",
            &Value::Null,
            "read",
            false
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/v1/projects/{}/integrations", f.project),
            "reader",
            &Value::Null,
            "read",
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    f.state.db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn marked_evaluator_mutations_require_canonical_body_identities() {
    let f = fixture().await;
    let app = router(f.state.clone());
    let collection = format!(
        "/v1/projects/{}/bundles/{}/evaluation-requests",
        f.project, f.bundle
    );
    for field in ["parentVersionId", "candidateVersionId", "proposalId"] {
        let mut noncanonical = identity(&f);
        noncanonical[field] = json!(f.parent.simple().to_string());
        let response = call(
            &app,
            "POST",
            &collection,
            "writer",
            &noncanonical,
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        assert_eq!(
            response.0,
            StatusCode::BAD_REQUEST,
            "marked request accepted noncanonical identity: {}",
            response.2
        );
        assert_eq!(response.2["error"]["code"], "guided_target_unsupported");
    }

    let (path, id) = request(&f, &app).await;
    for attempt in [
        "not-a-uuid".to_owned(),
        Uuid::new_v4().simple().to_string(),
        "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF".into(),
    ] {
        let response = call(
            &app,
            "POST",
            &format!("{path}/start"),
            "writer",
            &json!({"attemptId":attempt}),
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        assert_eq!(
            response.0,
            StatusCode::BAD_REQUEST,
            "marked start accepted noncanonical attempt: {}",
            response.2
        );
        assert_eq!(response.2["error"]["code"], "guided_target_unsupported");
    }
    assert_eq!(
        call(&app, "GET", &path, "reader", &Value::Null, "read", false)
            .await
            .2["status"],
        "requested"
    );
    for field in ["attemptId", "comparisonId"] {
        let mut finish = json!({"attemptId":Uuid::new_v4(),"comparisonId":Uuid::new_v4()});
        finish[field] = json!("not-a-uuid");
        let response = call(
            &app,
            "POST",
            &format!("{path}/finish"),
            "writer",
            &finish,
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        assert_eq!(response.0, StatusCode::BAD_REQUEST);
        assert_eq!(response.2["error"]["code"], "guided_target_unsupported");
    }
    let comparisons = format!(
        "/v1/projects/{}/bundles/{}/comparisons",
        f.project, f.bundle
    );
    for field in ["requestId", "attemptId"] {
        let mut report = report(&f, &id, &Uuid::new_v4().to_string());
        report["evaluation"][field] = json!("not-a-uuid");
        let response = call(
            &app,
            "POST",
            &comparisons,
            "writer",
            &report,
            &Uuid::new_v4().to_string(),
            true,
        )
        .await;
        assert_eq!(response.0, StatusCode::BAD_REQUEST);
        assert_eq!(response.2["error"]["code"], "guided_target_unsupported");
    }
    // Historical low-level clients keep their existing attempt-ID contract.
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/start"),
            "writer",
            &json!({"attemptId":"legacy-attempt"}),
            &Uuid::new_v4().to_string(),
            false,
        )
        .await
        .0,
        StatusCode::OK
    );
    f.state.db.close().await;
}
