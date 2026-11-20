use acclimate_service::{
    AccessConfig, AppState, Grant, OpenAiModel, ProposalModel, RuntimeStatus, backfill_projects,
    connected_learning_worker, invitation_worker, proposal_worker, recover_invitation_mail, router,
    runtime::SHUTDOWN_GRACE, validate_grants,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{env, io::Read, net::SocketAddr, process::ExitCode, sync::Arc, time::Duration};

const QUEUE_LOCK: i64 = 729183421001;
#[derive(Debug)]
struct QueueOwnershipLost(&'static str);
impl std::fmt::Display for QueueOwnershipLost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "proposal queue ownership lost: {}", self.0)
    }
}
impl std::error::Error for QueueOwnershipLost {}
type RunResult = Result<(), Box<dyn std::error::Error>>;

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--check-grants" {
        return check_grants(std::io::stdin().lock());
    }
    if !args.is_empty() {
        eprintln!(r#"{{"schemaVersion":1,"valid":false,"code":"command.invalid"}}"#);
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("Error: runtime initialization failed");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // EX_TEMPFAIL identifies lost singleton ownership to the supervisor.
            let code = if error.is::<QueueOwnershipLost>() {
                75
            } else {
                1
            };
            eprintln!("Error: {error}");
            ExitCode::from(code)
        }
    }
}

