//! Actual process tests use only the explicitly supplied, disposable test cluster.
mod common;
use sqlx::{PgPool, Row};
use std::{
    net::TcpListener,
    process::{Child, Command, ExitStatus, Stdio},
    time::Duration,
};
use uuid::Uuid;

struct Service(Child);
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn address() -> String {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .to_string()
}
fn service(url: &str, address: &str) -> Service {
    Service(Command::new(env!("CARGO_BIN_EXE_acclimate-service"))
        .env_clear().env("DATABASE_URL", url)
        .env("ACCLIMATE_AUTH", r#"[{"token":"machine-fixture","principalId":"original-machine","projectId":"runtime-fixture","rights":["read","write"]}]"#)
        .env("ACCLIMATE_OIDC_ISSUER", "https://fixture.example")
        .env("ACCLIMATE_LOGIN_TOKEN", "fixture-login")
        .env("ACCLIMATE_CONSOLE_TOKEN", "fixture-console")
        .env("ACCLIMATE_OPERATORS", r#"[{"issuer":"https://fixture.example","subject":"operator"}]"#)
        .env("ACCLIMATE_BIND", address)
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap())
}
async fn exit(service: &mut Service) -> ExitStatus {
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if let Some(status) = service.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("service did not exit within shutdown bound")
}
async fn status(address: &str, path: &str) -> Option<u16> {
    reqwest::Client::new()
        .get(format!("http://{address}{path}"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()
        .map(|response| response.status().as_u16())
}
async fn ready(service: &mut Service, address: &str) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(
                service.0.try_wait().unwrap().is_none(),
                "service exited before readiness"
            );
            if status(address, "/ready").await == Some(200) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("service did not become ready");
}
async fn terminate(service: &mut Service) {
    assert!(
        Command::new("/bin/kill")
            .args(["-TERM", &service.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(exit(service).await.code(), Some(0));
}
async fn lock_pid(db: &PgPool) -> i32 {
    sqlx::query_scalar("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND classid=169 AND objid=3333947977 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")
        .fetch_one(db).await.unwrap()
}
async fn no_lock(db: &PgPool) {
    let held: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND classid=169 AND objid=3333947977 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))")
        .fetch_one(db).await.unwrap();
    assert!(!held, "queue ownership remained after process exit");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn real_process_ownership_readiness_recovery_and_shutdown() {
    let admin_url = common::database_url();
    let admin = PgPool::connect(&admin_url).await.unwrap();
    let name = format!("runtime_{}", Uuid::new_v4().simple());
    // A non-superuser service role lets us interrupt ordinary pool connections
    // while retaining the singleton session, independently of process liveness.
    sqlx::query(&format!("CREATE ROLE {name} LOGIN"))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE DATABASE {name} OWNER {name}"))
        .execute(&admin)
        .await
        .unwrap();
    let mut admin_database = reqwest::Url::parse(&admin_url).unwrap();
    admin_database.set_path(&format!("/{name}"));
    let db = PgPool::connect(admin_database.as_str()).await.unwrap();
    let mut app_url = admin_database.clone();
    app_url.set_username(&name).unwrap();
    app_url.set_password(None).unwrap();
    let first_address = address();
    let mut first = service(app_url.as_str(), &first_address);
    ready(&mut first, &first_address).await;
    assert_eq!(status(&first_address, "/health").await, Some(200));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM projects WHERE id='runtime-fixture'")
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM project_memberships")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );

    let second_address = address();
    let mut second = service(app_url.as_str(), &second_address);
    assert_eq!(exit(&mut second).await.code(), Some(1));
    assert_eq!(status(&second_address, "/health").await, None);
    assert_eq!(status(&first_address, "/ready").await, Some(200));

    let owner = lock_pid(&db).await;
    sqlx::query(&format!("ALTER ROLE {name} NOLOGIN"))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>$2",
    )
    .bind(&name)
    .bind(owner)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(
        status(&first_address, "/ready").await,
        Some(503),
        "unusable database must withdraw readiness"
    );
    assert_eq!(
        status(&first_address, "/health").await,
        Some(200),
        "database outage does not redefine process liveness"
    );
    assert!(first.0.try_wait().unwrap().is_none());
    sqlx::query(&format!("ALTER ROLE {name} LOGIN"))
        .execute(&admin)
        .await
        .unwrap();
    ready(&mut first, &first_address).await;
    terminate(&mut first).await;
    no_lock(&db).await;
    assert_eq!(status(&first_address, "/health").await, None);

    // Seed both sides of the crash-recovery attempt limit. Exact payload bytes
    // and original principal attribution must survive subsequent startup.
    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    let retry = Uuid::new_v4();
    let exhausted = Uuid::new_v4();
    let payload = b"{\"schemaVersion\":1,\"files\":[{\"path\":\"AGENTS.md\",\"kind\":\"instruction\",\"text\":\"exact bytes\\n\"}]}\n";
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,'runtime-fixture','Recovery')")
        .bind(bundle)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES($1,'runtime-fixture',$2,'fixture-digest',$3,'original-machine')")
        .bind(version).bind(bundle).bind(payload.as_slice()).execute(&db).await.unwrap();
    for (id, attempts) in [(retry, 2), (exhausted, 3)] {
        sqlx::query("INSERT INTO proposals(id,project_id,bundle_id,parent_version_id,request,status,attempts,requested_by) VALUES($1,'runtime-fixture',$2,$3,'{}','running',$4,'original-machine')")
            .bind(id).bind(bundle).bind(version).bind(attempts).execute(&db).await.unwrap();
    }
    let restart_address = address();
    let mut restart = service(app_url.as_str(), &restart_address);
    ready(&mut restart, &restart_address).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let row =
                sqlx::query("SELECT status,attempts,error,requested_by FROM proposals WHERE id=$1")
                    .bind(retry)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            if row.get::<String, _>("status") == "failed" {
                assert_eq!(row.get::<i32, _>("attempts"), 3);
                assert_eq!(row.get::<String, _>("error"), "proposal provider disabled");
                assert_eq!(row.get::<String, _>("requested_by"), "original-machine");
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let row = sqlx::query("SELECT status,attempts,error FROM proposals WHERE id=$1")
        .bind(exhausted)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("status"), "failed");
    assert_eq!(row.get::<i32, _>("attempts"), 3);
    assert_eq!(
        row.get::<String, _>("error"),
        "attempt limit reached during recovery"
    );
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT payload FROM versions WHERE id=$1")
            .bind(version)
            .fetch_one(&db)
            .await
            .unwrap(),
        payload
    );
    let owner = lock_pid(&db).await;
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT pg_terminate_backend($1)")
            .bind(owner)
            .fetch_one(&admin)
            .await
            .unwrap()
    );
    assert_eq!(
        exit(&mut restart).await.code(),
        Some(75),
        "ownership loss retains EX_TEMPFAIL"
    );
    assert_eq!(status(&restart_address, "/health").await, None);
    no_lock(&db).await;
    db.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(&format!("DROP ROLE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn migration_failure_never_opens_a_listener() {
    let admin_url = common::database_url();
    let admin = PgPool::connect(&admin_url).await.unwrap();
    let name = format!("runtime_bad_schema_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    let mut url = reqwest::Url::parse(&admin_url).unwrap();
    url.set_path(&format!("/{name}"));
    let db = PgPool::connect(url.as_str()).await.unwrap();
    sqlx::query("CREATE TABLE bundles(deliberately_incompatible integer)")
        .execute(&db)
        .await
        .unwrap();
    let bind = address();
    let mut child = service(url.as_str(), &bind);
    assert_eq!(exit(&mut child).await.code(), Some(1));
    assert_eq!(status(&bind, "/health").await, None);
    no_lock(&db).await;
    db.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn blocked_worker_is_cancelled_before_queue_ownership_is_released() {
    let admin_url = common::database_url();
    let admin = PgPool::connect(&admin_url).await.unwrap();
    let name = format!("runtime_shutdown_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    let mut url = reqwest::Url::parse(&admin_url).unwrap();
    url.set_path(&format!("/{name}"));
    let db = PgPool::connect(url.as_str()).await.unwrap();
    let bind = address();
    let mut child = service(url.as_str(), &bind);
    ready(&mut child, &bind).await;
    let owner = lock_pid(&db).await;
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("LOCK TABLE proposals IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE proposals%')")
                .fetch_one(&db).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.expect("worker did not enter deliberately blocked database operation");
    assert_eq!(
        status(&bind, "/ready").await,
        Some(200),
        "readiness is worker liveness, not queue progress"
    );
    let started = std::time::Instant::now();
    assert!(
        Command::new("/bin/kill")
            .args(["-TERM", &child.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_ne!(status(&bind, "/ready").await, Some(200));
    assert_eq!(
        lock_pid(&db).await,
        owner,
        "draining must retain singleton ownership"
    );
    let mut competitor = service(url.as_str(), &address());
    assert_eq!(exit(&mut competitor).await.code(), Some(1));
    // A deliberately stuck worker consumes the grace period and is cancelled.
    assert_eq!(exit(&mut child).await.code(), Some(1));
    assert!(started.elapsed() < Duration::from_secs(40));
    no_lock(&db).await;
    blocker.rollback().await.unwrap();
    let replacement_bind = address();
    let mut replacement = service(url.as_str(), &replacement_bind);
    ready(&mut replacement, &replacement_bind).await;
    terminate(&mut replacement).await;
    db.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
