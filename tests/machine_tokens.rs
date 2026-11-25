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

/// A bearer is either a machine token or a console session secret.
enum As<'a> {
    Machine(&'a str),
    Browser(&'a str),
}

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    who: As<'_>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("idempotency-key", Uuid::new_v4().to_string())
        .header("content-type", "application/json");
    request = match who {
        As::Machine(token) => request.header("authorization", format!("Bearer {token}")),
        As::Browser(session) => request
            .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
            .header("x-acclimate-session", session),
    };
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
    let bytes = to_bytes(response.into_body(), 2_097_152).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct Fixture {
    db: sqlx::PgPool,
    app: axum::Router,
    project: String,
    other: String,
    bundle: Uuid,
    parent: Uuid,
    candidate: Uuid,
    admin: String,
    editor: String,
}

async fn session(db: &sqlx::PgPool, project: &str, role: &str) -> String {
    let user = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'https://fixture.example',$2)")
        .bind(user)
        .bind(user.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,$3)")
        .bind(project)
        .bind(user)
        .bind(role)
        .execute(db)
        .await
        .unwrap();
    let hash = format!("sha256:{}", hex::encode(Sha256::digest(secret.as_bytes())));
    sqlx::query("INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(hash).bind(user).execute(db).await.unwrap();
    secret
}

async fn fixture() -> Fixture {
    let db = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("tokens-{}", Uuid::new_v4());
    let other = format!("tokens-{}", Uuid::new_v4());
    for p in [&project, &other] {
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
            .bind(p)
            .execute(&db)
            .await
            .unwrap();
    }
    let bundle = Uuid::new_v4();
    let parent = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'token test')")
        .bind(bundle)
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let payload = include_bytes!("../contracts/fixtures/bundle-v1.json").to_vec();
    for (id, base, digest) in [
        (parent, None, "parent"),
        (candidate, Some(parent), "candidate"),
    ] {
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,'fixture-author')")
            .bind(id).bind(&project).bind(bundle).bind(base).bind(digest).bind(&payload).execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)")
        .bind(&project).bind(bundle).bind(parent).execute(&db).await.unwrap();
    let admin = session(&db, &project, "admin").await;
    let editor = session(&db, &project, "editor").await;
    let grants = vec![
        Grant {
            token: "static-reader".into(),
            principal_id: "static-reader".into(),
            project_id: project.clone(),
            rights: vec!["read".into()],
        },
        Grant {
            token: "static-writer".into(),
            principal_id: "static-writer".into(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        },
    ];
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        optimizer: None,
        db: db.clone(),
        grants: Arc::new(grants),
    });
    Fixture {
        db,
        app,
        project,
        other,
        bundle,
        parent,
        candidate,
        admin,
        editor,
    }
}

