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
    session: Option<&str>,
    key: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", "Bearer access-fixture")
        .header("idempotency-key", key)
        .header("content-type", "application/json");
    if let Some(session) = session {
        request.headers_mut().unwrap().insert(
            "authorization",
            format!("Bearer {}", common::CONSOLE_TOKEN).parse().unwrap(),
        );
        request = request.header("x-acclimate-session", session);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn user(db: &sqlx::PgPool, project: &str, role: Option<&str>) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO users(id,issuer,subject) VALUES($1,'https://access-remediation.invalid',$2)",
    )
    .bind(id)
    .bind(id.to_string())
    .execute(db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO browser_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(id).bind(format!("sha256:{}",hex::encode(Sha256::digest(secret.as_bytes())))).execute(db).await.unwrap();
    if let Some(role) = role {
        sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,$3)")
            .bind(project)
            .bind(id)
            .bind(role)
            .execute(db)
            .await
            .unwrap();
    }
    (id, secret)
}
async fn fixture() -> (sqlx::PgPool, axum::Router, String) {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("access-remediation-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        optimizer: None,
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "access-fixture".into(),
            principal_id: "access-fixture".into(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
    });
    (db, app, project)
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn final_admin_survives_self_changes_and_crossed_writer_races() {
    let (db, app, p) = fixture().await;
    let (a, sa) = user(&db, &p, Some("admin")).await;
    let base = format!("/v1/workspaces/{p}/memberships");
    for (method, body) in [("DELETE", json!(null)), ("PUT", json!({"role":"editor"}))] {
        let result = call(
            &app,
            method,
            &format!("{base}/{a}"),
            Some(&sa),
            "self",
            body,
        )
        .await;
        assert_eq!(result.0, StatusCode::CONFLICT);
        assert_eq!(result.1["error"]["code"], "last_admin");
    }
    let (b, sb) = user(&db, &p, Some("admin")).await;
    for remove in [false, true] {
        sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(project_id,user_id) DO UPDATE SET role='admin'").bind(&p).bind(a).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(project_id,user_id) DO UPDATE SET role='admin'").bind(&p).bind(b).execute(&db).await.unwrap();
        let method = if remove { "DELETE" } else { "PUT" };
        let pa = format!("{base}/{b}");
        let pb = format!("{base}/{a}");
        let results = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(
                call(
                    &app,
                    method,
                    &pa,
                    Some(&sa),
                    "cross-a",
                    json!({"role":"viewer"})
                ),
                call(
                    &app,
                    method,
                    &pb,
                    Some(&sb),
                    "cross-b",
                    json!({"role":"viewer"})
                )
            )
        })
        .await
        .expect("crossed writers must not deadlock");
        assert_eq!(
            [results.0.0, results.1.0]
                .iter()
                .filter(|s| **s == StatusCode::NO_CONTENT)
                .count(),
            1
        );
        assert_eq!(
            [results.0.0, results.1.0]
                .iter()
                .filter(|s| **s == StatusCode::FORBIDDEN)
                .count(),
            1
        );
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM project_memberships WHERE project_id=$1 AND role='admin'",
        )
        .bind(&p)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }
    // Two administrators can both decide to leave from the same stale page.
    for user in [a, b] {
        sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(project_id,user_id) DO UPDATE SET role='admin'").bind(&p).bind(user).execute(&db).await.unwrap();
    }
    let pa = format!("{base}/{a}");
    let pb = format!("{base}/{b}");
    let results = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            call(&app, "DELETE", &pa, Some(&sa), "leave-a", Value::Null),
            call(&app, "DELETE", &pb, Some(&sb), "leave-b", Value::Null)
        )
    })
    .await
    .expect("self-removal race must not deadlock");
    assert_eq!(
        [results.0.0, results.1.0]
            .iter()
            .filter(|s| **s == StatusCode::NO_CONTENT)
            .count(),
        1
    );
    assert_eq!(
        [results.0.0, results.1.0]
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_memberships WHERE project_id=$1 AND role='admin'",
    )
    .bind(&p)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn bounded_member_pages_and_nullable_current_role_require_browser_admin() {
    let (db, app, p) = fixture().await;
    let (_, sa) = user(&db, &p, Some("admin")).await;
    let (_, sv) = user(&db, &p, Some("viewer")).await;
    let (outsider, _) = user(&db, &p, None).await;
    for _ in 0..27 {
        user(&db, &p, Some("editor")).await;
    }
    let base = format!("/v1/workspaces/{p}");
    for session in [None, Some(sv.as_str())] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("{base}/memberships"),
                session,
                "list",
                Value::Null
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("{base}/users/{outsider}"),
                session,
                "lookup",
                Value::Null
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let first = call(
        &app,
        "GET",
        &format!("{base}/memberships?limit=25"),
        Some(&sa),
        "list",
        Value::Null,
    )
    .await;
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(first.1["items"].as_array().unwrap().len(), 25);
    let cursor = first.1["nextCursor"].as_str().unwrap();
    let second = call(
        &app,
        "GET",
        &format!("{base}/memberships?limit=25&cursor={cursor}"),
        Some(&sa),
        "list",
        Value::Null,
    )
    .await;
    assert_eq!(second.1["items"].as_array().unwrap().len(), 4);
    for row in second.1["items"].as_array().unwrap() {
        assert!(
            !first.1["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|old| old["id"] == row["id"])
        );
    }
    let lookup = call(
        &app,
        "GET",
        &format!("{base}/users/{outsider}"),
        Some(&sa),
        "lookup",
        Value::Null,
    )
    .await;
    assert_eq!(lookup.1["role"], Value::Null);
    let changed = call(
        &app,
        "PUT",
        &format!("{base}/memberships/{outsider}"),
        Some(&sa),
        "add",
        json!({"role":"editor"}),
    )
    .await;
    assert_eq!(changed.0, StatusCode::NO_CONTENT);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{base}/users/{outsider}"),
            Some(&sa),
            "lookup",
            Value::Null
        )
        .await
        .1["role"],
        "editor"
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn lost_issuance_returns_only_typed_original_metadata_and_revocation_state() {
    let (db, app, p) = fixture().await;
    let bundle = Uuid::new_v4();
    let integration = Uuid::new_v4();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'fixture')")
        .bind(bundle)
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    let version = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,'fixture-author')",
    )
    .bind(version)
    .bind(&p)
    .bind(bundle)
    .bind(format!("sha256:{}", "a".repeat(64)))
    .bind(b"{}".as_slice())
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)").bind(&p).bind(bundle).bind(version).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO integrations(id,project_id,bundle_id,channel,display_name) VALUES($1,$2,$3,'stable','Fixture')").bind(integration).bind(&p).bind(bundle).execute(&db).await.unwrap();
    let base = format!("/v1/workspaces/{p}/connections/{integration}/credentials");
    let key = Uuid::new_v4().to_string();
    let issued = call(
        &app,
        "POST",
        &base,
        None,
        &key,
        json!({"kind":"content-read"}),
    )
    .await;
    assert_eq!(issued.0, StatusCode::OK);
    let id = issued.1["id"].as_str().unwrap();
    for revoked in [false, true] {
        if revoked {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &format!("{base}/{id}/revoke"),
                    None,
                    "revoke",
                    Value::Null
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let replay = call(
            &app,
            "POST",
            &base,
            None,
            &key,
            json!({"kind":"content-read"}),
        )
        .await;
        assert_eq!(replay.0, StatusCode::CONFLICT);
        assert_eq!(replay.1["error"]["code"], "credential_already_issued");
        let detail = &replay.1["error"]["details"];
        assert_eq!(detail["credentialId"], id);
        assert_eq!(detail["kind"], "content-read");
        assert_eq!(detail["revokedAt"].is_null(), !revoked);
        assert!(
            !replay
                .1
                .to_string()
                .contains(issued.1["secret"].as_str().unwrap())
        );
        assert_eq!(detail.as_object().unwrap().len(), 3);
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &base,
            None,
            &Uuid::new_v4().to_string(),
            json!({"kind":"content-read"})
        )
        .await
        .0,
        StatusCode::OK
    );
    db.close().await;
}
