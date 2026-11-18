mod common;
use acclimate_service::{
    AppState, BundlePayload, Grant, ProposalModel, ProposalRequest, proposal_worker, router,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tower::ServiceExt;
use uuid::Uuid;
async fn call(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer native-fixture")
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
fn payload(complete: bool) -> Value {
    json!({"schemaVersion":1,"files":[{"path":"skills/review/SKILL.md","kind":"skill","text":if complete {"---\nname: review\ndescription: Review changes\n---\nInstructions"} else {"Incomplete draft"}}]})
}
struct IncompleteModel;
impl ProposalModel for IncompleteModel {
    fn propose<'a>(
        &'a self,
        mut parent: BundlePayload,
        _: ProposalRequest,
    ) -> Pin<Box<dyn Future<Output = Result<(BundlePayload, String), String>> + Send + 'a>> {
        Box::pin(async move {
            parent.files[0].text = "Incomplete metadata".into();
            Ok((parent, "invalid native candidate".into()))
        })
    }
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn native_save_reload_repair_publication_rollback_and_provider_gate() {
    let url = common::database_url();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("native-{}", Uuid::new_v4());
    let state = AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "native-fixture".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec![
                "read".into(),
                "write".into(),
                "promote".into(),
                "propose".into(),
            ],
        }]),
        provider: Some(Arc::new(IncompleteModel)),
    };
    let app = router(state.clone());
    let root = format!("/v1/projects/{project}");
    for target in ["unknown", "codex"] {
        let (status,_)=call(&app,"POST",&format!("{root}/bundle-setups"),json!({"name":"incomplete","origin":"created","channel":"stable","reason":"initial","compatibilityTarget":target,"payload":payload(false)})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status,generic)=call(&app,"POST",&format!("{root}/bundle-setups"),json!({"name":"generic","origin":"created","channel":"stable","reason":"initial","payload":payload(false)})).await;
    assert_eq!(status, StatusCode::CREATED, "{generic}");
    assert_eq!(generic["bundle"]["compatibilityTarget"], "generic");
    let (status,native)=call(&app,"POST",&format!("{root}/bundle-setups"),json!({"name":"native","origin":"created","channel":"stable","reason":"initial","compatibilityTarget":"codex","payload":payload(true)})).await;
    assert_eq!(status, StatusCode::CREATED, "{native}");
    assert_eq!(native["bundle"]["compatibilityTarget"], "codex");
    let base = format!(
        "{root}/bundles/{}",
        native["bundle"]["id"].as_str().unwrap()
    );
    let initial = &native["version"]["id"];
    let drafts = format!("{base}/channels/stable/drafts");
    let (status, draft) = call(
        &app,
        "POST",
        &drafts,
        json!({"baseVersionId":initial,"baseRevision":"1","payload":payload(false)}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{draft}");
    let draft_path = format!("{drafts}/{}", draft["id"].as_str().unwrap());
    let (_, reloaded) = call(&app, "GET", &draft_path, json!(null)).await;
    assert_eq!(
        reloaded["snapshotVersion"]["id"],
        draft["snapshotVersion"]["id"]
    );
    let snapshot = format!(
        "{base}/versions/{}/payload",
        reloaded["snapshotVersion"]["id"].as_str().unwrap()
    );
    let (status, saved) = call(&app, "GET", &snapshot, json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved, payload(false));
    let publish = format!("{draft_path}/publish");
    let (status, failed) = call(
        &app,
        "POST",
        &publish,
        json!({"expectedGeneration":1,"expectedRevision":"1","unevaluatedReason":"review"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_compatibility");
    assert_eq!(
        failed["error"]["details"]["issues"][0]["code"],
        "skill_metadata"
    );
    let (status, repaired) = call(
        &app,
        "POST",
        &format!("{draft_path}/save"),
        json!({"expectedGeneration":1,"payload":payload(true)}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{repaired}");
    let (status,published)=call(&app,"POST",&publish,json!({"expectedGeneration":2,"expectedRevision":"1","unevaluatedReason":"reviewed repair"})).await;
    assert_eq!(status, StatusCode::OK, "{published}");
    let promotions = format!("{base}/channels/stable/promotions");
    let (status,rollback)=call(&app,"POST",&promotions,json!({"versionId":initial,"expectedRevision":"2","unevaluatedReason":"compatible rollback"})).await;
    assert_eq!(status, StatusCode::CREATED, "{rollback}");
    // Immutable versions can also retain incomplete work; every fresh release checks stored policy.
    let (status, version) = call(
        &app,
        "POST",
        &format!("{base}/versions"),
        json!({"parentVersionId":initial,"payload":payload(false)}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{version}");
    let (status,_)=call(&app,"POST",&promotions,json!({"versionId":version["id"],"expectedRevision":"3","unevaluatedReason":"reject incomplete rollback"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    state.runtime.ownership_acquired();
    let worker = tokio::spawn(proposal_worker(state));
    for (bundle, parent_id, expected) in [
        (native["bundle"]["id"].as_str().unwrap(), initial, "failed"),
        (
            generic["bundle"]["id"].as_str().unwrap(),
            &generic["version"]["id"],
            "succeeded",
        ),
    ] {
        let path = format!("{root}/bundles/{bundle}/proposals");
        let (status,proposal)=call(&app,"POST",&path,json!({"parentVersionId":parent_id,"allowedPaths":["skills/review/SKILL.md"],"hypothesis":"metadata fixture","evidence":[]})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{proposal}");
        let terminal = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let (_, p) = call(
                    &app,
                    "GET",
                    &format!("{path}/{}", proposal["id"].as_str().unwrap()),
                    json!(null),
                )
                .await;
                if p["status"] == "failed" || p["status"] == "succeeded" {
                    break p;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(terminal["status"], expected, "{terminal}");
    }
    worker.abort();
    db.close().await;
}
