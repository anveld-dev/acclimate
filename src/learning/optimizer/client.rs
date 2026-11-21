use super::{Kind, ModelError, ModelFuture, OptimizerModel, system_text};
use regex::Regex;
use reqwest::{Response, StatusCode, Url};
use serde_json::{Value, json};
use std::{
    io,
    sync::{Arc, LazyLock},
    time::Duration,
};

pub struct OpenAiModel {
    endpoint: Url,
    token: String,
    model: String,
    client: reqwest::Client,
    max_completion_tokens: u32,
    reasoning_effort: Option<String>,
}

fn setting(name: &str, range: std::ops::RangeInclusive<u32>, default: u32) -> io::Result<u32> {
    match std::env::var(name) {
        Ok(value) => value.parse().ok().filter(|n| range.contains(n)),
        Err(std::env::VarError::NotPresent) => Some(default),
        Err(_) => None,
    }
    .ok_or_else(|| io::Error::other(format!("Invalid {name}")))
}

impl OpenAiModel {
    pub fn from_env() -> io::Result<Option<Arc<dyn OptimizerModel>>> {
        const EFFORT: &str = "ACCLIMATE_MODEL_REASONING_EFFORT";
        let effort = match std::env::var(EFFORT) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return Err(io::Error::other("Invalid ACCLIMATE_MODEL_REASONING_EFFORT")),
        };
        validate_effort(effort.as_deref())?;
        let seconds = setting("ACCLIMATE_MODEL_TIMEOUT_SECONDS", 30..=3600, 600)?;
        let tokens = setting(
            "ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS",
            1024..=262144,
            32768,
        )?;
        let endpoint = match std::env::var("ACCLIMATE_MODEL_ENDPOINT") {
            Ok(value) => value,
            Err(std::env::VarError::NotPresent) => return Ok(None),
            Err(_) => return Err(io::Error::other("Invalid ACCLIMATE_MODEL_ENDPOINT")),
        };
        let token = std::env::var("ACCLIMATE_MODEL_TOKEN")
            .map_err(|_| io::Error::other("ACCLIMATE_MODEL_TOKEN is required"))?;
        let model = std::env::var("ACCLIMATE_MODEL")
            .map_err(|_| io::Error::other("ACCLIMATE_MODEL is required"))?;
        Ok(Some(Arc::new(
            Self::new(&endpoint, token, &model, seconds, tokens)?.with_reasoning_effort(effort)?,
        )))
    }

    pub fn new(
        endpoint: &str,
        token: String,
        model: &str,
        seconds: u32,
        tokens: u32,
    ) -> io::Result<Self> {
        let endpoint = Url::parse(endpoint)
            .ok()
            .filter(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.has_host()
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .ok_or_else(|| io::Error::other("Invalid ACCLIMATE_MODEL_ENDPOINT"))?;
        if token.trim().is_empty() || token.chars().any(char::is_control) {
            return Err(io::Error::other("Invalid ACCLIMATE_MODEL_TOKEN"));
        }
        if model.trim().is_empty()
            || model.trim().len() > 256
            || model.trim().chars().any(char::is_control)
        {
            return Err(io::Error::other("Invalid ACCLIMATE_MODEL"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(seconds.into()))
            .build()
            .map_err(io::Error::other)?;
        Ok(Self {
            endpoint,
            token,
            model: model.trim().into(),
            client,
            max_completion_tokens: tokens,
            reasoning_effort: None,
        })
    }

    pub fn with_reasoning_effort(mut self, effort: Option<String>) -> io::Result<Self> {
        validate_effort(effort.as_deref())?;
        self.reasoning_effort = effort;
        Ok(self)
    }

    fn request_body(&self, kind: Kind, data: &Value) -> Value {
        let data = data
            .to_string()
            .replace('<', "\\u003c")
            .replace('>', "\\u003e");
        let mut body = json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_text(kind)},
                {"role": "user", "content": format!("<untrusted-data>\n{data}\n</untrusted-data>")}
            ],
            "response_format": {"type": "json_object"},
            "max_completion_tokens": self.max_completion_tokens,
        });
        if let Some(effort) = &self.reasoning_effort {
            body["reasoning_effort"] = json!(effort);
        }
        body
    }

    async fn complete(&self, kind: Kind, data: &Value) -> Result<String, ModelError> {
        let body = self.request_body(kind, data);
        for delay in [Some(5), Some(30), None] {
            let response = self
                .client
                .post(self.endpoint.clone())
                .bearer_auth(&self.token)
                .json(&body)
                .send()
                .await;
            let retry = match response {
                Ok(resp)
                    if resp.status() == StatusCode::TOO_MANY_REQUESTS
                        || resp.status().is_server_error() =>
                {
                    status_error(resp.status())
                }
                response => {
                    let result = match response {
                        Ok(response) => decode(response).await,
                        Err(error) => Err(ReadError::Transport(error)),
                    };
                    match result {
                        Ok(content) => return Ok(content),
                        Err(ReadError::Model(error)) => return Err(error),
                        Err(ReadError::Transport(error)) => {
                            let transient = error.is_connect() || error.is_timeout();
                            let error = transport(error);
                            if !transient {
                                return Err(error);
                            }
                            error
                        }
                    }
                }
            };
            match delay {
                Some(seconds) => tokio::time::sleep(Duration::from_secs(seconds)).await,
                None => return Err(retry),
            }
        }
        unreachable!()
    }
}

