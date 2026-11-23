mod gateway;
mod grading;

use gateway::{Gateway, Record};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
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
            match self.post(l, "heartbeat").json(&json!({})).send().await {
                Ok(r) if r.status() == 409 => return,
                // A long rollout does not poll, so its heartbeats keep the executor healthy.
                Ok(r) if r.status().is_success() => touch_health(),
                _ => (),
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
        let payload = json!({"bundle":bundle,"input":input,"model":task_model,"timeoutSeconds":limits.timeout_seconds});
        let (dir, _lock, socket) =
            open_lease(&self.root, payload.to_string().as_bytes()).map_err(start_failure)?;
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
        self.create_sandbox(name, &self.mount(dir.path()), &[])
            .await?;
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
    fn mount(&self, dir: &Path) -> String {
        match &self.volume {
            Some(v) => format!(
                "type=volume,source={v},volume-subpath={},target=/lease,readonly",
                dir.file_name().unwrap().to_string_lossy()
            ),
            None => format!("type=bind,source={},target=/lease,readonly", dir.display()),
        }
    }
    /// `command` replaces the runner's entrypoint. Rollouts pass none.
    async fn create_sandbox(
        &self,
        name: &str,
        mount: &str,
        command: &[&str],
    ) -> Result<(), Failure> {
        let mut docker = Command::new("docker");
        docker.args(sandbox_args(
            &self.runtime,
            name,
            mount,
            &self.image,
            command,
        ));
        let result = bounded_command(&mut docker, Duration::from_secs(30))
            .await
            .map_err(start_failure)?
            .map_err(start_failure)?;
        if !result.status.success() {
            return Err(start_failure(String::from_utf8_lossy(&result.stderr)));
        }
        Ok(())
    }
    /// Run one throwaway sandbox exactly as a rollout does, so a missing runtime fails at startup
    /// rather than in every rollout. Provider verification runs outside the sandbox and cannot
    /// show it.
    async fn preflight(&self) -> Result<(), String> {
        let name = format!("acclimate-preflight-{}", Uuid::new_v4());
        let (dir, _lock, socket) = open_lease(&self.root, b"{}").map_err(|error| {
            format!(
                "Sandbox preflight could not prepare a lease directory in {}: {error}",
                self.root.display()
            )
        })?;
        let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server = tokio::spawn({
            let answered = answered.clone();
            async move {
                while let Ok((stream, _)) = socket.accept().await {
                    if stream.writable().await.is_ok() && stream.try_write(b"ok").is_ok() {
                        answered.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            }
        });
        let outcome = match self
            .create_sandbox(&name, &self.mount(dir.path()), PREFLIGHT_COMMAND)
            .await
        {
            Err(failure) => Err(PreflightStage::Create(failure.message)),
            Ok(()) => {
                let run = bounded_command(
                    Command::new("docker").args(["start", "-a", &name]),
                    Duration::from_secs(60),
                )
                .await;
                match run {
                    Err(_) => Err(PreflightStage::Timeout),
                    Ok(Err(error)) => Err(PreflightStage::Run(error.to_string())),
                    Ok(Ok(out)) => match out.status.code() {
                        Some(0) if answered.load(std::sync::atomic::Ordering::SeqCst) => Ok(()),
                        Some(3) | Some(0) => Err(PreflightStage::Socket),
                        Some(4) => Err(PreflightStage::Input),
                        _ => Err(PreflightStage::Run(format!(
                            "{}: {}",
                            out.status,
                            String::from_utf8_lossy(&out.stderr).trim()
                        ))),
                    },
                }
            }
        };
        server.abort();
        let removed = remove(&name).await;
        drop(dir);
        outcome.map_err(|stage| preflight_message(&stage, &self.runtime, &self.image))?;
        removed.map_err(|failure| {
            format!(
                "Sandbox preflight could not remove its container {name}: {}",
                failure.message
            )
        })
    }
    async fn once(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .client
            .post(&self.leases)
            .bearer_auth(&self.token)
            .json(&json!({"executor":self.identity,"waitSeconds":25}))
            .send()
            .await?;
        if credential_refused(response.status()) {
            return Err(Box::new(CredentialRefused));
        }
        let response = response.error_for_status()?;
        touch_health();
        if response.status() == 204 {
            return Ok(());
        }
        let lease: Lease = response.json().await?;
        let name = format!("acclimate-{}", Uuid::new_v4());
        let rollout = matches!(lease.job, Job::Rollout { .. });
        if rollout {
            SANDBOXES.lock().unwrap().insert(name.clone());
        }
        let (created, ready) = tokio::sync::oneshot::channel();
        let result = tokio::select! {
            _=async {
                self.expired(&lease).await;
                if matches!(lease.job,Job::Rollout{..}) {let _=ready.await;}
            }=>None,
            result=self.rollout(&lease,&name,created)=>Some(result),
        };
        let cleanup = if rollout {
            let removed = remove(&name).await;
            SANDBOXES.lock().unwrap().remove(&name);
            removed
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
/// A lease directory holding the runner input and the gateway socket, readable by the runner's
/// unprivileged user.
fn open_lease(
    root: &Path,
    input: &[u8],
) -> std::io::Result<(tempfile::TempDir, fs::File, UnixListener)> {
    let (dir, lock) = lease_dir(root)?;
    fs::write(dir.path().join("input"), input)?;
    let socket = UnixListener::bind(dir.path().join("gateway"))?;
    for (path, mode) in [
        (dir.path().to_owned(), 0o711),
        (dir.path().join("gateway"), 0o666),
        (dir.path().join("input"), 0o444),
    ] {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok((dir, lock, socket))
}
fn sandbox_args(
    runtime: &str,
    name: &str,
    mount: &str,
    image: &str,
    command: &[&str],
) -> Vec<String> {
    let mut args = [
        "create",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--network",
        "none",
        "--runtime",
        if runtime == "docker" { "runc" } else { runtime },
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
    ]
    .map(String::from)
    .to_vec();
    if let Some((entrypoint, rest)) = command.split_first() {
        args.extend(["--entrypoint".into(), entrypoint.to_string()]);
        args.push(image.into());
        args.extend(rest.iter().map(|arg| arg.to_string()));
    } else {
        args.push(image.into());
    }
    args
}
/// Reads the input and reaches the gateway socket the way the chat runner does. Exit 4 means the
/// lease directory was not readable and 3 that the socket could not be reached.
const PREFLIGHT_COMMAND: &[&str] = &[
    "node",
    "-e",
    "try{require('fs').readFileSync('/lease/input')}catch{process.exit(4)}\
     const s=require('net').connect('/lease/gateway');\
     s.on('data',d=>process.exit(String(d)==='ok'?0:3));\
     s.on('error',()=>process.exit(3));\
     setTimeout(()=>process.exit(3),10000);",
];
enum PreflightStage {
    Create(String),
    Run(String),
    Timeout,
    Input,
    Socket,
}
fn preflight_message(stage: &PreflightStage, runtime: &str, image: &str) -> String {
    let runtime = if runtime == "docker" { "runc" } else { runtime };
    let registered = format!(
        "the Docker daemon has the `{runtime}` runtime registered: `docker info --format '{{{{json .Runtimes}}}}'` must list it"
    );
    let gvisor = "for gVisor, register `runsc` in /etc/docker/daemon.json with \"runtimeArgs\": [\"--host-uds=open\"] and restart Docker";
    let runner = format!(
        "the runner image {image} exists and matches this executor: `docker compose build acclimate-runner`"
    );
    let (what, checks) = match stage {
        PreflightStage::Create(detail) => (
            format!("could not create a sandbox container: {}", detail.trim()),
            vec![registered, gvisor.into(), runner],
        ),
        PreflightStage::Run(detail) => (
            format!("the sandbox container did not run: {detail}"),
            vec![registered, gvisor.into(), runner],
        ),
        PreflightStage::Timeout => (
            "the sandbox container did not finish within 60 seconds".into(),
            vec![registered, gvisor.into()],
        ),
        PreflightStage::Input => (
            "the sandboxed process could not read its lease directory".into(),
            vec![
                "Docker Engine is 26 or later, which the lease volume subpath mount needs".into(),
                "ACCLIMATE_SANDBOX_VOLUME names the volume mounted at ACCLIMATE_SANDBOX_DIR".into(),
            ],
        ),
        PreflightStage::Socket => (
            "the sandboxed process could not reach the gateway socket in its lease directory"
                .into(),
            vec![gvisor.into(), registered],
        ),
    };
    format!(
        "Sandbox preflight failed: {what}. Every rollout would fail the same way, so the executor will not start. Check that:\n{}",
        checks
            .iter()
            .map(|check| format!("- {check}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
/// Exit status for configuration the executor cannot run with (EX_CONFIG).
const EXIT_CONFIG: i32 = 78;
const CREDENTIAL_HELP: &str = "Create a credential with `acclimate-service --create-executor-token`, save its token in the file that ACCLIMATE_EXECUTOR_TOKEN_FILE names, and restart the executor.";
fn fatal(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(EXIT_CONFIG)
}
#[derive(Debug)]
struct CredentialRefused;
impl std::fmt::Display for CredentialRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "The service refused the executor credential (HTTP 401): the token is wrong, revoked or missing. {CREDENTIAL_HELP}"
        )
    }
}
impl std::error::Error for CredentialRefused {}
/// The lease route answers 401 only for a bad credential. Retrying cannot fix it.
fn credential_refused(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED
}
const HEALTH_MAX_AGE: Duration = Duration::from_secs(120);
fn health_path() -> PathBuf {
    env::var_os("ACCLIMATE_EXECUTOR_HEALTH_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/tmp/acclimate-executor-health".into())
}
static HEALTH_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
/// Record that the service answered. The health check reads only the modification time.
fn touch_health() {
    if let Some(path) = HEALTH_FILE.get() {
        touch(path);
    }
}
fn touch(path: &Path) {
    if let Err(error) = fs::File::create(path).and_then(|file| file.set_modified(SystemTime::now()))
    {
        eprintln!(
            "Could not update the health file {}: {error}",
            path.display()
        );
    }
}
fn healthy(path: &Path, now: SystemTime) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| {
            now.duration_since(modified)
                .is_ok_and(|age| age <= HEALTH_MAX_AGE)
                || modified > now
        })
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
/// A provider failure that may clear by waiting (rate limit, server error, transport error or
/// timeout) is `gateway-upstream`; one that will not is `provider-rejected`.
fn provider_failure_code(r: &Record) -> &'static str {
    if r.rejected {
        "provider-rejected"
    } else {
        "gateway-upstream"
    }
}
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
            code: provider_failure_code(r),
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
                code: "provider-rejected",
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
/// The sandbox containers this executor's workers have started and not yet removed. A worker
/// that is aborted leaves its name here, so the executor can remove the container on exit.
static SANDBOXES: Mutex<std::collections::BTreeSet<String>> =
    Mutex::new(std::collections::BTreeSet::new());
/// Remove every sandbox left by an aborted worker. Each removal is bounded, and they run
/// together, so this cannot hold up the exit for long.
async fn remove_sandboxes() {
    let names = std::mem::take(&mut *SANDBOXES.lock().unwrap());
    let mut removals = tokio::task::JoinSet::new();
    for name in names {
        removals.spawn(async move {
            if let Err(failure) = remove(&name).await {
                eprintln!("Could not remove sandbox {name}: {}", failure.message);
            }
        });
    }
    let _ = timeout(Duration::from_secs(20), removals.join_all()).await;
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
    let health = health_path();
    if env::args().nth(1).as_deref() == Some("--health") {
        if healthy(&health, SystemTime::now()) {
            return Ok(());
        }
        eprintln!(
            "The executor has not reached the service in the last {} seconds. Read its logs.",
            HEALTH_MAX_AGE.as_secs()
        );
        std::process::exit(1);
    }
    // A file left by an earlier run of this container must not report this one healthy.
    let _ = fs::remove_file(&health);
    let _ = HEALTH_FILE.set(health);
    let runtime = env::var("ACCLIMATE_SANDBOX_RUNTIME").unwrap_or_else(|_| "runsc".into());
    match runtime.as_str() {
        "docker" => eprintln!("WARNING: plain Docker sandbox isolation is weaker than gVisor"),
        "runsc" => (),
        _ => fatal(format!(
            "Unsupported sandbox runtime {runtime:?}. Set ACCLIMATE_SANDBOX_RUNTIME to runsc (gVisor) or docker."
        )),
    }
    let token = match env::var_os("ACCLIMATE_EXECUTOR_TOKEN_FILE") {
        Some(path) => fs::read_to_string(&path)
            .unwrap_or_else(|error| {
                fatal(format!(
                    "Cannot read the executor credential file {} that ACCLIMATE_EXECUTOR_TOKEN_FILE names: {error}. {CREDENTIAL_HELP}",
                    Path::new(&path).display()
                ))
            })
            .trim()
            .to_owned(),
        None => env::var("ACCLIMATE_EXECUTOR_TOKEN").unwrap_or_default(),
    };
    if token.is_empty() {
        fatal(format!(
            "The executor credential is empty. {CREDENTIAL_HELP}"
        ));
    }
    let runner = env::var("ACCLIMATE_RUNNER_IMAGE").unwrap_or_else(|_| "acclimate-chat:1".into());
    let inspect = bounded_command(
        Command::new("docker").args(["image", "inspect", "--format", "{{.Id}}", &runner]),
        Duration::from_secs(15),
    )
    .await??;
    if !inspect.status.success() {
        fatal(format!(
            "Inspecting the runner image {runner} failed: {}. Build or pull it before starting the executor (`docker compose build acclimate-runner` or `docker compose pull acclimate-runner`), or set ACCLIMATE_RUNNER_IMAGE.",
            String::from_utf8_lossy(&inspect.stderr).trim()
        ));
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
        token,
        runtime,
        image,
        identity,
        root,
        volume: env::var("ACCLIMATE_SANDBOX_VOLUME").ok(),
    });
    let count: std::num::NonZeroUsize = env::var("ACCLIMATE_EXECUTOR_CONCURRENCY")
        .unwrap_or_else(|_| "1".into())
        .parse()?;
    if let Err(message) = worker.preflight().await {
        fatal(message);
    }
    let mut workers = tokio::task::JoinSet::new();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let (drain, stop) = watch::channel(false);
    for _ in 0..count.get() {
        let w = worker.clone();
        let stop = stop.clone();
        workers.spawn(async move {
            while !*stop.borrow() {
                match w.once().await {
                    Ok(()) => (),
                    Err(error) if error.is::<CredentialRefused>() => return Err(error.to_string()),
                    Err(error) => {
                        eprintln!("Executor lease request or report failed: {error}");
                        sleep(Duration::from_secs(1)).await;
                    }
                }
            }
            Ok(())
        });
    }
    tokio::select! {
        _ = terminate.recv() => (),
        stopped = workers.join_next() => {
            if let Some(Ok(Err(message))) = stopped {
                refused(message, &mut workers).await;
            }
            return Err("Executor worker stopped".into());
        }
    };
    drain.send_replace(true);
    while let Some(result) = workers.join_next().await {
        if let Err(message) = result? {
            refused(message, &mut workers).await;
        }
    }
    Ok(())
}
/// Stop the other workers and remove the sandboxes they started before exiting. Aborting a
/// worker stops its own work, but a sandbox container keeps running until it is removed.
async fn refused(message: String, workers: &mut tokio::task::JoinSet<Result<(), String>>) -> ! {
    workers.abort_all();
    while workers.join_next().await.is_some() {}
    remove_sandboxes().await;
    fatal(message)
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
    #[tokio::test]
    async fn exit_removes_the_sandboxes_aborted_workers_left() {
        let name = format!("acclimate-{}", Uuid::new_v4());
        SANDBOXES.lock().unwrap().insert(name.clone());
        // Removing a container that does not exist succeeds, and a missing Docker is logged.
        remove_sandboxes().await;
        assert!(!SANDBOXES.lock().unwrap().contains(&name));
    }
    #[test]
    fn only_a_refused_credential_stops_the_executor() {
        assert!(credential_refused(reqwest::StatusCode::UNAUTHORIZED));
        for status in [403, 404, 409, 500, 502, 503] {
            assert!(!credential_refused(
                reqwest::StatusCode::from_u16(status).unwrap()
            ));
        }
        let message = CredentialRefused.to_string();
        assert!(message.contains("--create-executor-token"));
        assert!(message.contains("restart the executor"));
    }
    #[test]
    fn health_file_goes_stale_after_two_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("health");
        let now = SystemTime::now();
        assert!(!healthy(&path, now));
        touch(&path);
        assert!(healthy(&path, now));
        assert!(healthy(&path, now + Duration::from_secs(119)));
        assert!(!healthy(&path, now + Duration::from_secs(121)));
        // A clock step backwards does not report a fresh file stale.
        assert!(healthy(&path, now - Duration::from_secs(600)));
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(now - Duration::from_secs(300))
            .unwrap();
        assert!(!healthy(&path, now));
        touch(&path);
        assert!(healthy(&path, SystemTime::now()));
    }
    #[test]
    fn preflight_uses_the_rollout_sandbox_flags() {
        let rollout = sandbox_args("runsc", "n", "type=bind", "image", &[]);
        let preflight = sandbox_args("runsc", "n", "type=bind", "image", PREFLIGHT_COMMAND);
        assert_eq!(rollout.last().unwrap(), "image");
        let flags = &rollout[..rollout.len() - 1];
        assert_eq!(&preflight[..flags.len()], flags);
        assert_eq!(
            &preflight[flags.len()..flags.len() + 3],
            ["--entrypoint", "node", "image"]
        );
        assert_eq!(&preflight[flags.len() + 3..], &PREFLIGHT_COMMAND[1..]);
        for flag in [
            "--network",
            "none",
            "--read-only",
            "--cap-drop=ALL",
            "runsc",
        ] {
            assert!(rollout.iter().any(|arg| arg == flag));
        }
        assert!(
            sandbox_args("docker", "n", "m", "i", &[])
                .windows(2)
                .any(|w| w == ["--runtime", "runc"])
        );
    }
    #[test]
    fn preflight_failures_say_what_to_check() {
        let created = preflight_message(
            &PreflightStage::Create("unknown or invalid runtime name: runsc\n".into()),
            "runsc",
            "sha256:abc",
        );
        assert!(created.contains("unknown or invalid runtime name: runsc. Every rollout"));
        assert!(created.contains("`runsc` runtime registered"));
        assert!(created.contains("docker info --format '{{json .Runtimes}}'"));
        assert!(created.contains("--host-uds=open"));
        assert!(created.contains("sha256:abc"));
        let socket = preflight_message(&PreflightStage::Socket, "runsc", "i");
        assert!(socket.contains("gateway socket"));
        assert!(socket.lines().nth(1).unwrap().contains("--host-uds=open"));
        assert!(
            preflight_message(&PreflightStage::Create(String::new()), "docker", "i")
                .contains("`runc`")
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