impl Fixture {
    fn root(&self) -> String {
        format!("/v1/workspaces/{}/bundles/{}", self.project, self.bundle)
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn admins_issue_rotate_and_revoke_read_tokens_without_restart() {
    let f = fixture().await;
    let tokens = format!("/v1/workspaces/{}/machine-tokens", f.project);
    // Only workspace admins administer tokens; machine credentials never do.
    for who in [As::Browser(&f.editor), As::Machine("static-writer")] {
        assert_eq!(
            call(&f.app, "GET", &tokens, who, Value::Null).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &f.app,
            "POST",
            &tokens,
            As::Browser(&f.editor),
            json!({"name":"ci"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for body in [
        json!({"name":"CI"}),
        json!({"name":"ci","rights":["admin"]}),
        json!({"name":"ci","rights":["propose"]}),
        json!({"name":"ci","expiresInDays":400}),
        json!({"name":"ci","rights":[]}),
    ] {
        assert_eq!(
            call(&f.app, "POST", &tokens, As::Browser(&f.admin), body)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (s, issued) = call(
        &f.app,
        "POST",
        &tokens,
        As::Browser(&f.admin),
        json!({"name":"ci","reason":"GitHub Actions evaluator"}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{issued}");
    let secret = issued["secret"].as_str().unwrap().to_owned();
    assert!(secret.starts_with("acm_"));
    assert_eq!(issued["token"]["rights"], json!(["read"]));
    assert_eq!(issued["token"]["principalId"], "machine:ci");
    assert_eq!(issued["token"]["status"], "active");
    let token_id = issued["token"]["id"].as_str().unwrap().to_owned();
    // The secret is never stored or listed; only its digest is persisted.
    let (s, listed) = call(&f.app, "GET", &tokens, As::Browser(&f.admin), Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!listed.to_string().contains(&secret));
    assert_eq!(listed["items"][0]["secretPrefix"], &secret[..12]);
    let stored: String =
        sqlx::query_scalar("SELECT secret_hash FROM machine_tokens WHERE id=$1::uuid")
            .bind(&token_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_ne!(stored, secret);

    let version = format!("{}/versions/{}", f.root(), f.candidate);
    for token in [&secret, "static-reader", "static-writer"] {
        let (s, metadata) = call(&f.app, "GET", &version, As::Machine(token), Value::Null).await;
        assert_eq!(s, StatusCode::OK, "{metadata}");
        assert_eq!(metadata["id"], f.candidate.to_string());
        let (s, payload) = call(
            &f.app,
            "GET",
            &format!("{version}/payload"),
            As::Machine(token),
            Value::Null,
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{payload}");
    }
    // Rotation preserves the principal and replaces the secret.
    let (s, rotated) = call(
        &f.app,
        "POST",
        &format!("{tokens}/{token_id}/rotate"),
        As::Browser(&f.admin),
        json!({"reason":"scheduled"}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{rotated}");
    let successor = rotated["secret"].as_str().unwrap().to_owned();
    assert_eq!(rotated["token"]["principalId"], "machine:ci");
    assert_eq!(rotated["token"]["rotatedFrom"], json!(token_id));
    assert_eq!(rotated["previous"]["status"], "revoked");
    assert_eq!(
        call(&f.app, "GET", &version, As::Machine(&secret), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &f.app,
            "GET",
            &version,
            As::Machine(&successor),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    // Read never publishes, promotes, authors versions or changes channels.
    let promote = format!("{}/channels/stable/releases", f.root());
    let release =
        json!({"versionId":f.candidate,"expectedRevision":"1","unevaluatedReason":"fixture"});
    for who in [As::Machine(&successor), As::Machine("static-reader")] {
        assert_eq!(
            call(&f.app, "POST", &promote, who, release.clone()).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let payload: Value =
        serde_json::from_slice(include_bytes!("../contracts/fixtures/bundle-v1.json")).unwrap();
    let (s, _) = call(
        &f.app,
        "POST",
        &format!("{}/versions", f.root()),
        As::Machine(&successor),
        json!({"parentVersionId":f.parent,"payload":payload}),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // A workspace token never crosses workspaces.
    assert_eq!(
        call(
            &f.app,
            "GET",
            &format!(
                "/v1/workspaces/{}/bundles/{}/versions/{}",
                f.other, f.bundle, f.candidate
            ),
            As::Machine(&successor),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    // Revocation applies to the next request, without a restart, and is idempotent.
    let successor_id = rotated["token"]["id"].as_str().unwrap();
    for _ in 0..2 {
        let (s, v) = call(
            &f.app,
            "POST",
            &format!("{tokens}/{successor_id}/revoke"),
            As::Browser(&f.admin),
            json!({"reason":"CI moved"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["token"]["status"], "revoked");
        assert_eq!(v["token"]["revokeReason"], "CI moved");
    }
    assert_eq!(
        call(
            &f.app,
            "GET",
            &version,
            As::Machine(&successor),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{tokens}/{successor_id}/rotate"),
            As::Browser(&f.admin),
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    // Expired tokens stop working; an overlapping rotation keeps the old token briefly.
    let (_, short) = call(
        &f.app,
        "POST",
        &tokens,
        As::Browser(&f.admin),
        json!({"name":"nightly","rights":["read"],"expiresInDays":1}),
    )
    .await;
    let short_secret = short["secret"].as_str().unwrap().to_owned();
    let short_id = short["token"]["id"].as_str().unwrap().to_owned();
    let (_, overlap) = call(
        &f.app,
        "POST",
        &format!("{tokens}/{short_id}/rotate"),
        As::Browser(&f.admin),
        json!({"overlapSeconds":600}),
    )
    .await;
    assert_eq!(overlap["previous"]["status"], "active");
    assert_eq!(overlap["token"]["rights"], json!(["read"]));
    assert_eq!(
        call(
            &f.app,
            "GET",
            &format!("{}/versions/{}", f.root(), f.parent),
            As::Machine(&short_secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE machine_tokens SET expires_at=created_at+interval '1 millisecond' WHERE id=$1::uuid")
        .bind(&short_id).execute(&f.db).await.unwrap();
    assert_eq!(
        call(
            &f.app,
            "GET",
            &format!("{}/versions/{}", f.root(), f.parent),
            As::Machine(&short_secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // The audit trail records every change, never a secret.
    let (s, events) = call(
        &f.app,
        "GET",
        &format!("/v1/workspaces/{}/machine-token-events", f.project),
        As::Browser(&f.admin),
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let actions: Vec<_> = events["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        [
            "issued", "rotated", "issued", "revoked", "issued", "rotated", "issued"
        ]
    );
    assert!(!events.to_string().contains("acm_"));
    assert!(
        sqlx::query("DELETE FROM machine_token_events WHERE project_id=$1")
            .bind(&f.project)
            .execute(&f.db)
            .await
            .is_err()
    );
}