fn validate_effort(effort: Option<&str>) -> io::Result<()> {
    match effort {
        None | Some("low" | "medium" | "high" | "xhigh" | "max" | "ultra") => Ok(()),
        _ => Err(io::Error::other("Invalid ACCLIMATE_MODEL_REASONING_EFFORT")),
    }
}

fn status_error(status: StatusCode) -> ModelError {
    ModelError::Provider(format!("provider returned {}", status.as_u16()))
}

fn transport(error: reqwest::Error) -> ModelError {
    ModelError::Provider(
        if error.is_timeout() {
            "provider timeout"
        } else if error.is_connect() {
            "provider connection failed"
        } else {
            "provider transport failed"
        }
        .into(),
    )
}

enum ReadError {
    Transport(reqwest::Error),
    Model(ModelError),
}

async fn decode(mut response: Response) -> Result<String, ReadError> {
    let status = response.status();
    let model_error = |e| Err(ReadError::Model(e));
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        return model_error(ModelError::ContextTooLarge);
    }
    if !status.is_success() && status != StatusCode::BAD_REQUEST {
        return model_error(status_error(status));
    }
    let limit = if status.is_success() {
        4 * 1024 * 1024
    } else {
        64 * 1024
    };
    let mut raw = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(ReadError::Transport)? {
        let remaining = limit - raw.len();
        if chunk.len() > remaining {
            if status.is_success() {
                return model_error(ModelError::Provider("provider response too large".into()));
            }
            raw.extend_from_slice(&chunk[..remaining]);
            break;
        }
        raw.extend_from_slice(&chunk);
        if !status.is_success() && raw.len() == limit {
            break;
        }
    }
    let outer = serde_json::from_slice::<Value>(&raw);
    if status == StatusCode::BAD_REQUEST {
        static CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(
            r"(?i)context (length|window)|maximum context|prompt is too long|too many (input )?tokens"
        ).expect("valid context pattern")
        });
        if let Ok(body) = outer
            && (body["error"]["code"] == "context_length_exceeded"
                || body["error"]["message"]
                    .as_str()
                    .is_some_and(|message| CONTEXT.is_match(message)))
        {
            return model_error(ModelError::ContextTooLarge);
        }
        return model_error(status_error(status));
    }
    let outer =
        outer.map_err(|_| ReadError::Model(ModelError::Format("Invalid provider JSON".into())))?;
    match outer["choices"][0]["finish_reason"].as_str() {
        Some("stop") => outer["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                ReadError::Model(ModelError::Format(
                    "Provider response missing content".into(),
                ))
            }),
        Some("length") => model_error(ModelError::Format(
            "output exceeded ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS; return a smaller change".into(),
        )),
        _ => model_error(ModelError::Provider(
            "provider did not stop normally".into(),
        )),
    }
}

impl OptimizerModel for OpenAiModel {
    fn model(&self) -> &str {
        &self.model
    }
    fn reasoning_effort(&self) -> Option<&str> {
        self.reasoning_effort.as_deref()
    }
    fn propose<'a>(&'a self, data: &'a Value) -> ModelFuture<'a> {
        Box::pin(self.complete(Kind::Propose, data))
    }
    fn screen<'a>(&'a self, data: &'a Value) -> ModelFuture<'a> {
        Box::pin(self.complete(Kind::Screen, data))
    }
    fn select<'a>(&'a self, data: &'a Value) -> ModelFuture<'a> {
        Box::pin(self.complete(Kind::Select, data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_body_omits_unset_effort_and_sends_configured_effort() {
        let endpoint = "http://localhost/completions";
        let model =
            OpenAiModel::new(endpoint, "fixture".into(), "gpt-6.2-astra", 30, 1234).unwrap();
        let data = json!({});
        assert!(
            model
                .request_body(Kind::Propose, &data)
                .get("reasoning_effort")
                .is_none()
        );
        let model = model.with_reasoning_effort(Some("high".into())).unwrap();
        for kind in [Kind::Propose, Kind::Screen, Kind::Select] {
            let body = model.request_body(kind, &data);
            assert_eq!(body["model"], "gpt-6.2-astra");
            assert_eq!(body["reasoning_effort"], "high");
        }
    }

    #[test]
    fn accepts_only_supported_efforts() {
        for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
            assert!(validate_effort(Some(effort)).is_ok());
        }
        for effort in ["", "minimal", "High", "high ", "none"] {
            assert!(validate_effort(Some(effort)).is_err());
        }
    }
}
