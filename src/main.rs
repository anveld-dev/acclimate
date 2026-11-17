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
    let valid = input.take(MAX_INPUT + 1).read_to_end(&mut bytes).is_ok()
        && bytes.len() <= MAX_INPUT as usize
        && validate_grant_input(&bytes);
    if valid {
        println!(r#"{{"schemaVersion":1,"valid":true}}"#);
        ExitCode::SUCCESS
    } else {
        // Do not render serde/I/O errors: they can carry operator input.
        eprintln!(r#"{{"schemaVersion":1,"valid":false,"code":"grants.invalid"}}"#);
        ExitCode::FAILURE
    }
}

fn validate_grant_input(bytes: &[u8]) -> bool {
    // Deserialize the real schema first, preserving serde's duplicate-field and
    // value-type checks, then reject fields the historical Grant reader ignores.
    let Ok(grants) = serde_json::from_slice::<Vec<Grant>>(bytes) else {
        return false;
    };
    let Ok(objects) =
        serde_json::from_slice::<Vec<serde_json::Map<String, serde_json::Value>>>(bytes)
    else {
        return false;
    };
    objects.iter().all(|object| {
        object.len() == 4
            && object.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "token" | "principalId" | "projectId" | "rights"
                )
            })
    }) && validate_grants(&grants).is_ok()
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
    let grants: Vec<Grant> = serde_json::from_str(&required("ACCLIMATE_AUTH")?)
        .map_err(|_| std::io::Error::other("invalid ACCLIMATE_AUTH JSON"))?;
    validate_grants(&grants).map_err(std::io::Error::other)?;
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
    let mut leader_guard = db.acquire().await?;
    let leader: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(QUEUE_LOCK)
        .fetch_one(&mut *leader_guard)
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
        reason = monitor_lock(&mut leader_guard) => {
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
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(QUEUE_LOCK)
            .execute(&mut *leader_guard),
    )
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(2), leader_guard.close()).await;
    if !drained && result.is_ok() {
        return Err(std::io::Error::other(
            "shutdown drain deadline exceeded; remaining tasks cancelled",
        )
        .into());
    }
    result
}

async fn monitor_lock(connection: &mut sqlx::pool::PoolConnection<sqlx::Postgres>) -> &'static str {
    loop {
        let probe = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=169 AND objid=3333947977 AND objsubid=1)"
        ).fetch_one(&mut **connection);
        match tokio::time::timeout(Duration::from_secs(2), probe).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => return "advisory lock is no longer held",
            Ok(Err(_)) => return "database connection failed",
            Err(_) => return "database connection timed out",
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
