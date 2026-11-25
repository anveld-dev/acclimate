mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
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
    call_with_key(app, method, path, token, body, None).await
}
async fn call_with_key(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
    key: Option<&str>,
) -> (StatusCode, Value) {
    let (bearer, session) = token
        .strip_prefix("browser:")
        .map_or((token, ""), |secret| (common::CONSOLE_TOKEN, secret));
    let mut request = Request::builder().header("authorization", format!("Bearer {bearer}"));
    if !session.is_empty() {
        request = request.header("x-acclimate-session", session);
    }
    let response = app
        .clone()
        .oneshot(
            request
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header(
                    "idempotency-key",
                    key.map(str::to_owned)
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                )
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
/// Send raw body bytes with an optional content type, for malformed-body checks.
async fn raw(
    app: &axum::Router,
    path: &str,
    token: &str,
    content_type: Option<&str>,
    body: &str,
    key: &str,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("idempotency-key", key);
    if let Some(content_type) = content_type {
        request = request.header("content-type", content_type);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn message(v: &Value) -> &str {
    v["error"]["message"].as_str().unwrap_or("")
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn opt_in_credentials_are_scoped_revocable_and_receipts_idempotent() {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let p = format!("receipt-{}", Uuid::new_v4());
    let b = Uuid::new_v4();
    let v = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    let digest = format!("sha256:{}", "a".repeat(64));
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'fixture')")
        .bind(b)
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    for id in [v, candidate] {
        sqlx::query(
            "INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,'fixture-author')",
        )
        .bind(id)
        .bind(&p)
        .bind(b)
        .bind(&digest)
        .bind(b"{}".as_slice())
        .execute(&db)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)").bind(&p).bind(b).bind(v).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,reviewer) VALUES($1,$2,$3,'stable',1,$4,'fixture')").bind(Uuid::new_v4()).bind(&p).bind(b).bind(v).execute(&db).await.unwrap();
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        optimizer: None,
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "operator".into(),
            principal_id: "operator".into(),
            project_id: p.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
    });
    let base = format!("/v1/workspaces/{p}/connections");
    let mut ids = vec![];
    for _ in 0..2 {
        let (status, r) = call(
            &app,
            "POST",
            &base,
            "operator",
            json!({"displayName":"fixture","bundleId":b,"channel":"stable"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        ids.push(r["id"].as_str().unwrap().to_owned());
    }
    let endpoint = format!("{base}/{}", ids[0]);
    let create_key = Uuid::new_v4().to_string();
    let create_body = json!({"displayName":"replay fixture","bundleId":b,"channel":"stable"});
    let (status, created) = call_with_key(
        &app,
        "POST",
        &base,
        "operator",
        create_body.clone(),
        Some(&create_key),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        call_with_key(
            &app,
            "POST",
            &base,
            "operator",
            create_body,
            Some(&create_key)
        )
        .await
        .1,
        created
    );
    let issue_key = Uuid::new_v4().to_string();
    let (status, issued) = call_with_key(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"receipt-write"}),
        Some(&issue_key),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, repeated) = call_with_key(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"receipt-write"}),
        Some(&issue_key),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(repeated["error"]["code"], "credential_already_issued");
    assert!(repeated.get("secret").is_none());
    let listed = call(&app, "GET", &base, "operator", Value::Null).await.1;
    let found = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == ids[0])
        .unwrap();
    assert!(
        found["credentials"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == issued["id"])
    );
    assert!(
        !listed
            .to_string()
            .contains(issued["secret"].as_str().unwrap())
    );

    let (_, read) = call(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"content-read"}),
    )
    .await;
    let (_, write) = call(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"receipt-write"}),
    )
    .await;
    let read = read["secret"].as_str().unwrap();
    let write = write["secret"].as_str().unwrap();
    let mut event = json!({"eventId":Uuid::new_v4(),"connectionId":ids[0],"workspaceId":p,"bundleId":b,"versionId":v,"digest":digest,"stage":"verified","source":"cache","occurredAt":chrono::Utc::now()});
    let receipt = format!("{endpoint}/receipts");
    assert_eq!(
        call(&app, "POST", &receipt, read, event.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", &receipt, write, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    // An unknown aci_ secret is unauthenticated, on reads and on receipts.
    let unknown = format!("aci_{}", "0".repeat(64));
    let (status, body) = call(&app, "POST", &receipt, &unknown, event.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthenticated");
    let released = format!("/v1/workspaces/{p}/bundles/{b}/versions/{v}/payload");
    assert_eq!(
        call(&app, "GET", &released, &unknown, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "POST", &receipt, "not-a-token", event.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // A valid credential of another kind is still denied.
    assert_eq!(
        call(&app, "POST", &receipt, "operator", event.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Malformed bodies get the standard error envelope.
    let key = Uuid::new_v4().to_string();
    for (content_type, body, status, text) in [
        (
            Some("application/json"),
            "{not json",
            StatusCode::BAD_REQUEST,
            "not valid JSON",
        ),
        (
            None,
            "{}",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type",
        ),
        (
            Some("application/json"),
            "{}",
            StatusCode::BAD_REQUEST,
            "missing field",
        ),
    ] {
        let (got, error) = raw(&app, &receipt, write, content_type, body, &key).await;
        assert_eq!(got, status, "{error}");
        assert_eq!(error["error"]["code"], "invalid_content", "{error}");
        assert!(message(&error).contains(text), "{error}");
        assert!(error["error"]["requestId"].is_string());
        let (got, error) = raw(
            &app,
            &format!("{endpoint}/credentials"),
            "operator",
            content_type,
            body,
            &key,
        )
        .await;
        assert_eq!(got, status, "{error}");
        assert_eq!(error["error"]["code"], "invalid_content", "{error}");
        let (got, error) = raw(
            &app,
            &format!("/v1/workspaces/{p}/operations/{key}/close"),
            "operator",
            content_type,
            if body == "{}" { "5" } else { body },
            &key,
        )
        .await;
        assert_eq!(got, status, "{error}");
        assert_eq!(error["error"]["code"], "invalid_content", "{error}");
    }
    let mut bad = event.clone();
    bad["extra"] = json!(true);
    let (status, error) = call(&app, "POST", &receipt, write, bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(message(&error).contains("unknown field `extra`"), "{error}");
    // Each failed rule is named in the message.
    let now = chrono::Utc::now();
    for (field, value, text) in [
        ("stage", json!("downloaded"), "downloaded receipt"),
        ("stage", json!("loaded"), "stage must be"),
        ("source", json!("disk"), "source must be"),
        ("digest", json!("a".repeat(71)), "digest must be"),
        (
            "digest",
            json!(format!("sha256:{}", "A".repeat(64))),
            "digest must be",
        ),
        ("channel", json!("stable"), "sent together"),
        (
            "occurredAt",
            json!(now - chrono::Duration::hours(25)),
            "24 hours",
        ),
        (
            "occurredAt",
            json!(now + chrono::Duration::minutes(10)),
            "5 minutes",
        ),
    ] {
        let mut bad = event.clone();
        bad[field] = value;
        let (status, error) = call(&app, "POST", &receipt, write, bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {error}");
        assert!(message(&error).contains(text), "{field}: {error}");
    }
    let mut bad = event.clone();
    bad["stage"] = json!("resolved");
    let (status, error) = call(&app, "POST", &receipt, write, bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(message(&error).contains("resolved receipt"), "{error}");
    let mut bad = event.clone();
    for (field, value) in [
        ("channel", json!("stable")),
        ("revision", json!("x")),
        ("resolvedAt", json!(now)),
        ("stale", json!(false)),
    ] {
        bad[field] = value;
    }
    let (status, error) = call(&app, "POST", &receipt, write, bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(message(&error).contains("revision"), "{error}");
    // A full channel mapping is accepted when the revision was released.
    let mut mapped = event.clone();
    mapped["eventId"] = json!(Uuid::new_v4());
    mapped["stage"] = json!("resolved");
    for (field, value) in [
        ("channel", json!("stable")),
        ("revision", json!("1")),
        ("resolvedAt", json!(now)),
        ("stale", json!(false)),
    ] {
        mapped[field] = value;
    }
    let (status, body) = call(&app, "POST", &receipt, write, mapped.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revision"], "1");
    mapped["eventId"] = json!(Uuid::new_v4());
    mapped["revision"] = json!("2");
    let (status, body) = call(&app, "POST", &receipt, write, mapped).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(message(&body).contains("never released"), "{body}");
    let mut bad = event.clone();
    bad["digest"] = json!(format!("sha256:{}", "b".repeat(64)));
    assert_eq!(
        call(&app, "POST", &receipt, write, bad).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, first) = call(&app, "POST", &receipt, write, event.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (_, second) = call(&app, "POST", &receipt, write, event.clone()).await;
    assert_eq!(first, second);
    event["stage"] = json!("prepared");
    assert_eq!(
        call(&app, "POST", &receipt, write, event.clone()).await.0,
        StatusCode::CONFLICT
    );
    event["eventId"] = json!(Uuid::new_v4());
    event["connectionId"] = json!(ids[1]);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{base}/{}/receipts", ids[1]),
            write,
            event.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    event["connectionId"] = json!(ids[0]);
    event["versionId"] = json!(candidate);
    assert_eq!(
        call(&app, "POST", &receipt, write, event.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let payload = format!("/v1/workspaces/{p}/bundles/{b}/versions/{candidate}");
    assert_eq!(
        call(&app, "GET", &payload, read, Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    call(
        &app,
        "POST",
        &format!("{endpoint}/revoke"),
        "operator",
        json!({}),
    )
    .await;
    event["versionId"] = json!(v);
    // Revoking the connection disables its credentials: they are no longer known.
    let (status, body) = call(&app, "POST", &receipt, write, event).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthenticated");
    assert_eq!(
        call(&app, "GET", &released, read, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
}

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
            optimizer: None,
            db,
            grants: Arc::new(grants),
        },
        project,
        bundle,
        parent,
        candidate,
    }
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
    let endpoint = format!("/v1/workspaces/{}/connection-observations", f.project);
    let (s, v) = call(&app, "GET", &endpoint, "reader", Value::Null).await;
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
        Value::Null,
    )
    .await
    .1;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let cursor = page["nextCursor"].as_str().unwrap();
    let next = call(
        &app,
        "GET",
        &format!("{endpoint}?limit=1&cursor={cursor}"),
        "reader",
        Value::Null,
    )
    .await
    .1;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{endpoint}?limit=0"),
            "reader",
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/v1/workspaces/{}/connections", f.project),
            "reader",
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    f.state.db.close().await;
}
