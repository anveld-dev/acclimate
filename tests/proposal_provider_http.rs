//! Local HTTP boundary regression: no provider credentials or paid requests.
use acclimate_service::{BundlePayload, OpenAiModel, ProposalModel, ProposalRequest};
use axum::{Json, Router, routing::post};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[tokio::test]
async fn provider_requires_bounded_complete_patch_response() {
    let output = Arc::new(Mutex::new(json!(null)));
    let observed = Arc::new(Mutex::new(json!(null)));
    let app = Router::new().route(
        "/",
        post({
            let output = output.clone();
            let observed = observed.clone();
            move |Json(body): Json<Value>| {
                let response = output.lock().unwrap().clone();
                *observed.lock().unwrap() = body;
                async move { Json(response) }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    // This integration-test executable owns its environment and has one test; no other threads read it.
    unsafe {
        std::env::set_var("ACCLIMATE_MODEL_ENDPOINT", format!("http://{address}/"));
        std::env::set_var("ACCLIMATE_MODEL_TOKEN", "disposable-http-fixture");
        std::env::set_var("ACCLIMATE_MODEL", "gpt-6-luna");
    }
    let model = OpenAiModel::from_env().unwrap().unwrap();
    let parent:BundlePayload=serde_json::from_value(json!({"schemaVersion":1,"files":[{"path":"guide.md","kind":"instruction","text":"before\n"},{"path":"large.md","kind":"memory","text":"保留".repeat(10000)}]})).unwrap();
    let request = ProposalRequest {
        parent_version_id: "parent".into(),
        allowed_paths: vec!["guide.md".into()],
        hypothesis: "bounded".into(),
        evidence: vec![],
    };
    let content=json!({"schemaVersion":1,"edits":[{"path":"guide.md","oldText":"before","newText":"after"}],"rationale":"Fixture"}).to_string();
    for finish in [json!("length"), json!("content_filter"), json!(null)] {
        *output.lock().unwrap() =
            json!({"choices":[{"finish_reason":finish,"message":{"content":content}}]});
        assert!(
            model
                .propose(parent.clone(), request.clone())
                .await
                .is_err()
        );
    }
    *output.lock().unwrap() =
        json!({"choices":[{"finish_reason":"stop","message":{"content":content}}]});
    let (candidate, _) = model
        .propose(parent.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(candidate.files[0].text, "after\n");
    assert_eq!(candidate.files[1].text, parent.files[1].text);
    let prompt: Value = serde_json::from_str(
        observed.lock().unwrap()["messages"][0]["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(prompt["instruction"].as_str().unwrap().contains("oldText"));
    for content in [
        json!({"payload":parent,"rationale":"full echo"}).to_string(),
        "x".repeat(32769),
    ] {
        *output.lock().unwrap() =
            json!({"choices":[{"finish_reason":"stop","message":{"content":content}}]});
        assert!(
            model
                .propose(parent.clone(), request.clone())
                .await
                .is_err()
        );
    }
    *output.lock().unwrap() = json!({"padding":"x".repeat(262145),"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]});
    assert!(model.propose(parent, request).await.is_err());
    server.abort();
}