/// Check only the explicitly supplied static grants. This executes before even
/// constructing a Tokio runtime or reading service/provider environment config.
fn check_grants(input: impl Read) -> ExitCode {
    const MAX_INPUT: u64 = 1024 * 1024;
    let mut bytes = Vec::new();
    let parsed = if input.take(MAX_INPUT + 1).read_to_end(&mut bytes).is_ok()
        && bytes.len() <= MAX_INPUT as usize
    {
        parse_grants(&bytes).map(|_| ())
    } else {
        Err(INVALID_GRANTS)
    };
    if parsed.is_ok() {
        println!(r#"{{"schemaVersion":1,"valid":true}}"#);
        ExitCode::SUCCESS
    } else if parsed == Err(RENAMED_GRANT_PROJECT) {
        // Fixed text only: the rename names a key, never operator input.
        eprintln!(
            r#"{{"schemaVersion":1,"valid":false,"code":"grants.invalid","message":"projectId was renamed to workspaceId in 0.2.0"}}"#
        );
        ExitCode::FAILURE
    } else {
        // Do not render serde/I/O errors: they can carry operator input.
        eprintln!(r#"{{"schemaVersion":1,"valid":false,"code":"grants.invalid"}}"#);
        ExitCode::FAILURE
    }
}

const INVALID_GRANTS: &str = "invalid ACCLIMATE_AUTH JSON";
const RENAMED_GRANT_PROJECT: &str =
    "invalid ACCLIMATE_AUTH JSON: projectId was renamed to workspaceId in 0.2.0";

fn parse_grants(bytes: &[u8]) -> Result<Vec<Grant>, &'static str> {
    const INVALID: &str = INVALID_GRANTS;
    let entries: Vec<&serde_json::value::RawValue> =
        serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    let mut grants = Vec::with_capacity(entries.len());
    for entry in entries {
        // Serde also accepts positional arrays for structs. Static grants require named fields.
        if !entry.get().starts_with('{') {
            return Err(INVALID);
        }
        // Name the 0.2.0 rename instead of a generic unknown-field error.
        if serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(entry.get())
            .is_ok_and(|fields| fields.contains_key("projectId"))
        {
            return Err(RENAMED_GRANT_PROJECT);
        }
        grants.push(serde_json::from_str(entry.get()).map_err(|_| INVALID)?);
    }
    validate_grants(&grants)?;
    Ok(grants)
}
fn required(name: &str) -> Result<String, std::io::Error> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| std::io::Error::other(format!("{name} is required")))
}
async fn run() -> RunResult {
    // Parse all application configuration before connecting or binding. In
    // particular, libpq's implicit local/user database defaults are unsupported.
    let url = required("DATABASE_URL")?;
    if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
        return Err(
            std::io::Error::other("DATABASE_URL must be an explicit PostgreSQL URL").into(),
        );
    }
    let parsed_url = reqwest::Url::parse(&url)
        .map_err(|_| std::io::Error::other("invalid PostgreSQL DATABASE_URL"))?;
    if parsed_url.host_str().is_none()
        || parsed_url.username().is_empty()
        || parsed_url.path().trim_start_matches('/').is_empty()
        || parsed_url.fragment().is_some()
    {
        return Err(std::io::Error::other(
            "DATABASE_URL must explicitly identify the PostgreSQL host, user and database",
        )
        .into());
    }
    let database_options: PgConnectOptions = url
        .parse()
        .map_err(|_| std::io::Error::other("invalid PostgreSQL DATABASE_URL"))?;
    // URL query parameters can override the authority and path. PostgreSQL
    // treats an empty database override as the role-named database, so validate
    // the effective options as well as the explicitly supplied URL components.
    if database_options.get_host().is_empty()
        || database_options.get_username().is_empty()
        || database_options.get_database().is_none_or(str::is_empty)
    {
        return Err(std::io::Error::other(
            "DATABASE_URL must explicitly identify the PostgreSQL host, user and database",
        )
        .into());
    }
    let grants =
        parse_grants(required("ACCLIMATE_AUTH")?.as_bytes()).map_err(std::io::Error::other)?;
    let access = Arc::new(AccessConfig::from_env(&grants).map_err(std::io::Error::other)?);
    let bind: SocketAddr = env::var("ACCLIMATE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3000".into())
        .parse()
        .map_err(|_| std::io::Error::other("ACCLIMATE_BIND must be a socket address"))?;
    let model = OpenAiModel::from_env()
        .map_err(std::io::Error::other)?
        .map(|model| Arc::new(model) as Arc<dyn ProposalModel>);
    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(database_options)
        .await?;
    let mut leader_guard = Some(db.acquire().await?);
    leader_guard.as_mut().unwrap().close_on_drop();
    let (leader_pid, leader): (i32, bool) =
        sqlx::query_as("SELECT pg_backend_pid(),pg_try_advisory_lock($1)")
            .bind(QUEUE_LOCK)
            .fetch_one(&mut **leader_guard.as_mut().unwrap())
            .await?;
    if !leader {
        return Err(std::io::Error::other(
            "another Acclimate service process owns the proposal queue",
        )
        .into());
    }
    // Ownership serializes schema changes and attempt-limited crash recovery.
    sqlx::migrate!("./migrations").run(&db).await?;
    let runtime = Arc::new(RuntimeStatus::new());
    runtime.ownership_acquired();
    let state = AppState {
        db: db.clone(),
        grants: Arc::new(grants),
        access,
        runtime: runtime.clone(),
        provider: model,
    };
    backfill_projects(&state).await?;
    sqlx::query("UPDATE proposals SET status='queued' WHERE status='running' AND attempts<3")
        .execute(&db)
        .await?;
    sqlx::query("UPDATE proposals SET status='failed',error='attempt limit reached during recovery' WHERE status='running' AND attempts>=3")
        .execute(&db).await?;
    recover_invitation_mail(&state).await?;
    let app = router(state.clone());
    let mut mail_worker = tokio::spawn(invitation_worker(state.clone()));
    let mut learning_worker = tokio::spawn(connected_learning_worker(state.clone()));
    let mut worker = tokio::spawn(proposal_worker(state));
    // No socket is opened until the worker has actually entered its task.
    tokio::select! {
        _ = runtime.wait_for_worker() => {},
        result = &mut worker => return Err(std::io::Error::other(format!("proposal worker exited during startup: {result:?}")).into()),
    }
    runtime.mark_initialized();
    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) => {
            runtime.begin_draining();
            worker.abort();
            mail_worker.abort();
            learning_worker.abort();
            let _ = worker.await;
            let _ = mail_worker.await;
            let _ = learning_worker.await;
            return Err(error.into());
        }
    };
    let (stop_http, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let mut server_finished = false;
    let mut worker_finished = false;
    let mut ownership_lost = false;
    let mut mail_finished = false;
    let mut learning_finished = false;
    // This is the only shutdown coordinator, including signals and fatal exits.
    let result: RunResult = tokio::select! {
        _ = shutdown_signal() => Ok(()),
        result = &mut server => {
            server_finished = true;
            match result { Ok(result) => result.map_err(Into::into), Err(error) => Err(error.into()) }
        },
        result = &mut worker => {
            worker_finished = true;
            Err(std::io::Error::other(format!("proposal worker exited unexpectedly: {result:?}")).into())
        },
        result = &mut mail_worker => {
            mail_finished = true;
            Err(std::io::Error::other(format!("invitation mail worker exited unexpectedly: {result:?}")).into())
        },
        result = &mut learning_worker => {
            learning_finished = true;
            Err(std::io::Error::other(format!("connected learning worker exited unexpectedly: {result:?}")).into())
        },
        reason = monitor_lock(&db, &mut leader_guard, &runtime, leader_pid) => {
            ownership_lost = true;
            Err(QueueOwnershipLost(reason).into())
        },
    };
    runtime.begin_draining();
    if ownership_lost {
        runtime.ownership_lost();
        // Once ownership is gone, an in-flight provider result must not commit.
        worker.abort();
        mail_worker.abort();
        learning_worker.abort();
    }
    let _ = stop_http.send(());
    let drained = tokio::time::timeout(SHUTDOWN_GRACE, async {
        runtime.settle_claims().await;
        if !worker_finished {
            let _ = (&mut worker).await;
            worker_finished = true;
        }
        if !learning_finished {
            let _ = (&mut learning_worker).await;
            learning_finished = true;
        }
        if !server_finished {
            let _ = (&mut server).await;
            server_finished = true;
        }
    })
    .await
    .is_ok();
    if !worker_finished {
        worker.abort();
        let _ = worker.await;
    }
    if !learning_finished {
        learning_worker.abort();
        let _ = learning_worker.await;
    }
    if !mail_finished {
        mail_worker.abort();
        let _ = mail_worker.await;
    }
    if !server_finished {
        server.abort();
        let _ = server.await;
    }
    // Close, rather than pool, the lock session only after requests and worker
    // have drained or been cancelled. Pool return would retain the session lock.
    if let Some(mut guard) = leader_guard {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query("SELECT pg_advisory_unlock($1)")
                .bind(QUEUE_LOCK)
                .execute(&mut *guard),
        )
        .await;
        guard.close_on_drop();
    }
    if !drained && result.is_ok() {
        return Err(std::io::Error::other(
            "shutdown drain deadline exceeded; remaining tasks cancelled",
        )
        .into());
    }
    result
}

