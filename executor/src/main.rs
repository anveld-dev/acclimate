mod gateway;
mod grading;

use gateway::{Gateway, Record};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
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
    #[serde(flatten)]
    job: Job,
    limits: Option<Limits>,
    #[serde(skip)]
    task_record: Arc<Mutex<Record>>,
    #[serde(skip)]
    judge_record: Arc<Mutex<Record>>,
    provider: Provider,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Job {
    Probe {
        models: Vec<String>,
    },
    Rollout {
        harness: String,
        bundle: Value,
        input: Value,
        task_model: String,
    },
    Grade {
        grader: Value,
        output: Value,
        judge_model: Option<String>,
        judge_runs: Option<u64>,
    },
    Conversion {
        material: Value,
        judge_model: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_tokens: u64,
    judge_max_tokens: Option<u64>,
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
    async fn rollout(
        &self,
        l: &Lease,
        name: &str,
        created: tokio::sync::oneshot::Sender<()>,
    ) -> Result<Value, Failure> {
        let (bundle, input, task_model) = match &l.job {
            Job::Probe { models } => {
                let mut results = Vec::new();
                for model in models {
                    let gateway = Gateway::new(
                        &l.provider,
                        model,
                        u64::MAX,
                        Default::default(),
                        watch::channel(()).1,
                    );
                    results.push(gateway.probe().await);
                }
                return Ok(json!({"models":results}));
            }
            Job::Grade {
                grader,
                output,
                judge_model,
                judge_runs,
            } => {
                return self
                    .grade(
                        l,
                        grader,
                        judge_model.as_deref(),
                        *judge_runs,
                        output,
                        &[],
                        (0, 0),
                        "completed",
                        None,
                    )
                    .await;
            }
            Job::Conversion {
                material,
                judge_model,
            } => {
                return self.convert(l, material, judge_model).await;
            }
            Job::Rollout {
                harness,
                bundle,
                input,
                task_model,
            } if harness == "chat" && !l.provider.api_key.is_empty() => (bundle, input, task_model),
            _ => return Err("executor".into()),
        };
        let limits = l.limits.as_ref().ok_or("executor")?;
        let (dir, _lock) = lease_dir(&self.root).map_err(start_failure)?;
        let payload = json!({"bundle":bundle,"input":input,"model":task_model,"timeoutSeconds":limits.timeout_seconds});
        fs::write(dir.path().join("input"), payload.to_string()).map_err(start_failure)?;
        let socket = UnixListener::bind(dir.path().join("gateway")).map_err(start_failure)?;
        for (path, mode) in [
            (dir.path().to_owned(), 0o711),
            (dir.path().join("gateway"), 0o666),
            (dir.path().join("input"), 0o444),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(start_failure)?;
        }
        let record = l.task_record.clone();
        let (shutdown, closed) = watch::channel(());
        let gateway = Gateway::new(
            &l.provider,
            task_model,
            limits.max_tokens,
            record.clone(),
            closed.clone(),
        );
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
        self.create_sandbox(name, &mount).await?;
        let _ = created.send(());
        let run = bounded_command(
            Command::new("docker").args(["start", "-a", name]),
            Duration::from_secs(limits.timeout_seconds),
        )
        .await;
        drop(shutdown);
        let (stop, output, reason, log, input, completion) = {
            let record = record.lock().unwrap();
            let (stop, output, reason) = classify_runner(run, &record)?;
            (
                stop,
                output,
                reason,
                record.log.clone(),
                record.input,
                record.output,
            )
        };
        let report = json!({"output":output,"stop":stop,"gatewayLog":log});
        checked_size(&report)?;
        let grade: Value = self
            .post(l, "output")
            .json(&report)
            .send()
            .await
            .map_err(executor_failure)?
            .error_for_status()
            .map_err(executor_failure)?
            .json()
            .await
            .map_err(executor_failure)?;
        self.grade(
            l,
            &grade["grader"],
            grade["judgeModel"].as_str(),
            grade["judgeRuns"].as_u64(),
            &output,
            &log,
            (input, completion),
            stop,
            reason,
        )
        .await
    }
    async fn create_sandbox(&self, name: &str, mount: &str) -> Result<(), Failure> {
        let mut command = Command::new("docker");
        command.args([
            "create",
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
            "--memory-swap",
            "256m",
            "--cpus",
            "1",
            "--log-driver",
            "none",
            "--mount",
            mount,
            &self.image,
        ]);
        let result = bounded_command(&mut command, Duration::from_secs(30))
            .await
            .map_err(start_failure)?
            .map_err(start_failure)?;
        if !result.status.success() {
            return Err(start_failure(String::from_utf8_lossy(&result.stderr)));
        }
        Ok(())
    }
    async fn once(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .client
            .post(&self.leases)
            .bearer_auth(&self.token)
            .json(&json!({"executor":self.identity,"waitSeconds":25}))
            .send()
            .await?
            .error_for_status()?;
        if response.status() == 204 {
            return Ok(());
        }
        let lease: Lease = response.json().await?;
        let name = format!("acclimate-{}", Uuid::new_v4());
        let (created, ready) = tokio::sync::oneshot::channel();
        let result = tokio::select! {
            _=async {
                self.expired(&lease).await;
                if matches!(lease.job,Job::Rollout{..}) {let _=ready.await;}
            }=>None,
            result=self.rollout(&lease,&name,created)=>Some(result),
        };
        let cleanup = if matches!(lease.job, Job::Rollout { .. }) {
            remove(&name).await
        } else {
            Ok(())
        };
        if let Some(result) = result {
            let body = cleanup
                .and(result)
                .and_then(|body| {
                    checked_size(&body)?;
                    Ok(body)
                })
                .unwrap_or_else(|err| self.error_report(&lease, err));
            self.post(&lease, "result")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
        } else if let Err(err) = cleanup {
            self.error_report(&lease, err);
        }
        Ok(())
    }
    fn error_report(&self, lease: &Lease, err: Failure) -> Value {
        let mut message = err.message;
        for secret in [&lease.provider.api_key, &lease.lease_token, &self.token] {
            if !secret.is_empty() {
                message = message.replace(secret, "[redacted]");
            }
        }
        eprintln!("{}: {}", err.code, message);
        let counts = |record: &Mutex<Record>| {
            let r = record.lock().unwrap();
            json!({"input":r.input,"output":r.output})
        };
        json!({"error":{"code":err.code,"message":message},"tokens":{"task":counts(&lease.task_record),"judge":counts(&lease.judge_record)}})
    }
}
fn lease_dir(root: &std::path::Path) -> std::io::Result<(tempfile::TempDir, fs::File)> {
    let guard = fs::File::open(root)?;
    guard.lock()?;
    let dir = tempfile::Builder::new().prefix("lease-").tempdir_in(root)?;
    let lock = fs::File::open(dir.path())?;
    lock.lock()?;
    Ok((dir, lock))
}
fn cleanup_stale(root: &std::path::Path) -> std::io::Result<()> {
    let guard = fs::File::open(root)?;
    guard.lock()?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with("lease-") && entry.file_type()?.is_dir()
        {
            match fs::File::open(entry.path()) {
                Ok(file) if file.try_lock().is_ok() => fs::remove_dir_all(entry.path())?,
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => (),
            }
        }
    }
    Ok(())
}
#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
}
impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            message: code.into(),
        }
    }
}
fn executor_failure(error: impl std::fmt::Display) -> Failure {
    Failure {
        code: "executor",
        message: error.to_string(),
    }
}
fn start_failure(error: impl std::fmt::Display) -> Failure {
    Failure {
        code: "sandbox-start",
        message: error.to_string(),
    }
}
fn checked_size(body: &Value) -> Result<(), Failure> {
    if serde_json::to_vec(body).unwrap().len() > 16 * 1024 * 1024 {
        return Err(Failure {
            code: "executor",
            message: "Executor report exceeds 16 MiB".into(),
        });
    }
    Ok(())
}
type CommandResult = Result<std::io::Result<std::process::Output>, tokio::time::error::Elapsed>;
fn upstream_deadline() -> Failure {
    Failure {
        code: "gateway-upstream",
        message: "Gateway call still pending at rollout deadline".into(),
    }
}
fn classify_runner(
    run: CommandResult,
    r: &Record,
) -> Result<(&'static str, Value, Option<&'static str>), Failure> {
    let (mut stop, mut output) = ("completed", Value::Null);
    if let Some(message) = &r.failure {
        return Err(Failure {
            code: "gateway-upstream",
            message: message.clone(),
        });
    }
    match run {
        _ if r.invalid.is_some() => stop = "invalid-output",
        Err(_) if r.pending => return Err(upstream_deadline()),
        Ok(Ok(ref p)) if p.status.code() == Some(124) && r.pending => {
            return Err(upstream_deadline());
        }
        Err(_) => stop = "time-limit",
        Ok(Ok(ref p)) if p.status.code() == Some(124) => stop = "time-limit",
        Ok(Ok(ref p)) if p.status.success() => {
            output = serde_json::from_slice(&p.stdout).map_err(executor_failure)?;
            if r.capped {
                stop = "token-limit"
            }
        }
        _ if r.capped => stop = "token-limit",
        Ok(Ok(ref p)) if p.status.code() == Some(65) => {
            return Err(Failure {
                code: "gateway-upstream",
                message: "Provider reply did not contain text".into(),
            });
        }
        Ok(Ok(ref p))
            if !matches!(p.status.code(), Some(125..=127))
                && !p.stderr.starts_with(b"Error response from daemon:") =>
        {
            return Err(Failure {
                code: "executor",
                message: format!(
                    "Runner exited with {}: {}",
                    p.status,
                    String::from_utf8_lossy(&p.stderr)
                ),
            });
        }
        Ok(Ok(p)) => return Err(start_failure(String::from_utf8_lossy(&p.stderr))),
        Ok(Err(e)) => return Err(start_failure(e)),
    }

    Ok((
        stop,
        output,
        r.invalid.or(r
            .truncated
            .then_some("Provider truncated the answer (finish_reason=length)")),
    ))
}
async fn bounded_command(command: &mut Command, limit: Duration) -> CommandResult {
    timeout(limit, command.kill_on_drop(true).output()).await
}
async fn remove(name: &str) -> Result<(), Failure> {
    timeout(Duration::from_secs(15), async {
        loop {
            let res = Command::new("docker")
                .args(["rm", "-f", name])
                .kill_on_drop(true)
                .output()
                .await
                .map_err(start_failure)?;
            let error = String::from_utf8_lossy(&res.stderr);
            if res.status.success() || error.contains("No such container") {
                return Ok(());
            }
            if !removal_in_progress(&error, name) {
                return Err(start_failure(error));
            }
            // Docker's automatic removal may have won the race with explicit cleanup.
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(start_failure)?
}
fn removal_in_progress(error: &str, name: &str) -> bool {
    error.contains(&format!(
        "removal of container {name} is already in progress"
    ))
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
    let inspect = bounded_command(
        Command::new("docker").args(["image", "inspect", "--format", "{{.Id}}", &runner]),
        Duration::from_secs(15),
    )
    .await??;
    if !inspect.status.success() {
        return Err(format!(
            "Inspecting runner image failed: {}",
            String::from_utf8_lossy(&inspect.stderr)
        )
        .into());
    }
    let image = String::from_utf8(inspect.stdout)?.trim().to_owned();
    let build = option_env!("ACCLIMATE_EXECUTOR_BUILD").unwrap_or(env!("CARGO_PKG_VERSION"));
    let identity = json!({"build":build,"harnesses":{"chat":"1"},"sandboxRuntime":runtime,"runnerImage":image});
    let root = PathBuf::from(
        env::var("ACCLIMATE_SANDBOX_DIR").unwrap_or_else(|_| "/var/lib/acclimate-executor".into()),
    );
    fs::create_dir_all(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    cleanup_stale(&root)?;
    let worker = Arc::new(Worker {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(600))
            .build()?,
        leases: format!(
            "{}/internal/executor/leases",
            env::var("ACCLIMATE_EXECUTOR_SERVICE")?.trim_end_matches('/')
        ),
        token: match env::var_os("ACCLIMATE_EXECUTOR_TOKEN_FILE") {
            Some(path) => fs::read_to_string(path)?.trim().to_owned(),
            None => env::var("ACCLIMATE_EXECUTOR_TOKEN")?,
        },
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
    if worker.token.is_empty() {
        return Err("Empty executor credential".into());
    }
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let (drain, stop) = watch::channel(false);
    for _ in 0..count.get() {
        let w = worker.clone();
        let stop = stop.clone();
        workers.spawn(async move {
            while !*stop.borrow() {
                if let Err(error) = w.once().await {
                    eprintln!("Executor lease request or report failed: {error}");
                    sleep(Duration::from_secs(1)).await;
                }
            }
        });
    }
    tokio::select! {_=terminate.recv()=>(),_=workers.join_next()=>return Err("Executor worker stopped".into())};
    drain.send_replace(true);
    while let Some(result) = workers.join_next().await {
        result?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_only_the_pending_removal_of_this_container() {
        let message =
            "Error response from daemon: removal of container acclimate-1 is already in progress";
        assert!(removal_in_progress(message, "acclimate-1"));
        assert!(!removal_in_progress(message, "acclimate-2"));
        assert!(!removal_in_progress("permission denied", "acclimate-1"));
    }
    #[test]
    fn runner_deadline_depends_on_pending_upstream() {
        use std::os::unix::process::ExitStatusExt;
        let timed_out = || {
            Ok(Ok(std::process::Output {
                status: std::process::ExitStatus::from_raw(124 << 8),
                stdout: vec![],
                stderr: vec![],
            }))
        };
        assert_eq!(
            classify_runner(timed_out(), &Record::default()).unwrap().0,
            "time-limit"
        );
        let pending = Record {
            pending: true,
            ..Default::default()
        };
        assert_eq!(
            classify_runner(timed_out(), &pending).unwrap_err().code,
            "gateway-upstream"
        );
    }
    #[test]
    fn report_body_limit() {
        assert!(checked_size(&json!("x".repeat(16 * 1024 * 1024))).is_err());
    }
    #[tokio::test]
    async fn hanging_command_times_out() {
        assert!(
            bounded_command(Command::new("sleep").arg("60"), Duration::from_millis(5))
                .await
                .is_err()
        );
    }
    #[test]
    fn removes_only_stale_lease_dirs() {
        let root = tempfile::tempdir().unwrap();
        let (live, _lock) = lease_dir(root.path()).unwrap();
        let stale = root.path().join("lease-stale");
        fs::create_dir(&stale).unwrap();
        cleanup_stale(root.path()).unwrap();
        assert!(live.path().is_dir() && !stale.exists());
    }
    #[test]
    fn missing_bundle_rejected() {
        assert!(
            serde_json::from_value::<Job>(
                json!({"kind":"rollout","harness":"chat","taskModel":"task","input":null})
            )
            .is_err()
        );
    }
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
