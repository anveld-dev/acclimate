use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as AsyncMutex, watch};

#[derive(Default)]
pub struct Record {
    pub log: Vec<Value>,
    pub input: u64,
    pub output: u64,
    pub capped: bool,
    pub failed: bool,
}
pub struct Gateway {
    pub model: String,
    pub url: String,
    pub key: String,
    pub cap: u64,
    pub client: reqwest::Client,
    pub record: Arc<Mutex<Record>>,
    pub serial: AsyncMutex<()>,
    pub closed: watch::Receiver<()>,
}
fn prepare(body: &mut Value, models: &[&str]) -> bool {
    if !body["model"].as_str().is_some_and(|m| models.contains(&m))
        || [
            "previous_response_id",
            "conversation",
            "conversation_id",
            "web_search_options",
        ]
        .iter()
        .any(|k| body.get(k).is_some())
        || body.get("tools").is_some_and(|v| {
            !v.as_array()
                .is_some_and(|a| a.iter().all(|t| t["type"] == "function"))
        })
        || body["messages"]
            .as_array()
            .is_some_and(|ms| ms.iter().any(|m| m.pointer("/audio/id").is_some()))
        || body["tool_choice"].is_object() && body["tool_choice"]["type"] != "function"
    {
        return false;
    }
    body["store"] = json!(false);
    true
}
pub fn router(gateway: Gateway) -> Router {
    Router::new()
        .route("/chat/completions", post(call))
        .with_state(Arc::new(gateway))
}
fn contains_key(v: &Value, key: &str) -> bool {
    match v {
        Value::String(s) => s.contains(key),
        Value::Array(a) => a.iter().any(|v| contains_key(v, key)),
        Value::Object(o) => o
            .iter()
            .any(|(k, v)| k.contains(key) || contains_key(v, key)),
        _ => false,
    }
}
async fn call(State(g): State<Arc<Gateway>>, Json(mut body): Json<Value>) -> Response {
    let mut closed = g.closed.clone();
    tokio::select! {
        _ = closed.changed()=>StatusCode::GONE.into_response(),
        result=forward(&g,&mut body)=>result.into_response(),
    }
}
async fn forward(g: &Gateway, body: &mut Value) -> Result<Response, StatusCode> {
    if !prepare(body, &[&g.model]) || contains_key(body, &g.key) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _serial = g.serial.lock().await;
    {
        let mut r = g.record.lock().unwrap();
        if r.input.saturating_add(r.output) >= g.cap || r.capped {
            r.capped = true;
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }
    let at = chrono::Utc::now();
    // Keep the attempted request if the external deadline cancels the call.
    let entry = {
        let mut record = g.record.lock().unwrap();
        record.log.push(json!({
            "at":at.to_rfc3339(), "route":"/chat/completions", "model":g.model,
            "request":body, "status":504, "response":null, "usage":null,
        }));
        record.log.len() - 1
    };
    let response = async {
        let res = g
            .client
            .post(&g.url)
            .bearer_auth(&g.key)
            .json(body)
            .send()
            .await
            .ok()?;
        let status = res.status();
        let raw = res.bytes().await.ok()?;
        let data: Value =
            serde_json::from_slice(&raw).unwrap_or_else(|_| json!(String::from_utf8_lossy(&raw)));
        Some((status, raw, data))
    }
    .await;
    let mut r = g.record.lock().unwrap();
    let (status, raw, data) =
        response.unwrap_or_else(|| (StatusCode::BAD_GATEWAY, Default::default(), Value::Null));
    let secret = String::from_utf8_lossy(&raw).contains(&g.key)
        || contains_key(&data, &g.key)
        || data.as_str().is_some_and(|text| {
            text.lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .filter_map(|event| serde_json::from_str::<Value>(event).ok())
                .any(|event| contains_key(&event, &g.key))
        });
    // Stream bodies are returned byte-for-byte. Chat streams carry usage on
    // the final JSON event when stream_options.include_usage is requested.
    let tail = data.as_str().and_then(|text| {
        text.lines()
            .rev()
            .filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|event| serde_json::from_str::<Value>(event).ok())
            .find(|event| event["usage"].is_object())
    });
    let usage = &tail.as_ref().unwrap_or(&data)["usage"];
    let entry = &mut r.log[entry];
    entry["status"] = json!(status.as_u16());
    entry["response"] = if secret {
        json!("[redacted]")
    } else {
        data.clone()
    };
    entry["usage"] = if secret { Value::Null } else { usage.clone() };
    if secret {
        r.failed = true;
        return Err(StatusCode::BAD_GATEWAY);
    }
    if !status.is_success() {
        r.failed = true;
        return Ok((status, raw).into_response());
    }
    if body["stream"] != true && data["choices"].as_array().is_none() {
        r.failed = true;
        return Err(StatusCode::BAD_GATEWAY);
    }
    let (Some(input), Some(output)) = (
        usage["prompt_tokens"].as_u64(),
        usage["completion_tokens"].as_u64(),
    ) else {
        r.failed = true;
        return Err(StatusCode::BAD_GATEWAY);
    };
    r.input = r.input.saturating_add(input);
    r.output = r.output.saturating_add(output);
    r.capped = r.input.saturating_add(r.output) >= g.cap
        || data.pointer("/choices/0/finish_reason") == Some(&json!("length"));
    let content_type = if body["stream"] == true {
        "text/event-stream"
    } else {
        "application/json"
    };
    Ok((status, [("content-type", content_type)], raw).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn refuses_exhausted_budget_before_contacting_upstream() {
        let gateway = Gateway {
            model: "task".into(),
            url: String::new(),
            key: "secret".into(),
            cap: 5,
            client: reqwest::Client::new(),
            record: Arc::new(Mutex::new(Record {
                input: 3,
                output: 2,
                ..Default::default()
            })),
            serial: Default::default(),
            closed: watch::channel(()).1,
        };
        assert_eq!(
            forward(&gateway, &mut json!({"model":"task"}))
                .await
                .unwrap_err(),
            StatusCode::TOO_MANY_REQUESTS
        );
        let record = gateway.record.lock().unwrap();
        assert!(record.capped && record.log.is_empty());
    }
    #[tokio::test]
    async fn upstream_echo_cannot_disclose_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let upstream = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/",
                    post(|| async { Json(json!({"error":{"message":"echoed provider-secret"}})) }),
                ),
            )
            .await
            .unwrap();
        });
        let gateway = Gateway {
            model: "task".into(),
            url,
            key: "provider-secret".into(),
            cap: 5,
            client: reqwest::Client::new(),
            record: Default::default(),
            serial: Default::default(),
            closed: watch::channel(()).1,
        };
        assert_eq!(
            forward(&gateway, &mut json!({"model":"task"}))
                .await
                .unwrap_err(),
            StatusCode::BAD_GATEWAY
        );
        let record = gateway.record.lock().unwrap();
        assert!(record.failed);
        assert_eq!(record.log.len(), 1);
        assert!(
            !serde_json::to_string(&record.log)
                .unwrap()
                .contains("provider-secret")
        );
        upstream.abort();
    }
    #[test]
    fn policy() {
        for patch in [
            json!({"model":"other"}),
            json!({"tools":[{"type":"web_search"}]}),
            json!({"conversation":"x"}),
            json!({"previous_response_id":"x"}),
            json!({"web_search_options":{}}),
        ] {
            let mut body = json!({"model":"task"});
            body.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(!prepare(&mut body, &["task", "judge"]));
        }
        let mut body = json!({"model":"judge","tools":[{"type":"function"}],"store":true});
        assert!(prepare(&mut body, &["task", "judge"]));
        assert_eq!(body["store"], false);
        assert!(contains_key(&json!([{"x":"echoed secret"}]), "secret"));
    }
}