async fn monitor_lock(
    db: &sqlx::PgPool,
    connection: &mut Option<sqlx::pool::PoolConnection<sqlx::Postgres>>,
    runtime: &RuntimeStatus,
    mut previous_pid: i32,
) -> &'static str {
    loop {
        let guard = connection.as_mut().expect("ownership connection assigned");
        let probe = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=169 AND objid=3333947977 AND objsubid=1)"
        ).fetch_one(&mut **guard);
        if !matches!(
            tokio::time::timeout(Duration::from_secs(2), probe).await,
            Ok(Ok(true))
        ) {
            runtime.ownership_uncertain();
            runtime.settle_claims().await;
            // Disconnect the previous session so its lock cannot survive in the pool.
            drop(
                connection
                    .take()
                    .expect("ownership connection assigned")
                    .detach(),
            );
            let mut delay = Duration::from_millis(250);
            loop {
                let reacquire = async {
                    let mut guard = db.acquire().await?;
                    guard.close_on_drop();
                    let (pid, acquired): (i32, bool) =
                        sqlx::query_as("SELECT pg_backend_pid(),pg_try_advisory_lock($1)")
                            .bind(QUEUE_LOCK)
                            .fetch_one(&mut *guard)
                            .await?;
                    if acquired {
                        return Ok::<_, sqlx::Error>((Some((guard, pid)), false));
                    }
                    // A stalled backend can keep its lock until it observes our disconnect.
                    let competing: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
                         AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
                         AND granted AND classid=169 AND objid=3333947977 AND objsubid=1 AND pid<>$1)",
                    ).bind(previous_pid).fetch_one(&mut *guard).await?;
                    Ok((None, competing))
                };
                match tokio::time::timeout(Duration::from_secs(5), reacquire).await {
                    Ok(Ok((Some((guard, pid)), _))) => {
                        *connection = Some(guard);
                        previous_pid = pid;
                        runtime.ownership_acquired();
                        break;
                    }
                    Ok(Ok((None, true))) => return "another service holds the advisory lock",
                    _ => {
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(10));
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
