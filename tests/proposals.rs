mod common;
use acclimate_service::{
    AppState, BundlePayload, Grant, ProposalModel, ProposalRequest, proposal_worker, router,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

struct Model {
    mode: &'static str,
    calls: Arc<AtomicUsize>,
}
impl ProposalModel for Model {
    fn propose<'a>(
        &'a self,
        mut parent: BundlePayload,
        _request: ProposalRequest,
    ) -> Pin<Box<dyn Future<Output = Result<(BundlePayload, String), String>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.mode {
                "failure" => return Err("secret provider details".into()),
                "anchor" => return Err("Anchor does not match original text".into()),
                "outside" => parent.files[0]
                    .text
                    .push_str("changed outside allowed paths"),
                "oversize" => {
                    for file in &mut parent.files {
                        file.text = "x".repeat(262_144)
                    }
                }
                _ => parent.files.last_mut().unwrap().text.push_str(" improved"),
            }
            Ok((parent, "bounded test edit".into()))
        })
    }
}
struct DelayedModel {
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl ProposalModel for DelayedModel {
    fn propose<'a>(
        &'a self,
        parent: BundlePayload,
        _request: ProposalRequest,
    ) -> Pin<Box<dyn Future<Output = Result<(BundlePayload, String), String>> + Send + 'a>> {
        Box::pin(async move {
            self.started.notify_one();
            self.release.notified().await;
            Ok((parent, "late result".into()))
        })
    }
}
async fn call(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer proposal-fixture")
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
async fn terminal(app: &axum::Router, path: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (status, body) = call(app, "GET", path, Value::Null).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            if body["status"] == "succeeded" || body["status"] == "failed" {
                return body;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("worker did not finish within 5s")
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn persisted_proposals_are_bounded_validated_and_recovered() {
    let url = common::database_url();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("proposal-test-{}", Uuid::new_v4());
    let mut state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "proposal-fixture".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "propose".into()],
        }]),
        provider: None,
    };
    let app = router(state.clone());
    let root = format!("/v1/workspaces/{project}/bundles");
    let (status, bundle) = call(&app, "POST", &root, json!({"name":"proposer test"})).await;
    assert_eq!(status, StatusCode::CREATED, "{bundle}");
    let base = format!("{root}/{}", bundle["id"].as_str().unwrap());
    let files: Vec<Value> = (0..4)
        .map(|i| json!({"path":format!("guide-{i}.md"),"kind":"instruction","text":"base"}))
        .collect();
    let (status, parent) = call(
        &app,
        "POST",
        &format!("{base}/versions"),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":files}}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{parent}");
    let parent_id = parent["id"].as_str().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    for mode in [
        "disabled", "outside", "oversize", "failure", "anchor", "recover", "capped",
    ] {
        state.provider = if mode == "disabled" {
            None
        } else {
            Some(Arc::new(Model {
                mode,
                calls: calls.clone(),
            }))
        };
        let app = router(state.clone());
        let allowed: Vec<String> = if mode == "oversize" {
            (0..4).map(|i| format!("guide-{i}.md")).collect()
        } else {
            vec!["guide-3.md".into()]
        };
        let (status,proposal)=call(&app,"POST",&format!("{base}/proposals"),json!({"parentVersionId":parent_id,"allowedPaths":allowed,"hypothesis":"Improve the last guide","evidence":[]})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{proposal}");
        let id = proposal["id"].as_str().unwrap();
        let path = format!("{base}/proposals/{id}");
        let (_, queued) = call(&app, "GET", &path, Value::Null).await;
        assert!(queued["candidate"].is_null());
        if mode == "recover" || mode == "capped" {
            sqlx::query("UPDATE proposals SET status='running',attempts=$2 WHERE id=$1")
                .bind(Uuid::parse_str(id).unwrap())
                .bind(if mode == "recover" { 2_i32 } else { 3_i32 })
                .execute(&db)
                .await
                .unwrap();
        }
        let before = calls.load(Ordering::SeqCst);
        state.runtime.ownership_acquired();
        let worker = tokio::spawn(proposal_worker(state.clone()));
        let done = terminal(&app, &path).await;
        worker.abort();
        let _ = worker.await;
        if mode == "recover" {
            assert_eq!(done["status"], "succeeded", "{done}");
            assert_eq!(done["attempts"], 3);
            assert_eq!(done["candidate"]["parentVersionId"], parent_id);
            assert_eq!(calls.load(Ordering::SeqCst), before + 1);
            let candidate = done["candidate"]["id"].as_str().unwrap();
            let author: String = sqlx::query_scalar(
                "SELECT created_by FROM versions WHERE id=$1 AND proposal_id=$2",
            )
            .bind(Uuid::parse_str(candidate).unwrap())
            .bind(Uuid::parse_str(id).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
            assert_eq!(author, project);
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM versions WHERE parent_version_id=$1")
                    .bind(Uuid::parse_str(parent_id).unwrap())
                    .fetch_one(&db)
                    .await
                    .unwrap();
            assert_eq!(count, 1);
            let (_, again) = call(&app, "GET", &path, Value::Null).await;
            assert_eq!(again["candidate"]["id"], candidate);
        } else {
            assert_eq!(done["status"], "failed", "{done}");
            assert!(done["candidate"].is_null());
            if mode == "failure" {
                assert_eq!(done["error"], "provider request failed");
            }
            if mode == "outside" {
                assert_eq!(done["error"], "provider edit is outside allowed paths");
            }
            if mode == "anchor" {
                assert_eq!(
                    done["error"],
                    "provider edit anchor does not match original text"
                );
            }
            if mode == "disabled" || mode == "capped" {
                assert_eq!(calls.load(Ordering::SeqCst), before)
            } else {
                assert_eq!(calls.load(Ordering::SeqCst), before + 1)
            }
        }
    }
    let delayed = Arc::new(DelayedModel {
        started: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    state.provider = Some(delayed.clone());
    let app = router(state.clone());
    let (_, proposal) = call(&app, "POST", &format!("{base}/proposals"), json!({"parentVersionId":parent_id,"allowedPaths":["guide-3.md"],"hypothesis":"late result","evidence":[]})).await;
    let id = Uuid::parse_str(proposal["id"].as_str().unwrap()).unwrap();
    state.runtime.ownership_acquired();
    let worker = tokio::spawn(proposal_worker(state));
    tokio::time::timeout(Duration::from_secs(5), delayed.started.notified())
        .await
        .unwrap();
    sqlx::query("UPDATE proposals SET attempts=2 WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    delayed.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), delayed.started.notified())
        .await
        .unwrap();
    worker.abort();
    let _ = worker.await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM versions WHERE proposal_id=$1")
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0, "stale attempt must not publish a candidate");
}

struct SelectedEditModel;
impl ProposalModel for SelectedEditModel {
    fn propose<'a>(
        &'a self,
        mut parent: BundlePayload,
        request: ProposalRequest,
    ) -> Pin<Box<dyn Future<Output = Result<(BundlePayload, String), String>> + Send + 'a>> {
        Box::pin(async move {
            let selected = &request.allowed_paths[0];
            parent
                .files
                .iter_mut()
                .find(|file| &file.path == selected)
                .unwrap()
                .text
                .push_str(" updated");
            Ok((parent, "selected edit".into()))
        })
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn worker_preserves_mixed_bundle_for_instruction_and_memory_edits() {
    let url = common::database_url();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("mixed-proposal-{}", Uuid::new_v4());
    let state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "proposal-fixture".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "propose".into()],
        }]),
        provider: Some(Arc::new(SelectedEditModel)),
    };
    let app = router(state.clone());
    let root = format!("/v1/workspaces/{project}/bundles");
    let (status, bundle) = call(&app, "POST", &root, json!({"name":"mixed bundle"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let base = format!("{root}/{}", bundle["id"].as_str().unwrap());
    let files = json!([
        {"path":"instructions.md","kind":"instruction","text":"instruction base"},
        {"path":"skill.md","kind":"skill","text":"skill base"},
        {"path":"memory.md","kind":"memory","text":"memory base"}
    ]);
    let (status, parent) = call(
        &app,
        "POST",
        &format!("{base}/versions"),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":files}}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{parent}");
    let parent_id = parent["id"].as_str().unwrap();
    let parent_uuid = Uuid::parse_str(parent_id).unwrap();
    let original_bytes: Vec<u8> = sqlx::query_scalar("SELECT payload FROM versions WHERE id=$1")
        .bind(parent_uuid)
        .fetch_one(&db)
        .await
        .unwrap();
    let original: Value = serde_json::from_slice(&original_bytes).unwrap();
    state.runtime.ownership_acquired();
    let worker = tokio::spawn(proposal_worker(state));
    for selected in ["instructions.md", "memory.md"] {
        let (status, proposal) = call(&app, "POST", &format!("{base}/proposals"), json!({"parentVersionId":parent_id,"allowedPaths":[selected],"hypothesis":"improve selected file","evidence":["explicit evidence"]})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{proposal}");
        let proposal_id = Uuid::parse_str(proposal["id"].as_str().unwrap()).unwrap();
        let done = terminal(&app, &format!("{base}/proposals/{proposal_id}")).await;
        assert_eq!(done["status"], "succeeded", "{done}");
        assert_eq!(done["candidate"]["parentVersionId"], parent_id);
        let candidate_id = Uuid::parse_str(done["candidate"]["id"].as_str().unwrap()).unwrap();
        let row: (Vec<u8>, String, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
            "SELECT payload,created_by,parent_version_id,proposal_id FROM versions WHERE id=$1",
        )
        .bind(candidate_id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row.1, project);
        assert_eq!(row.2, Some(parent_uuid));
        assert_eq!(row.3, Some(proposal_id));
        let candidate: Value = serde_json::from_slice(&row.0).unwrap();
        let mut expected = original.clone();
        for file in expected["files"].as_array_mut().unwrap() {
            if file["path"] == selected {
                let text = file["text"].as_str().unwrap().to_owned();
                file["text"] = json!(format!("{text} updated"));
            }
        }
        assert_eq!(candidate, expected);
        let unchanged: Vec<u8> = sqlx::query_scalar("SELECT payload FROM versions WHERE id=$1")
            .bind(parent_uuid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(unchanged, original_bytes);
    }
    worker.abort();
    let _ = worker.await;
}
