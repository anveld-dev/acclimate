mod gateway;
mod grading;

use gateway::{Gateway, Record};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::UnixListener,
    process::Command,
    sync::watch,
    time::{sleep, timeout},
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lease {
    lease_id: Uuid,
    lease_token: String,
    heartbeat_seconds: u64,
    kind: String,
    #[serde(default)]
    harness: String,
    bundle: Value,
    input: Value,
    #[serde(default)]
    task_model: String,
    judge_model: Option<String>,
    judge_runs: Option<u64>,
    grader: Value,
    output: Value,
    material: Value,
    limits: Limits,
    provider: Provider,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_tokens: u64,
    timeout_seconds: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    base_url: String,
    api_key: String,
}
struct Worker {
    client: reqwest::Client,
    leases: String,
    token: String,
    runtime: String,
    image: String,
    identity: Value,
    root: PathBuf,
    volume: Option<String>,
}
impl Worker {
    fn post(&self, l: &Lease, route: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}/{}/{}", self.leases, l.lease_id, route))
            .bearer_auth(&l.lease_token)
    }
    async fn expired(&self, l: &Lease) {
        loop {
            sleep(Duration::from_secs(l.heartbeat_seconds.max(1))).await;
            if self
                .post(l, "heartbeat")
                .json(&json!({}))
                .send()
                .await
                .is_ok_and(|r| r.status() == 409)
            {
                return;
            }
        }
    }
    async fn rollout(&self, l: &Lease, name: &str) -> Result<Value, &'static str> {
        if l.kind == "grade" {
            return self
                .grade(
                    l,
                    &l.grader,
                    l.judge_model.as_deref(),
                    l.judge_runs,
                    &l.output,
                    &[],
                    (0, 0),
                    "completed",
                )
                .await;
        }
        if l.kind == "conversion" {
            return self.convert(l).await;
        }
        if l.harness != "chat" || l.kind != "rollout" || l.provider.api_key.is_empty() {
            return Err("executor");
        }
        let dir = tempfile::Builder::new()
            .prefix("lease-")
            .tempdir_in(&self.root)
            .map_err(|_| "sandbox-start")?;
        let payload = json!({"bundle":l.bundle,"input":l.input,"model":l.task_model,"timeoutSeconds":l.limits.timeout_seconds});
        fs::write(dir.path().join("input"), payload.to_string()).map_err(|_| "sandbox-start")?;
        let socket = UnixListener::bind(dir.path().join("gateway")).map_err(|_| "sandbox-start")?;
        let record = Arc::new(Mutex::new(Record::default()));
        let (shutdown, closed) = watch::channel(());
        let gateway = Gateway {
            model: l.task_model.clone(),
            url: format!(
                "{}/chat/completions",
                l.provider.base_url.trim_end_matches('/')
            ),
            key: l.provider.api_key.clone(),
            cap: l.limits.max_tokens,
            client: self.client.clone(),
            record: record.clone(),
            serial: Default::default(),
            closed: closed.clone(),
        };
        tokio::spawn(async move {
            let mut closed = closed;
            let _ = axum::serve(socket, gateway::router(gateway))
                .with_graceful_shutdown(async move {
                    let _ = closed.changed().await;
                })
                .await;
        });
        let mount = match &self.volume {
            Some(v) => format!(
                "type=volume,source={v},volume-subpath={},target=/lease,readonly",
                dir.path().file_name().unwrap().to_string_lossy()
            ),
            None => format!(
                "type=bind,source={},target=/lease,readonly",
                dir.path().display()
            ),
        };
        let mut command = Command::new("docker");
        command.kill_on_drop(true).args([
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--network",
            "none",
            "--runtime",
            if self.runtime == "docker" {
                "runc"
            } else {
                &self.runtime
            },
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit",
            "64",
            "--memory",
            "256m",
            "--cpus",
            "1",
            "--log-driver",
            "none",
            "--mount",
            &mount,
            &self.image,
        ]);
        let run = timeout(
            Duration::from_secs(l.limits.timeout_seconds),
            command.output(),
        )
        .await;
        drop(shutdown);
        let (mut stop, mut output) = ("completed", Value::Null);
        let (log, input, completion) = {
            let r = record.lock().unwrap();
            if r.failed && run.is_ok() {
                return Err("gateway-upstream");
            }
            match run {
                Err(_) => stop = "time-limit",
                Ok(Ok(ref p)) if p.status.code() == Some(124) => stop = "time-limit",
                Ok(Ok(ref p)) if p.status.success() => {
                    output = serde_json::from_slice(&p.stdout).map_err(|_| "executor")?;
                    if r.capped {
                        stop = "token-limit"
                    }
                }
                _ if r.capped => stop = "token-limit",
                Ok(Ok(ref p)) if p.status.code() == Some(65) => return Err("gateway-upstream"),
                Ok(Ok(ref p)) if !matches!(p.status.code(), Some(125..=127)) => {
                    return Err("executor");
                }
                _ => return Err("sandbox-start"),
            }
            (r.log.clone(), r.input, r.output)
        };
        if stop == "time-limit" {
            remove(name).await?;
        }
        let grade: Value = self
            .post(l, "output")
            .json(&json!({"output":output,"stop":stop,"gatewayLog":log}))
            .send()
            .await
            .map_err(|_| "executor")?
            .error_for_status()
            .map_err(|_| "executor")?
            .json()
            .await
            .map_err(|_| "executor")?;
        self.grade(
            l,
            &grade["grader"],
            grade["judgeModel"].as_str(),
            grade["judgeRuns"].as_u64(),
            &output,
            &log,
            (input, completion),
            stop,
        )
        .await
    }
    async fn once(&self) -> Result<(), ()> {
        let response = self
            .client
            .post(&self.leases)
            .bearer_auth(&self.token)
            .json(&json!({"executor":self.identity}))
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?;
        if response.status() == 204 {
            return Ok(());
        }
        let lease: Lease = response.json().await.map_err(|_| ())?;
        let name = format!("acclimate-{}", Uuid::new_v4());
        tokio::select! {
            _=self.expired(&lease)=>{if lease.kind == "rollout" {remove(&name).await.map_err(|_|())?;}}
            result=async {
                let body=self.rollout(&lease,&name).await.unwrap_or_else(|code|json!({"error":{"code":code,"message":code}}));
                self.post(&lease,"result").json(&body).send().await?.error_for_status()
            }=>{result.map_err(|_|())?;}
        }
        Ok(())
    }
}
async fn remove(name: &str) -> Result<(), &'static str> {
    let res = Command::new("docker")
        .args(["rm", "-f", name])
        .output()
        .await
        .map_err(|_| "executor")?;
    if res.status.success() || String::from_utf8_lossy(&res.stderr).contains("No such container") {
        Ok(())
    } else {
        Err("executor")
    }
}
fn exact(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64().map(f64::to_bits) == y.as_f64().map(f64::to_bits)
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| exact(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| exact(v, w)))
        }
        _ => a == b,
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = env::var("ACCLIMATE_SANDBOX_RUNTIME").unwrap_or_else(|_| "runsc".into());
    match runtime.as_str() {
        "docker" => eprintln!("WARNING: plain Docker sandbox isolation is weaker than gVisor"),
        "runsc" => (),
        _ => return Err("Unsupported sandbox runtime".into()),
    }
    let runner = env::var("ACCLIMATE_RUNNER_IMAGE").unwrap_or_else(|_| "acclimate-chat:1".into());
    let inspect = Command::new("docker")
        .args(["image", "inspect", "--format", "{{.Id}}", &runner])
        .output()
        .await?;
    if !inspect.status.success() {
        return Err("Runner image must be installed before startup".into());
    }
    let image = String::from_utf8(inspect.stdout)?.trim().to_owned();
    let build = option_env!("ACCLIMATE_EXECUTOR_BUILD").unwrap_or(env!("CARGO_PKG_VERSION"));
    let identity = json!({"build":build,"harnesses":{"chat":"1"},"sandboxRuntime":runtime,"runnerImage":image});
    let root = PathBuf::from(
        env::var("ACCLIMATE_SANDBOX_DIR").unwrap_or_else(|_| "/var/lib/acclimate-executor".into()),
    );
    fs::create_dir_all(&root)?;
    let worker = Arc::new(Worker {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(600))
            .build()?,
        leases: format!(
            "{}/internal/executor/leases",
            env::var("ACCLIMATE_EXECUTOR_SERVICE")?.trim_end_matches('/')
        ),
        token: env::var("ACCLIMATE_EXECUTOR_TOKEN")?,
        runtime,
        image,
        identity,
        root,
        volume: env::var("ACCLIMATE_SANDBOX_VOLUME").ok(),
    });
    let count: std::num::NonZeroUsize = env::var("ACCLIMATE_EXECUTOR_CONCURRENCY")
        .unwrap_or_else(|_| "1".into())
        .parse()?;
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..count.get() {
        let w = worker.clone();
        workers.spawn(async move {
            loop {
                if w.once().await.is_err() {
                    eprintln!("Executor lease request or report failed")
                }
                sleep(Duration::from_secs(1)).await;
            }
        });
    }
    workers.join_next().await;
    Err("Executor worker stopped".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_json() {
        assert!(exact(
            &json!({"b":[1],"a":false}),
            &json!({"a":false,"b":[1.0]})
        ));
        assert!(!exact(&json!("1"), &json!(1)));
        assert!(!exact(&json!([1, 2]), &json!([2, 1])));
    }
}
