mod common;
use acclimate_service::{AccessConfig, AppState, Grant, OperatorIdentity, RuntimeStatus, router};
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
    bearer: &str,
    session: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json");
    if let Some(session) = session {
        request = request.header("x-acclimate-session", session);
    }
    // Supplied trusted headers must have no effect.
    request = request
        .header("x-acclimate-trusted-user", Uuid::new_v4().to_string())
        .header("x-acclimate-trusted-session", Uuid::new_v4().to_string())
        .header("x-acclimate-trusted-role", "admin");
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
fn state(db: sqlx::PgPool, project: String) -> AppState {
    let grants = vec![Grant {
        token: "production-machine".into(),
        principal_id: "original-machine".into(),
        project_id: project,
        rights: vec!["read".into(), "write".into()],
    }];
    let access = AccessConfig::new(
        common::ISSUER.into(),
        common::LOGIN_TOKEN.into(),
        common::CONSOLE_TOKEN.into(),
        ["operator", "other-operator"]
            .into_iter()
            .map(|subject| OperatorIdentity {
                issuer: common::ISSUER.into(),
                subject: subject.into(),
            })
            .collect(),
        &grants,
    )
    .unwrap();
    AppState {
        db,
        grants: Arc::new(grants),
        access: Arc::new(access),
        runtime: Arc::new(RuntimeStatus::new()),
        provider: None,
    }
}
async fn fixture() -> Option<(sqlx::PgPool, AppState, String)> {
    let url = std::env::var("ACCLIMATE_TEST_DATABASE_URL").ok()?;
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("production-{}", Uuid::new_v4());
    Some((db.clone(), state(db, project.clone()), project))
}
async fn login(app: &axum::Router, subject: &str, previous: Option<&str>) -> Value {
    let result = call(
        app,
        "POST",
        "/v1/auth/sessions",
        common::LOGIN_TOKEN,
        previous,
        json!({"issuer":common::ISSUER,"subject":subject}),
    )
    .await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    result.1
}
#[tokio::test]
async fn transport_is_classified_before_any_session_lookup() {
    let app = router(state(
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap(),
        "unregistered".into(),
    ));
    for bearer in ["wrong", "production-machine", common::LOGIN_TOKEN] {
        let response = call(
            &app,
            "DELETE",
            "/v1/auth/session",
            bearer,
            Some("unknown"),
            json!(null),
        )
        .await;
        assert_eq!(response.0, StatusCode::UNAUTHORIZED);
        assert_eq!(response.1["error"]["code"], "invalid_console_transport");
    }
    let missing = call(
        &app,
        "GET",
        "/v1/auth/session",
        common::CONSOLE_TOKEN,
        None,
        json!(null),
    )
    .await;
    assert_eq!(missing.1["error"]["code"], "invalid_session");
    let impersonation = call(
        &app,
        "GET",
        "/v1/projects/unregistered/bundles",
        common::CONSOLE_TOKEN,
        None,
        json!(null),
    )
    .await;
    assert_eq!(impersonation.1["error"]["code"], "invalid_session");
}
#[tokio::test]
async fn exact_issuer_account_switch_revocation_and_typed_logout() {
    let Some((_db, s, _p)) = fixture().await else {
        return;
    };
    let app = router(s);
    let invalid = call(
        &app,
        "POST",
        "/v1/auth/sessions",
        common::LOGIN_TOKEN,
        None,
        json!({"issuer":"https://other.example","subject":"operator"}),
    )
    .await;
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    let first = login(&app, "operator", None).await;
    let second = login(&app, "ordinary-user", first["secret"].as_str()).await;
    assert_ne!(first["userId"], second["userId"]);
    let old = call(
        &app,
        "GET",
        "/v1/auth/session",
        common::CONSOLE_TOKEN,
        first["secret"].as_str(),
        json!(null),
    )
    .await;
    assert_eq!(old.1["error"]["code"], "invalid_session");
    let session = call(
        &app,
        "GET",
        "/v1/auth/session",
        common::CONSOLE_TOKEN,
        second["secret"].as_str(),
        json!(null),
    )
    .await;
    assert_eq!(session.0, StatusCode::OK);
    assert_eq!(session.1["canCreateWorkspace"], false);
    assert_eq!(
        call(
            &app,
            "DELETE",
            "/v1/auth/session",
            common::CONSOLE_TOKEN,
            second["secret"].as_str(),
            json!(null)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            "/v1/auth/session",
            common::CONSOLE_TOKEN,
            second["secret"].as_str(),
            json!(null)
        )
        .await
        .1["error"]["code"],
        "invalid_session"
    );
}
#[tokio::test]
async fn adoption_is_explicit_serialized_immutable_and_never_regrants() {
    let Some((db, s, p)) = fixture().await else {
        return;
    };
    acclimate_service::backfill_projects(&s).await.unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM project_memberships WHERE project_id=$1")
            .bind(&p)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        count, 0,
        "startup registration must never create human ownership"
    );
    let app = router(s);
    let a = login(&app, "operator", None).await;
    let b = login(&app, "other-operator", None).await;
    let ordinary = login(&app, "ordinary-user", None).await;
    let adopt = json!({"projectId":p,"reason":"Reviewed cutover ownership"});
    assert_eq!(
        call(
            &app,
            "POST",
            "/v1/auth/workspace-adoptions",
            common::CONSOLE_TOKEN,
            ordinary["secret"].as_str(),
            adopt.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (one, two) = tokio::join!(
        call(
            &app,
            "POST",
            "/v1/auth/workspace-adoptions",
            common::CONSOLE_TOKEN,
            a["secret"].as_str(),
            adopt.clone()
        ),
        call(
            &app,
            "POST",
            "/v1/auth/workspace-adoptions",
            common::CONSOLE_TOKEN,
            b["secret"].as_str(),
            adopt.clone()
        )
    );
    let (winner, success, loser) = if one.0 == StatusCode::OK {
        (&a, &one, &two)
    } else {
        (&b, &two, &one)
    };
    assert_eq!(success.0, StatusCode::OK, "{}", success.1);
    assert_eq!(success.1["alreadyAdopted"], false);
    assert_eq!(success.1["currentRole"], "admin");
    assert_eq!(loser.0, StatusCode::CONFLICT);
    let winner_id = Uuid::parse_str(winner["userId"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2")
        .bind(&p)
        .bind(winner_id)
        .execute(&db)
        .await
        .unwrap();
    let retry = call(
        &app,
        "POST",
        "/v1/auth/workspace-adoptions",
        common::CONSOLE_TOKEN,
        winner["secret"].as_str(),
        json!({"projectId":p,"reason":"Must not replace original"}),
    )
    .await;
    assert_eq!(retry.0, StatusCode::OK);
    assert_eq!(retry.1["reason"], success.1["reason"]);
    assert_eq!(retry.1["createdAt"], success.1["createdAt"]);
    assert_eq!(retry.1["alreadyAdopted"], true);
    assert_eq!(retry.1["currentRole"], "viewer");
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(&p)
        .bind(winner_id)
        .execute(&db)
        .await
        .unwrap();
    let removed = call(
        &app,
        "POST",
        "/v1/auth/workspace-adoptions",
        common::CONSOLE_TOKEN,
        winner["secret"].as_str(),
        adopt,
    )
    .await;
    assert_eq!(removed.1["currentRole"], Value::Null);
    assert_eq!(removed.1["alreadyAdopted"], true);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/v1/projects/{p}/bundles"),
            common::CONSOLE_TOKEN,
            winner["secret"].as_str(),
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let machine = call(
        &app,
        "GET",
        &format!("/v1/projects/{p}/bundles"),
        "production-machine",
        None,
        json!(null),
    )
    .await;
    assert_eq!(
        machine.0,
        StatusCode::OK,
        "machine contracts remain scoped and usable"
    );
    let missing = format!("missing-{}", Uuid::new_v4());
    let not_found = call(
        &app,
        "POST",
        "/v1/auth/workspace-adoptions",
        common::CONSOLE_TOKEN,
        winner["secret"].as_str(),
        json!({"projectId":missing,"reason":"explicit"}),
    )
    .await;
    assert_eq!(not_found.0, StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn listing_projects_is_read_only() {
    let Some((db, s, p)) = fixture().await else {
        return;
    };
    let result = call(
        &router(s),
        "GET",
        "/v1/projects",
        "production-machine",
        None,
        json!(null),
    )
    .await;
    assert_eq!(result.0, StatusCode::OK);
    let registered: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)")
        .bind(p)
        .fetch_one(&db)
        .await
        .unwrap();
    assert!(!registered);
}

#[tokio::test]
async fn explicit_prefixed_console_authority_resolves_content_and_rejects_dot_workspaces() {
    let Some((db, mut s, p)) = fixture().await else {
        return;
    };
    let console = "aci_explicit-console-authority";
    s.access = Arc::new(
        AccessConfig::new(
            common::ISSUER.into(),
            common::LOGIN_TOKEN.into(),
            console.into(),
            vec![OperatorIdentity {
                issuer: common::ISSUER.into(),
                subject: "operator".into(),
            }],
            &s.grants,
        )
        .unwrap(),
    );
    acclimate_service::backfill_projects(&s).await.unwrap();
    let app = router(s);
    let identity = login(&app, "operator", None).await;
    let session = identity["secret"].as_str();
    for id in [".", ".."] {
        let result = call(
            &app,
            "POST",
            "/v1/projects",
            console,
            session,
            json!({"id":id,"name":"Unaddressable"}),
        )
        .await;
        assert_eq!(
            result.0,
            StatusCode::BAD_REQUEST,
            "dot-segment workspace ID {id} must be refused: {}",
            result.1
        );
    }
    let user = Uuid::parse_str(identity["userId"].as_str().unwrap()).unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'viewer')")
        .bind(&p)
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'Prefixed transport')")
        .bind(bundle)
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload) VALUES($1,$2,$3,'test-digest',$4)").bind(version).bind(&p).bind(bundle).bind(br#"{"schemaVersion":1,"files":[]}"#.to_vec()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)").bind(&p).bind(bundle).bind(version).execute(&db).await.unwrap();
    for path in [
        format!("/v1/projects/{p}/bundles/{bundle}/channels/stable"),
        format!("/v1/projects/{p}/bundles/{bundle}/versions/{version}"),
        format!("/v1/projects/{p}/bundles/{bundle}/versions/{version}/payload"),
    ] {
        let result = call(&app, "GET", &path, console, session, json!(null)).await;
        assert_eq!(
            result.0,
            StatusCode::OK,
            "immutable console authority must take precedence over integration token prefix: {}",
            result.1
        );
    }
}
