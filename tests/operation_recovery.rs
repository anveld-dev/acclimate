mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture() -> (AppState, String) {
    // Only the isolated runner's explicit URL is accepted; never fall back to DATABASE_URL.
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let p = format!("recovery-{}", Uuid::new_v4());
    (
        AppState {
            access: common::access(),
            runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
            db,
            grants: Arc::new(vec![Grant {
                token: "recovery-test".into(),
                principal_id: "recovery-principal".into(),
                project_id: p.clone(),
                rights: vec![
                    "read".into(),
                    "write".into(),
                    "promote".into(),
                    "propose".into(),
                ],
            }]),
            provider: None,
        },
        p,
    )
}
async fn call(
    app: &axum::Router,
    method: &str,
    url: &str,
    key: &str,
    body: &Value,
    marked: bool,
    session: Option<&str>,
) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(url)
        .header("authorization", "Bearer recovery-test")
        .header("content-type", "application/json")
        .header("idempotency-key", key);
    if marked {
        req = req.header("x-acclimate-durable-operation", "true");
    }
    if let Some(secret) = session {
        req.headers_mut().unwrap().insert(
            "authorization",
            format!("Bearer {}", common::CONSOLE_TOKEN).parse().unwrap(),
        );
        req = req.header("x-acclimate-session", secret);
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn setup_body() -> Value {
    json!({"name":"recovery fixture","origin":"created","channel":"stable","payload":{"schemaVersion":1,"files":[{"kind":"instruction","path":"AGENTS.md","text":"Review carefully."}]},"reason":"Explicit model-free fixture"})
}
fn lookup(p: &str, key: &str, path: &str) -> String {
    let query = format!("operationPath={}", path.replace('/', "%2F"));
    format!("/v1/workspaces/{p}/operations/{key}?{query}")
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn close_serializes_with_marked_and_unmarked_setup_and_never_reverses_a_commit() {
    let (state, p) = fixture().await;
    let app = router(state.clone());
    for marked in [false, true, false, true, false, true] {
        let key = Uuid::new_v4().to_string();
        let setup = format!("/v1/workspaces/{p}/bundle-setups");
        let close = format!("/v1/workspaces/{p}/operations/{key}/close");
        let body = setup_body();
        let empty = json!({});
        let (write, fence) = tokio::join!(
            call(&app, "POST", &setup, &key, &body, marked, None),
            call(&app, "POST", &close, &key, &empty, false, None)
        );
        assert_eq!(fence.0, 200, "{}", fence.1);
        match fence.1["status"].as_str().unwrap() {
            "committed" => {
                assert_eq!(write.0, 201, "{}", write.1);
                assert_eq!(fence.1["result"], write.1);
            }
            "closed" => {
                assert_eq!(write.0, 409, "{}", write.1);
                assert_eq!(write.1["error"]["code"], "operation_closed");
            }
            other => panic!("Unexpected close outcome {other}"),
        }
        // A delayed old client is subject to the identical fence/replay namespace.
        let late = call(&app, "POST", &setup, &key, &body, !marked, None).await;
        assert_eq!(late.0, write.0);
        if write.0 == 201 {
            assert_eq!(late.1, write.1);
        } else {
            assert_eq!(late.1["error"]["code"], write.1["error"]["code"]);
        }
        let again = call(&app, "POST", &close, &key, &json!({}), true, None).await;
        assert_eq!(again, fence);
        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM mutation_audit WHERE project_id=$1 AND operation_key=$2",
        )
        .bind(&p)
        .bind(&key)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(audits, if write.0 == 201 { 1 } else { 0 });
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn added_routes_adopt_legacy_receipts_preserve_exact_replay_and_keep_namespaces_separate() {
    let (state, p) = fixture().await;
    let app = router(state.clone());
    let setup = format!("/v1/workspaces/{p}/bundle-setups");
    let (status, seed) = call(&app, "POST", &setup, "seed", &setup_body(), false, None).await;
    assert_eq!(status, 201, "{seed}");
    let bundle = seed["bundle"]["id"].as_str().unwrap();
    let version = seed["version"]["id"].as_str().unwrap();
    let promotions = format!("/v1/workspaces/{p}/bundles/{bundle}/channels/stable/releases");
    let key = Uuid::new_v4().to_string();
    let body = json!({"versionId":version,"expectedRevision":"1","unevaluatedReason":"Reviewed original intent"});
    let original = call(&app, "POST", &promotions, &key, &body, false, None).await;
    assert_eq!(original.0, 201, "{}", original.1);
    // The marked upgrade sees the old unmarked receipt before stale revision checks.
    assert_eq!(
        call(&app, "POST", &promotions, &key, &body, true, None).await,
        original
    );
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 minute' WHERE project_id=$1 AND key=$2").bind(&p).bind(&key).execute(&state.db).await.unwrap();
    assert_eq!(
        call(&app, "POST", &promotions, &key, &body, false, None).await,
        original
    );
    let recovered = call(
        &app,
        "GET",
        &lookup(&p, &key, &promotions),
        "unused",
        &json!({}),
        false,
        None,
    )
    .await;
    assert_eq!(recovered.0, 200);
    assert_eq!(recovered.1["result"], original.1);
    assert!(
        recovered.1["requestFingerprint"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    let changed = call(
        &app,
        "POST",
        &promotions,
        &key,
        &json!({"versionId":version,"expectedRevision":"2","unevaluatedReason":"Different bytes"}),
        true,
        None,
    )
    .await;
    assert_eq!(changed.0, 409);
    assert_eq!(changed.1["error"]["code"], "idempotency_conflict");
    let close = format!("/v1/workspaces/{p}/operations/{key}/close");
    let closed = call(
        &app,
        "POST",
        &close,
        &key,
        &json!({"operationPath":promotions}),
        false,
        None,
    )
    .await;
    assert_eq!(closed.1["status"], "committed");
    assert_eq!(closed.1["result"], original.1);
    // A closed added route cannot block setup/draft's distinct global namespace.
    let other_key = Uuid::new_v4().to_string();
    let other_close = format!("/v1/workspaces/{p}/operations/{other_key}/close");
    assert_eq!(
        call(
            &app,
            "POST",
            &other_close,
            &other_key,
            &json!({"operationPath":promotions}),
            false,
            None
        )
        .await
        .1["status"],
        "closed"
    );
    assert_eq!(
        call(&app, "POST", &setup, &other_key, &setup_body(), true, None)
            .await
            .0,
        201
    );
    let delayed=call(&app,"POST",&promotions,&other_key,&json!({"versionId":version,"expectedRevision":"2","unevaluatedReason":"Delayed unmarked request"}),false,None).await;
    assert_eq!(delayed.1["error"]["code"], "operation_closed");
    // Conversely the global setup receipt does not block another unrelated added-route key.
    let same_key = "seed";
    let another=call(&app,"POST",&promotions,same_key,&json!({"versionId":version,"expectedRevision":"2","unevaluatedReason":"Independent route namespace"}),true,None).await;
    assert_eq!(another.0, 201, "{}", another.1);
    // Closing an unmarked legacy commit adopts it durably, so repeat close cannot
    // turn a known commit into a tombstone after the old 24-hour receipt expires.
    let legacy_key = Uuid::new_v4().to_string();
    let legacy_body = json!({"versionId":version,"expectedRevision":"3","unevaluatedReason":"Legacy close adoption"});
    let legacy_commit = call(
        &app,
        "POST",
        &promotions,
        &legacy_key,
        &legacy_body,
        false,
        None,
    )
    .await;
    assert_eq!(legacy_commit.0, 201, "{}", legacy_commit.1);
    let legacy_close = format!("/v1/workspaces/{p}/operations/{legacy_key}/close");
    let committed_close = call(
        &app,
        "POST",
        &legacy_close,
        &legacy_key,
        &json!({"operationPath":promotions}),
        false,
        None,
    )
    .await;
    assert_eq!(committed_close.1["status"], "committed");
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 minute' WHERE project_id=$1 AND key=$2").bind(&p).bind(&legacy_key).execute(&state.db).await.unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &legacy_close,
            &legacy_key,
            &json!({"operationPath":promotions}),
            false,
            None
        )
        .await,
        committed_close
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &promotions,
            &legacy_key,
            &legacy_body,
            false,
            None
        )
        .await,
        legacy_commit
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn receipt_lookup_close_and_replay_require_current_effective_action_rights() {
    let (state, p) = fixture().await;
    let app = router(state.clone());
    let path = format!("/v1/workspaces/{p}/bundle-setups");
    let key = Uuid::new_v4().to_string();
    let original = call(&app, "POST", &path, &key, &setup_body(), true, None).await;
    assert_eq!(original.0, 201, "{}", original.1);
    for allowed in [vec!["read", "write"], vec!["read", "promote"]] {
        let mut reduced = state.clone();
        let mut grants = (*state.grants).clone();
        grants[0].rights = allowed.iter().map(|r| r.to_string()).collect();
        reduced.grants = Arc::new(grants);
        let limited = router(reduced);
        let got = call(
            &limited,
            "GET",
            &format!("/v1/workspaces/{p}/operations/{key}"),
            "unused",
            &json!({}),
            false,
            None,
        )
        .await;
        assert_eq!(got.0, 403, "{}", got.1);
        let close = call(
            &limited,
            "POST",
            &format!("/v1/workspaces/{p}/operations/{key}/close"),
            &key,
            &json!({}),
            false,
            None,
        )
        .await;
        assert_eq!(close.0, 403, "{}", close.1);
        assert_eq!(
            call(&limited, "POST", &path, &key, &setup_body(), true, None)
                .await
                .0,
            403
        );
    }
    // Legacy key-only recovery returns the known commit before attempting a global close.
    let recovered = call(
        &app,
        "POST",
        &format!("/v1/workspaces/{p}/operations/{key}/close"),
        &key,
        &json!({}),
        false,
        None,
    )
    .await;
    assert_eq!(recovered.1["status"], "committed");
    // A stored draft receipt is still denied after the browser's current membership changes.
    use sha2::{Digest, Sha256};
    let user = Uuid::new_v4();
    let session = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'recovery-fixture',$2)")
        .bind(user)
        .bind(user.to_string())
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin')")
        .bind(&p)
        .bind(user)
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO browser_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(user).bind(format!("sha256:{}",hex::encode(Sha256::digest(secret.as_bytes())))).execute(&state.db).await.unwrap();
    let browser_key = Uuid::new_v4().to_string();
    let browser = call(
        &app,
        "POST",
        &path,
        &browser_key,
        &setup_body(),
        true,
        Some(&secret),
    )
    .await;
    assert_eq!(browser.0, 201, "{}", browser.1);
    sqlx::query("UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2")
        .bind(&p)
        .bind(user)
        .execute(&state.db)
        .await
        .unwrap();
    let denied = call(
        &app,
        "GET",
        &format!("/v1/workspaces/{p}/operations/{browser_key}"),
        "unused",
        &json!({}),
        false,
        Some(&secret),
    )
    .await;
    assert_eq!(denied.0, 403, "{}", denied.1);
    assert_eq!(
        call(
            &app,
            "POST",
            &path,
            &browser_key,
            &setup_body(),
            false,
            Some(&secret)
        )
        .await
        .0,
        403
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn legacy_key_only_close_uses_the_committed_draft_action_and_drafts_channel_is_route_scoped()
{
    let (state, p) = fixture().await;
    let app = router(state.clone());
    let setup_path = format!("/v1/workspaces/{p}/bundle-setups");
    let (status, seed) = call(
        &app,
        "POST",
        &setup_path,
        "seed",
        &setup_body(),
        false,
        None,
    )
    .await;
    assert_eq!(status, 201);
    let bundle = seed["bundle"]["id"].as_str().unwrap();
    let version = seed["version"]["id"].as_str().unwrap();
    let draft_path = format!("/v1/workspaces/{p}/bundles/{bundle}/channels/stable/drafts");
    let created = call(
        &app,
        "POST",
        &draft_path,
        "draft",
        &json!({"baseVersionId":version,"baseRevision":"1","payload":setup_body()["payload"]}),
        false,
        None,
    )
    .await;
    assert_eq!(created.0, 201, "{}", created.1);
    let published_key = Uuid::new_v4().to_string();
    let publish_path = format!("{draft_path}/{}/publish", created.1["id"].as_str().unwrap());
    let published=call(&app,"POST",&publish_path,&published_key,&json!({"expectedGeneration":1,"expectedRevision":"1","unevaluatedReason":"Reviewed publication"}),false,None).await;
    assert_eq!(published.0, 200, "{}", published.1);
    let mut promote_only = state.clone();
    let mut grants = (*state.grants).clone();
    grants[0].rights = vec!["promote".into()];
    promote_only.grants = Arc::new(grants);
    let limited = router(promote_only);
    let close = format!("/v1/workspaces/{p}/operations/{published_key}/close");
    let result = call(
        &limited,
        "POST",
        &close,
        &published_key,
        &json!({}),
        false,
        None,
    )
    .await;
    assert_eq!(result.0, 200, "{}", result.1);
    assert_eq!(result.1["result"], published.1);
    let key = Uuid::new_v4().to_string();
    let channel_drafts = format!("/v1/workspaces/{p}/bundles/{bundle}/channels/drafts/releases");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/v1/workspaces/{p}/operations/{key}/close"),
            &key,
            &json!({"operationPath":channel_drafts}),
            false,
            None
        )
        .await
        .1["status"],
        "closed"
    );
    assert_eq!(
        call(&app, "POST", &setup_path, &key, &setup_body(), false, None)
            .await
            .0,
        201
    );
}
