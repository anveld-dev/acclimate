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
    let mut bad = event.clone();
    bad["stage"] = json!("downloaded");
    assert_eq!(
        call(&app, "POST", &receipt, write, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut bad = event.clone();
    bad["occurredAt"] = json!(chrono::Utc::now() - chrono::Duration::hours(25));
    assert_eq!(
        call(&app, "POST", &receipt, write, bad).await.0,
        StatusCode::BAD_REQUEST
    );
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
    assert_eq!(
        call(&app, "POST", &receipt, write, event).await.0,
        StatusCode::FORBIDDEN
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
