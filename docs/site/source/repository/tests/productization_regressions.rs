mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture(max_connections: u32) -> Option<(AppState, String, Vec<(Uuid, String)>)> {
    let url = std::env::var("ACCLIMATE_TEST_DATABASE_URL").ok()?;
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(2))
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("regression-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let mut people = Vec::new();
    for _ in 0..2 {
        let user = Uuid::new_v4();
        let secret = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'fixture',$2)")
            .bind(user)
            .bind(user.to_string())
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin')",
        )
        .bind(&project)
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO browser_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(user).bind(format!("sha256:{}",hex::encode(Sha256::digest(secret.as_bytes())))).execute(&db).await.unwrap();
        people.push((user, secret));
    }
    let state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db,
        grants: Arc::new(vec![Grant {
            token: "aci_machine".into(),
            principal_id: "fixture-operator".into(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
        provider: None,
    };
    Some((state, project, people))
}
fn request(method: &str, path: &str, session: Option<&str>, body: &str) -> Request<Body> {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", "Bearer aci_machine")
        .header("content-type", "application/json")
        .header("idempotency-key", Uuid::new_v4().to_string());
    if let Some(secret) = session {
        r.headers_mut().unwrap().insert(
            "authorization",
            format!("Bearer {}", common::CONSOLE_TOKEN).parse().unwrap(),
        );
        r = r.header("x-acclimate-session", secret)
    }
    r.body(Body::from(body.to_owned())).unwrap()
}
#[tokio::test]
async fn browser_reads_work_with_one_pool_connection_and_machine_prefix_still_works() {
    let Some((state, project, people)) = fixture(1).await else {
        return;
    };
    let app = router(state.clone());
    for path in [
        format!("/v1/projects/{project}/bundles"),
        format!(
            "/v1/projects/{project}/bundles/{}/comparisons",
            Uuid::new_v4()
        ),
    ] {
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            app.clone()
                .oneshot(request("GET", &path, Some(&people[0].1), "")),
        )
        .await
        .expect("a read must not hold one connection while acquiring another")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = app
        .oneshot(request(
            "GET",
            &format!(
                "/v1/projects/{project}/bundles/{}/channels/stable",
                Uuid::new_v4()
            ),
            None,
            "",
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "configured aci_ machine token must reach content lookup"
    );
    state.db.close().await;
}
#[tokio::test]
async fn crossed_admin_updates_do_not_deadlock() {
    let Some((state, project, people)) = fixture(6).await else {
        return;
    };
    let app = router(state.clone());
    for _ in 0..5 {
        let a = app.clone().oneshot(request(
            "PUT",
            &format!("/v1/projects/{project}/memberships/{}", people[1].0),
            Some(&people[0].1),
            r#"{"role":"admin"}"#,
        ));
        let b = app.clone().oneshot(request(
            "PUT",
            &format!("/v1/projects/{project}/memberships/{}", people[0].0),
            Some(&people[1].1),
            r#"{"role":"admin"}"#,
        ));
        let (a, b) = tokio::time::timeout(Duration::from_secs(8), async { tokio::join!(a, b) })
            .await
            .expect("crossed admins must serialize");
        assert_eq!(a.unwrap().status(), StatusCode::NO_CONTENT);
        assert_eq!(b.unwrap().status(), StatusCode::NO_CONTENT);
    }
    state.db.close().await;
}

#[tokio::test]
async fn integration_replay_rechecks_current_administrator_membership() {
    let Some((state, project, people)) = fixture(3).await else {
        return;
    };
    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'integration replay')")
        .bind(bundle)
        .bind(&project)
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO versions(id,project_id,bundle_id,digest,payload) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(version)
    .bind(&project)
    .bind(bundle)
    .bind(format!("sha256:{}", "a".repeat(64)))
    .bind(b"{}".as_slice())
    .execute(&state.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)")
        .bind(&project).bind(bundle).bind(version).execute(&state.db).await.unwrap();
    let app = router(state.clone());
    let path = format!("/v1/projects/{project}/integrations");
    let body =
        serde_json::json!({"displayName":"replay fixture","bundleId":bundle,"channel":"stable"})
            .to_string();
    let key = Uuid::new_v4().to_string();
    let make_request = || {
        let mut request = request("POST", &path, Some(&people[0].1), &body);
        request
            .headers_mut()
            .insert("idempotency-key", key.parse().unwrap());
        request
    };
    let created = app.clone().oneshot(make_request()).await.unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let original_bytes = to_bytes(created.into_body(), 64 * 1024).await.unwrap();

    sqlx::query("UPDATE project_memberships SET role='editor' WHERE project_id=$1 AND user_id=$2")
        .bind(&project)
        .bind(people[0].0)
        .execute(&state.db)
        .await
        .unwrap();
    let denied = app.clone().oneshot(make_request()).await.unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let changed_body =
        serde_json::json!({"displayName":"changed replay","bundleId":bundle,"channel":"stable"})
            .to_string();
    let mut changed_request = request("POST", &path, Some(&people[0].1), &changed_body);
    changed_request
        .headers_mut()
        .insert("idempotency-key", key.parse().unwrap());
    let conflict = app.clone().oneshot(changed_request).await.unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    sqlx::query("UPDATE project_memberships SET role='admin' WHERE project_id=$1 AND user_id=$2")
        .bind(&project)
        .bind(people[0].0)
        .execute(&state.db)
        .await
        .unwrap();
    let replay = app.oneshot(make_request()).await.unwrap();
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(
        to_bytes(replay.into_body(), 64 * 1024).await.unwrap(),
        original_bytes
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM integrations WHERE project_id=$1")
        .bind(&project)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    state.db.close().await;
}
