mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn workspace_membership_and_session_revocation() {
    // Explicit isolated test database only; never use a developer/demo DATABASE_URL.
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("access-{}", Uuid::new_v4());
    let other = format!("access-{}", Uuid::new_v4());
    for p in [&project, &other] {
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
            .bind(p)
            .execute(&db)
            .await
            .unwrap();
    }
    let user = Uuid::new_v4();
    let session = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'https://fixture.example',$2)")
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
    use sha2::{Digest, Sha256};
    let hash = format!("sha256:{}", hex::encode(Sha256::digest(secret.as_bytes())));
    sqlx::query("INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(hash).bind(user).execute(&db).await.unwrap();
    let grants = vec![project.clone(), other.clone()]
        .into_iter()
        .map(|project_id| Grant {
            token: "fixture-machine".into(),
            principal_id: "fixture".into(),
            project_id,
            rights: vec!["read".into(), "write".into()],
        })
        .collect();
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        optimizer: None,
        db: db.clone(),
        grants: Arc::new(grants),
    });
    let request = |method: &str, uri: String, session: &str, body: &str| {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
            .header("x-acclimate-session", session)
            .header("content-type", "application/json")
            .header("idempotency-key", Uuid::new_v4().to_string())
            .body(Body::from(body.to_owned()))
            .unwrap()
    };
    let allowed = app
        .clone()
        .oneshot(request(
            "GET",
            format!("/v1/workspaces/{project}/bundles"),
            &secret,
            "",
        ))
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    let denied = app
        .clone()
        .oneshot(request(
            "GET",
            format!("/v1/workspaces/{other}/bundles"),
            &secret,
            "",
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let denied = app
        .clone()
        .oneshot(request(
            "POST",
            format!("/v1/workspaces/{project}/bundles"),
            &secret,
            r#"{"name":"blocked"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let forged = app
        .clone()
        .oneshot(request(
            "GET",
            format!("/v1/workspaces/{project}/bundles"),
            "forged",
            "",
        ))
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE browser_sessions SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
    let expired = app
        .clone()
        .oneshot(request(
            "GET",
            format!("/v1/workspaces/{project}/bundles"),
            &secret,
            "",
        ))
        .await
        .unwrap();
    assert_eq!(expired.status(), StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE browser_sessions SET expires_at=now()+interval '1 hour' WHERE id=$1")
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(&project)
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
    let removed = app
        .clone()
        .oneshot(request(
            "GET",
            format!("/v1/workspaces/{project}/bundles"),
            &secret,
            "",
        ))
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::FORBIDDEN);
    sqlx::query("UPDATE browser_sessions SET revoked_at=now() WHERE id=$1")
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
    let revoked = app
        .oneshot(request(
            "GET",
            format!("/v1/workspaces/{project}/bundles"),
            &secret,
            "",
        ))
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    db.close().await;
}
