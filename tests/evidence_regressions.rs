//! Evaluation evidence and chronology checks; only the explicit isolated test database is used.
mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{collections::HashSet, sync::Arc};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
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
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2_097_152).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
struct Fixture {
    db: PgPool,
    app: axum::Router,
    project: String,
    bundle: Uuid,
    root: String,
    identity: Value,
}
async fn fixture() -> Fixture {
    let url = common::database_url();
    let db = PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("evidence-{}", Uuid::new_v4());
    let bundle = Uuid::new_v4();
    let parent = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'evidence')")
        .bind(bundle)
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    for (id, base, digest) in [
        (parent, None, "parent"),
        (candidate, Some(parent), "candidate"),
    ] {
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,'fixture-author')").bind(id).bind(&project).bind(bundle).bind(base).bind(digest).bind(b"{}".to_vec()).execute(&db).await.unwrap();
    }
    let grants = [("one", "evaluator-one"), ("two", "evaluator-two")]
        .into_iter()
        .map(|(token, principal)| Grant {
            token: token.into(),
            principal_id: principal.into(),
            project_id: project.clone(),
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
    let root = format!("/v1/workspaces/{project}/bundles/{bundle}");
    let identity = json!({"parentVersionId":parent,"parentDigest":"parent","candidateVersionId":candidate,"candidateDigest":"candidate","datasetRevision":"dataset-v1","runtime":{"configId":"app","configRevision":"opaque-1","model":"none"},"graderRevision":"grader-v1","expectedCases":[{"caseId":"a","repetition":0}]});
    Fixture {
        db,
        app,
        project,
        bundle,
        root,
        identity,
    }
}
async fn request(f: &Fixture) -> Value {
    let identity = f.identity.clone();
    let (s, e) = call(
        &f.app,
        "POST",
        &format!("{}/evaluation-requests", f.root),
        "one",
        identity,
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    let (s, v) = call(
        &f.app,
        "POST",
        &format!(
            "{}/evaluation-requests/{}/start",
            f.root,
            e["id"].as_str().unwrap()
        ),
        "one",
        json!({"attemptId":"attempt-1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    e
}
fn report(f: &Fixture, e: Option<&Value>) -> Value {
    let mut body = f.identity.clone();
    // A complete losing candidate still completes the experiment.
    body["results"] = json!([{"caseId":"a","repetition":0,"parent":{"executionStatus":"completed","gradingStatus":"scored","reward":1},"candidate":{"executionStatus":"completed","gradingStatus":"scored","reward":0}}]);
    if let Some(e) = e {
        body["evaluation"] = json!({"requestId":e["id"],"attemptId":"attempt-1"});
    }
    body
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn evaluation_completion_requires_matching_bound_evidence() {
    let f = fixture().await;
    let e = request(&f).await;
    let e2 = request(&f).await;
    let reports = format!("{}/comparisons", f.root);
    let finish = format!(
        "{}/evaluation-requests/{}/finish",
        f.root,
        e["id"].as_str().unwrap()
    );
    for (token, field, value, status) in [
        (
            "two",
            "evaluation",
            json!({"requestId":e["id"],"attemptId":"attempt-1"}),
            StatusCode::CONFLICT,
        ),
        (
            "one",
            "evaluation",
            json!({"requestId":e["id"],"attemptId":"other"}),
            StatusCode::CONFLICT,
        ),
        (
            "one",
            "runtime",
            json!({"configId":"different"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "one",
            "evaluation",
            json!({"requestId":e["id"]}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let mut body = report(&f, Some(&e));
        body[field] = value;
        let (s, v) = call(&f.app, "POST", &reports, token, body).await;
        assert_eq!(s, status, "{v}");
    }
    let (s, unbound) = call(&f.app, "POST", &reports, "one", report(&f, None)).await;
    assert_eq!(s, StatusCode::CREATED, "{unbound}");
    assert!(unbound.get("evaluation").is_none());
    let (s, v) = call(
        &f.app,
        "POST",
        &finish,
        "one",
        json!({"attemptId":"attempt-1","comparisonId":unbound["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, foreign) = call(&f.app, "POST", &reports, "one", report(&f, Some(&e2))).await;
    assert_eq!(s, StatusCode::CREATED, "{foreign}");
    let (s, v) = call(
        &f.app,
        "POST",
        &finish,
        "one",
        json!({"attemptId":"attempt-1","comparisonId":foreign["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    let (s, bound) = call(&f.app, "POST", &reports, "one", report(&f, Some(&e))).await;
    assert_eq!(s, StatusCode::CREATED, "{bound}");
    let (s, v) = call(
        &f.app,
        "POST",
        &finish,
        "one",
        json!({"attemptId":"attempt-1","comparisonId":bound["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "completed");
    assert_eq!(v["requireBoundEvidence"], true);
    let mut disabled = f.identity.clone();
    disabled["requireBoundEvidence"] = json!(false);
    let (status, error) = call(
        &f.app,
        "POST",
        &format!("{}/evaluation-requests", f.root),
        "one",
        disabled,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn bound_submission_and_interrupt_share_the_request_lock() {
    let f = fixture().await;
    let e = request(&f).await;
    let id = Uuid::parse_str(e["id"].as_str().unwrap()).unwrap();
    let mut tx = f.db.begin().await.unwrap();
    sqlx::query("SELECT id FROM evaluation_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let app = f.app.clone();
    let root = f.root.clone();
    let body = report(&f, Some(&e));
    let submit = tokio::spawn(async move {
        call(&app, "POST", &format!("{root}/comparisons"), "one", body).await
    });
    let app = f.app.clone();
    let root = f.root.clone();
    let interrupt = tokio::spawn(async move {
        call(
            &app,
            "POST",
            &format!("{root}/evaluation-requests/{id}/interrupt"),
            "two",
            json!({"reason":"stop"}),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert!(!submit.is_finished());
    assert!(!interrupt.is_finished());
    tx.commit().await.unwrap();
    let (s, c) = submit.await.unwrap();
    let (s2, v) = interrupt.await.unwrap();
    assert_eq!(s2, StatusCode::OK, "{v}");
    assert!(s == StatusCode::CREATED || s == StatusCode::CONFLICT, "{c}");
    if s == StatusCode::CREATED {
        let (s, v) = call(
            &f.app,
            "POST",
            &format!("{}/evaluation-requests/{id}/finish", f.root),
            "one",
            json!({"attemptId":"attempt-1","comparisonId":c["id"]}),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT, "{v}");
        assert_eq!(
            call(
                &f.app,
                "GET",
                &format!("{}/comparisons/{}", f.root, c["id"].as_str().unwrap()),
                "one",
                Value::Null
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{}/comparisons", f.root),
            "one",
            report(&f, Some(&e))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn chronological_pages_cover_thirty_rows_ties_microseconds_and_scoped_cursors() {
    let f = fixture().await;
    for index in 0..31 {
        let id = Uuid::new_v4();
        let micros = index / 3;
        sqlx::query("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status,created_at) VALUES($1,$2,$3,$4,'one','requested','2026-11-14T12:00:00.123450Z'::timestamptz + $5 * interval '1 microsecond')").bind(id).bind(&f.project).bind(f.bundle).bind(&f.identity).bind(micros).execute(&f.db).await.unwrap();
        sqlx::query("INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter,created_at) VALUES($1,$2,$3,$4,true,'one','2026-11-14T12:00:00.123450Z'::timestamptz + $5 * interval '1 microsecond')").bind(id).bind(&f.project).bind(f.bundle).bind(report(&f,None)).bind(micros).execute(&f.db).await.unwrap();
        sqlx::query("INSERT INTO proposals(id,project_id,bundle_id,parent_version_id,request,status,requested_by,created_at) VALUES($1,$2,$3,$4,'{}','queued','one','2026-11-14T12:00:00.123450Z'::timestamptz + $5 * interval '1 microsecond')").bind(id).bind(&f.project).bind(f.bundle).bind(Uuid::parse_str(f.identity["parentVersionId"].as_str().unwrap()).unwrap()).bind(micros).execute(&f.db).await.unwrap();
    }
    for table in ["evaluation_requests", "comparisons", "proposals"] {
        let route = table.replace('_', "-");
        for limit in [-1, 0, 101] {
            let (status, error) = call(
                &f.app,
                "GET",
                &format!("{}/{route}?limit={limit}", f.root),
                "one",
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
            assert_eq!(error["error"]["code"], "invalid_content");
            assert_eq!(error["error"]["message"], "Limit must be between 1 and 100");
        }
        // Extractor rejections use a text response, unlike domain errors above.
        let unknown_field = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("{}/{route}?unexpected=true", f.root))
                    .header("authorization", "Bearer one")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown_field.status(), StatusCode::BAD_REQUEST);
        let sql = format!(
            "SELECT id FROM {table} WHERE project_id=$1 AND bundle_id=$2 ORDER BY created_at DESC,id DESC"
        );
        let expected = sqlx::query(&sql)
            .bind(&f.project)
            .bind(f.bundle)
            .fetch_all(&f.db)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.get::<Uuid, _>("id").to_string())
            .collect::<Vec<_>>();
        let mut cursor = None;
        let mut observed = Vec::new();
        let mut first_cursor = None;
        loop {
            let path = format!(
                "{}/{}?limit=7{}",
                f.root,
                route,
                cursor
                    .as_ref()
                    .map(|c| format!("&cursor={c}"))
                    .unwrap_or_default()
            );
            let (s, page) = call(&f.app, "GET", &path, "one", Value::Null).await;
            assert_eq!(s, StatusCode::OK, "{page}");
            observed.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v["id"].as_str().unwrap().to_owned()),
            );
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if first_cursor.is_none() {
                first_cursor = cursor.clone();
            }
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(observed, expected);
        assert_eq!(observed.iter().collect::<HashSet<_>>().len(), 31);
        let other_bundle = f
            .root
            .replace(&f.bundle.to_string(), &Uuid::new_v4().to_string());
        assert_eq!(
            call(
                &f.app,
                "GET",
                &format!(
                    "{other_bundle}/{route}?cursor={}",
                    first_cursor.as_ref().unwrap()
                ),
                "one",
                Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let other = if route == "comparisons" {
            "evaluation-requests"
        } else {
            "comparisons"
        };
        assert_eq!(
            call(
                &f.app,
                "GET",
                &format!("{}/{}?cursor={}", f.root, other, first_cursor.unwrap()),
                "one",
                Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &f.app,
                "GET",
                &format!("{}/{}?cursor={}", f.root, route, expected[6]),
                "one",
                Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}
