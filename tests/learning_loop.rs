mod common;
#[path = "learning_loop/executor.rs"]
mod executor_tests;
#[path = "learning_loop/optimizer.rs"]
mod optimizer;

use acclimate_service::{AppState, Grant, RuntimeStatus, learning_worker, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::task::JoinHandle;
use tower::ServiceExt;
use uuid::Uuid;

const DIGEST: &str = "sha256:0067f5c5211d303528a731b3b2e4c169935dd62b40e8444c671204605a53557b";
const HELD_OUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct Fixture {
    state: AppState,
    app: axum::Router,
    project: String,
    bundle: Uuid,
    version: Uuid,
    token: String,
    worker: Option<JoinHandle<()>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
}

impl Fixture {
    async fn new() -> Self {
        use sqlx::{Connection, postgres::PgConnectOptions};
        let options: PgConnectOptions = common::database_url().parse().unwrap();
        let schema = format!("learning_fixture_{}", Uuid::new_v4().simple());
        let mut connection = sqlx::PgConnection::connect_with(&options).await.unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_with(options.options([("search_path", &schema)]))
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        let project = format!("loop-{}", Uuid::new_v4());
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
            .bind(&project)
            .execute(&db)
            .await
            .unwrap();
        let state = AppState {
            db,
            grants: Arc::new(
                [
                    ("admin", &["promote", "read"][..]),
                    ("app", &["read", "write", "promote"][..]),
                    ("other", &["read"][..]),
                    ("reader", &["read"][..]),
                    ("writer", &["read", "write"][..]),
                ]
                .into_iter()
                .map(|(principal, rights)| Grant {
                    token: principal.into(),
                    principal_id: principal.into(),
                    project_id: project.clone(),
                    rights: rights.iter().map(|right| (*right).into()).collect(),
                })
                .collect(),
            ),
            access: common::access(),
            runtime: Arc::new(RuntimeStatus::new()),
            optimizer: Some(Arc::new(optimizer::NoChangeModel("fixture"))),
        };
        let (bundle, version) = Self::create_bundle(&state.db, &project).await;
        let app = router(state.clone());
        let (_, token) = acclimate_service::executor::create_credential(&state.db)
            .await
            .unwrap();
        Self {
            token,
            state,
            app,
            project,
            bundle,
            version,
            worker: None,
        }
    }

    async fn create_bundle(db: &sqlx::PgPool, project: &str) -> (Uuid, Uuid) {
        let (bundle, version) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'learning')")
            .bind(bundle)
            .bind(project)
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,'test')")
            .bind(version).bind(project).bind(bundle).bind(DIGEST).bind(&include_bytes!("../contracts/fixtures/bundle-v1.json")[..])
            .execute(db).await.unwrap();
        sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',7,$3),($1,$2,'beta',1,$3)")
            .bind(project).bind(bundle).bind(version).execute(db).await.unwrap();
        (bundle, version)
    }

    fn spawn_worker(&mut self) {
        self.state.runtime.ownership_acquired();
        self.worker = Some(tokio::spawn(learning_worker(self.state.clone())));
    }

    async fn crash_worker(&mut self) {
        let worker = self.worker.take().unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    async fn req(
        &self,
        method: &str,
        suffix: &str,
        caller: &str,
        key: Option<&str>,
        body: Value,
    ) -> (u16, Value) {
        let uri = if suffix.starts_with("/v1/") {
            suffix.to_owned()
        } else {
            format!(
                "/v1/workspaces/{}/bundles/{}/learning{suffix}",
                self.project, self.bundle
            )
        };
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(session) = caller.strip_prefix("console/") {
            req = req
                .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
                .header("x-acclimate-session", session);
        } else {
            req = req.header("authorization", format!("Bearer {caller}"));
        }
        if let Some(key) = key {
            req = req.header("idempotency-key", key);
        }
        let reply = self
            .app
            .clone()
            .oneshot(
                req.body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let status = reply.status().as_u16();
        let bytes = to_bytes(reply.into_body(), 2_097_152).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
        )
    }

    async fn ok(
        &self,
        method: &str,
        suffix: &str,
        caller: &str,
        key: Option<&str>,
        body: Value,
    ) -> Value {
        let (status, result) = self.req(method, suffix, caller, key, body).await;
        assert_eq!(status, StatusCode::OK, "{method} {suffix}: {result}");
        result
    }

    async fn enroll(&self) -> Value {
        self.provider().await;
        self.ok("PUT", "", "admin", None, enrollment()).await
    }

    fn key() -> acclimate_service::executor::ProviderKey {
        acclimate_service::executor::ProviderKey::from_hex(&"01".repeat(32)).unwrap()
    }
    async fn provider(&self) {
        Self::key()
            .store(
                &self.state.db,
                &self.project,
                "https://provider.invalid/v1",
                &["task".into(), "judge".into()],
                "private-fixture-provider-key",
            )
            .await
            .unwrap();
    }
    fn internal(&self) -> axum::Router {
        acclimate_service::executor::router(
            self.state.db.clone(),
            Some(Self::key()),
            self.state.runtime.clone(),
        )
    }
    fn identity() -> Value {
        json!({"build":"fixture","harnesses":{"chat":"1"},"sandboxRuntime":"docker","runnerImage":"fixture-image"})
    }
    async fn announce(&self) {
        self.state.runtime.ownership_acquired();
        assert_eq!(
            executor_tests::post(
                &self.internal(),
                "",
                &self.token,
                json!({"executor":Self::identity()})
            )
            .await
            .0,
            204
        );
    }
    async fn seed(&self) {
        for (table, identifier) in [
            (
                "learning_tasks",
                "CASE i WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'extra-'||i END",
            ),
            ("learning_held_out_tasks", "'held-out-sentinel-'||i"),
        ] {
            sqlx::query(&format!(r#"INSERT INTO {table}(project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,added_revision)
              SELECT $1,$2,{identifier},i::text,to_jsonb({identifier}), '{{"type":"exact","expected":null}}','console','operator','admitted',1 FROM generate_series(1,20) i"#))
              .bind(&self.project).bind(self.bundle).execute(&self.state.db).await.unwrap();
        }
        sqlx::query("UPDATE learning_loops SET task_revision=1")
            .execute(&self.state.db)
            .await
            .unwrap();
        self.announce().await;
        self.ok("POST", "/start", "admin", None, Value::Null).await;
    }

    async fn wait_for(&self, suffix: &str, caller: &str, ready: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let value = self.ok("GET", suffix, caller, None, Value::Null).await;
                if ready(&value) {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {suffix}"))
    }

    async fn item(&self, split: &str, number: i32) -> Value {
        let split = if split == "heldOut" {
            "held_out"
        } else {
            "evolve"
        };
        tokio::time::timeout(Duration::from_secs(60),async {
            loop {
                let item:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('evaluationId',e.id,'roundId',r.id,'versionId',e.version_id,'sample',e.sample,'role',e.role) FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id WHERE r.number=$1 AND e.split=$2 AND e.status='running' AND EXISTS(SELECT FROM learning_rollouts WHERE evaluation_id=e.id AND status='queued') ORDER BY e.created_at LIMIT 1")
                    .bind(number).bind(split).fetch_optional(&self.state.db).await.unwrap();
                if let Some(item)=item{return item;}
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }).await.expect("evaluation became available")
    }
}

fn enrollment() -> Value {
    json!({"channel":"stable","taskModel":"task","judgeModel":"judge","setting":{"domain":"support","benchmark":"v3","policyModel":"task"}})
}
fn result(id: &str, score: f64) -> Value {
    json!({"caseId":id,"rollouts":vec![json!({"score":score,"passed":score>=0.5});5]})
}
fn round_route(item: &Value) -> String {
    format!("/rounds/{}", item["roundId"].as_str().unwrap())
}

async fn session(f: &Fixture, role: &str) -> String {
    let user = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'https://fixture.example',$2)")
        .bind(user)
        .bind(user.to_string())
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,$3)")
        .bind(&f.project)
        .bind(user)
        .bind(role)
        .execute(&f.state.db)
        .await
        .unwrap();
    let hash = format!("sha256:{}", hex::encode(Sha256::digest(secret.as_bytes())));
    sqlx::query("INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(hash).bind(user).execute(&f.state.db).await.unwrap();
    secret
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn task_custody_revisions_confirmation_and_outcomes() {
    let f = Fixture::new().await;
    f.enroll().await;
    for (method, suffix) in [
        ("GET", "/work"),
        ("POST", "/evolve-cases"),
        ("POST", "/evaluations/unused/start"),
        ("POST", "/evaluations/unused/report"),
    ] {
        assert_eq!(
            f.req(method, suffix, "admin", None, Value::Null).await.0,
            404
        );
    }
    assert_eq!(
        f.req("POST", "/outcomes", "reader", None, json!({}))
            .await
            .0,
        403
    );
    assert_eq!(
        f.req("POST", "/resume", "admin", None, Value::Null).await.0,
        409
    );
    let person = format!("console/{}", session(&f, "editor").await);
    let mut index = 0;
    let input = loop {
        let input = json!(format!("secret {index}"));
        let group = format!("console:{}", hex::encode(Sha256::digest(input.to_string())));
        if Sha256::digest(group)[0] < 128 {
            break input;
        }
        index += 1;
    };
    let new = json!({"input":input,"grader":{"type":"exact","expected":"secret answer"}});
    assert_eq!(
        f.ok("POST", "/tasks", "writer", None, new).await,
        json!({"heldOutCount":1})
    );
    assert_eq!(
        f.req("GET", "/held-out-tasks/export", "writer", None, Value::Null)
            .await
            .0,
        403
    );
    let page = f.ok("GET", "/tasks", "writer", None, Value::Null).await;
    assert_eq!(page, json!({"heldOutCount":1,"items":[],"next":null}));
    let export = f
        .ok("GET", "/held-out-tasks/export", &person, None, Value::Null)
        .await;
    let old = &export["items"][0];
    assert_eq!(old["input"], input);
    let route = format!("/tasks/{}", old["taskId"].as_str().unwrap());
    assert!(
        sqlx::query("UPDATE learning_held_out_tasks SET admission='admitted'")
            .execute(&f.state.db)
            .await
            .is_err()
    );
    for method in ["DELETE", "PATCH"] {
        assert_eq!(
            f.req(method, &route, "writer", None, json!({"input":0}))
                .await
                .0,
            404
        );
    }
    f.ok(
        "PATCH",
        &route,
        &person,
        None,
        json!({"input":"edited","confirm":true}),
    )
    .await;
    let page = f
        .ok(
            "GET",
            "/tasks?split=held-out&source=console&admission=pending",
            &person,
            None,
            Value::Null,
        )
        .await;
    let new = &page["items"][0];
    for key in ["taskId", "group", "split"] {
        assert_eq!(old[key], new[key]);
    }
    assert_ne!(old["addedRevision"], new["addedRevision"]);
    assert!(new["confirmedBy"].is_string());
    f.ok("DELETE", &route, &person, None, Value::Null).await;
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM learning_held_out_tasks WHERE retired_revision IS NOT NULL",
    )
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert_eq!(n, 2);

    let job = (0..100)
        .map(Uuid::from_u128)
        .find(|id| Sha256::digest(id.to_string())[0] < 128)
        .unwrap();
    let mut outcome = json!({"outcomeId":job,"versionId":f.version,"digest":DIGEST,"input":input,"expected":null,"output":null});
    assert_eq!(
        f.req("POST", "/outcomes", "app", None, outcome.clone())
            .await
            .0,
        400
    );
    outcome["output"] = json!("wrong");
    let receipt = f.ok("POST", "/outcomes", "app", None, outcome).await;
    assert!(receipt.get("caseId").is_none());
    let export = f
        .ok("GET", "/held-out-tasks/export", &person, None, Value::Null)
        .await;
    assert_eq!(export["items"][0]["group"], job.to_string());
    assert_eq!(export["items"][0]["output"], "wrong");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn streamed_import_preserves_rows_and_returns_cards_only_to_people() {
    let f = Fixture::new().await;
    f.enroll().await;
    let person = format!("console/{}", session(&f, "editor").await);
    for who in ["writer", &person] {
        let material = json!({"input":null,"expected":{"answer":42}});
        let reply = f
            .ok(
                "POST",
                "/tasks/import?filename=tickets.jsonl",
                who,
                None,
                material,
            )
            .await;
        assert_eq!(reply["rows"], 1);
        assert_eq!(reply["converted"], 1);
        assert_eq!(reply["pending"], 0);
        if who == "writer" {
            assert!(reply.get("cards").is_none());
        } else {
            let card = &reply["cards"][0];
            assert_eq!(card["sourceFile"], "tickets.jsonl");
            assert_eq!(card["sourceRow"], 1);
            assert_eq!(
                card["grader"],
                json!({"type":"exact","expected":{"answer":42}})
            );
        }
    }
    let long = "x".repeat(2 * 1024 * 1024 + 1);
    let reply = f
        .ok("POST", "/tasks/import", "writer", None, json!(long))
        .await;
    assert_eq!(reply["pending"], 1);
    assert_eq!(
        f.req("POST", "/tasks", "writer", None, json!({"input":long}))
            .await
            .0,
        413
    );
    // Reuse one chunk so the test exercises the streaming limit without a 65 MiB allocation.
    let chunk = axum::body::Bytes::from(vec![b'x'; 1024 * 1024]);
    let stream =
        futures_util::stream::iter((0..65).map(move |_| Ok::<_, std::io::Error>(chunk.clone())));
    let req = Request::builder()
        .method("POST")
        .uri(format!(
            "/v1/workspaces/{}/bundles/{}/learning/tasks/import",
            f.project, f.bundle
        ))
        .header("authorization", "Bearer writer")
        .header("content-type", "text/plain")
        .body(Body::from_stream(stream))
        .unwrap();
    let res = f.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = to_bytes(res.into_body(), 4096).await.unwrap();
    assert!(std::str::from_utf8(&body).unwrap().contains("64 MiB"));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn start_floor_pauses_on_loss_and_allows_active_round_to_finish() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.announce().await;
    sqlx::query("UPDATE learning_loops SET task_revision=1")
        .execute(&f.state.db)
        .await
        .unwrap();
    for (table, count) in [("learning_tasks", 20), ("learning_held_out_tasks", 19)] {
        sqlx::query(&format!(r#"INSERT INTO {table}(project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,added_revision)
            SELECT $1,$2,'floor-'||i,i::text,'null','{{}}','console','operator','admitted',1 FROM generate_series(1,$3::int) i"#))
            .bind(&f.project).bind(f.bundle).bind(count).execute(&f.state.db).await.unwrap();
    }
    let (status, error) = f.req("POST", "/start", "admin", None, Value::Null).await;
    assert_eq!(status, 409);
    assert!(error.to_string().contains("tasks-required"));
    sqlx::query(r#"INSERT INTO learning_held_out_tasks(project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,added_revision)
        VALUES($1,$2,'secret-held-task','secret','"private"','{}','console','operator','admitted',1)"#)
        .bind(&f.project).bind(f.bundle).execute(&f.state.db).await.unwrap();
    let started = f.ok("POST", "/start", "admin", None, Value::Null).await;
    assert_eq!(started["admittedHeldOut"], 20);
    assert!(!started.to_string().contains("secret-held-task"));
    f.spawn_worker();
    let first = f.item("evolve", 1).await;
    sqlx::query(
        "UPDATE learning_tasks SET retired_revision=2 WHERE bundle_id=$1 AND task_id='floor-1'",
    )
    .bind(f.bundle)
    .execute(&f.state.db)
    .await
    .unwrap();
    let paused = f
        .wait_for("", "reader", |r| r["pauseReason"] == "tasks-required")
        .await;
    assert_eq!(paused["activeRound"]["id"], first["roundId"]);
    assert_eq!(paused["activeRound"]["trigger"], "start");
    assert_eq!(
        f.req("POST", "/resume", "admin", None, Value::Null).await.0,
        409
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn retry_idles_then_task_change_wakes_after_rolling_cap() {
    let mut f = Fixture::new().await;
    f.provider().await;
    let mut input = enrollment();
    input["maxRoundsPerDay"] = json!(2);
    f.ok("PUT", "", "admin", None, input).await;
    f.seed().await;
    f.spawn_worker();
    let first = f.item("evolve", 1).await;
    optimizer::evaluate(&f, &first, &[]).await;
    let held = f.item("heldOut", 1).await;
    optimizer::evaluate(&f, &held, &[]).await;
    let idle = f
        .wait_for("", "reader", |r| r["waiting"] == "no-new-evidence")
        .await;
    assert_eq!(idle["rounds"][0]["trigger"], "retry");
    assert_eq!(idle["rounds"][0]["incumbentReused"], true);
    assert!(!idle.to_string().contains("private-id"));
    sqlx::query("UPDATE learning_tasks SET retired_revision=2 WHERE task_id IN ('extra-3','extra-4','extra-5','extra-6','extra-7')").execute(&f.state.db).await.unwrap();
    sqlx::query(r#"INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,added_revision)
        SELECT project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,2 FROM learning_tasks WHERE retired_revision=2"#).execute(&f.state.db).await.unwrap();
    sqlx::query("UPDATE learning_loops SET task_revision=2")
        .execute(&f.state.db)
        .await
        .unwrap();
    f.wait_for("", "reader", |r| r["waiting"] == "daily-cap")
        .await;
    sqlx::query("UPDATE learning_rounds SET created_at=now()-interval '25 hours' WHERE bundle_id=$1 AND number=1").bind(f.bundle).execute(&f.state.db).await.unwrap();
    let wake = f
        .wait_for("", "reader", |r| {
            r["activeRound"]["trigger"] == "task-change"
        })
        .await;
    assert_eq!(wake["activeRound"]["incumbentReused"], false);
    let usage = f.ok("GET", "/usage", "reader", None, Value::Null).await;
    assert_eq!(usage["items"][0]["rounds"], 3);
    assert_eq!(usage["items"][0]["rollouts"], 200);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn model_settings_and_provider_key_custody() {
    let f = Fixture::new().await;
    let route = format!("/v1/workspaces/{}/model-provider", f.project);
    let provider = json!({"baseUrl":"https://example.test/v1","allowedModels":["task","judge"],"apiKey":"private-provider-fixture"});
    assert_eq!(
        f.ok("GET", &route, "reader", None, Value::Null).await["hasKey"],
        false
    );
    assert_eq!(
        f.req("PUT", &route, "admin", None, provider.clone())
            .await
            .0,
        403
    );
    let admin = format!("console/{}", session(&f, "admin").await);
    if std::env::var_os("ACCLIMATE_PROVIDER_ENCRYPTION_KEY").is_some() {
        let result = f.ok("PUT", &route, &admin, None, provider).await;
        assert!(!result.to_string().contains("private-provider-fixture"));
    } else {
        assert_eq!(f.req("PUT", &route, &admin, None, provider).await.0, 503);
        acclimate_service::executor::ProviderKey::from_hex(&"42".repeat(32))
            .unwrap()
            .store(
                &f.state.db,
                &f.project,
                "https://example.test/v1",
                &["task".into(), "judge".into()],
                "private-provider-fixture",
            )
            .await
            .unwrap();
    }
    let read = f.ok("GET", &route, "reader", None, Value::Null).await;
    assert_eq!(read["allowedModels"], json!(["task", "judge"]));
    assert_eq!(read["hasKey"], true);
    assert!(!read.to_string().contains("private-provider-fixture"));
    let mut settings = json!({"channel":"stable","taskModel":"task","judgeModel":"task","setting":{"domain":"support","benchmark":"v3"}});
    assert_eq!(
        f.req("PUT", "", "admin", None, settings.clone()).await.0,
        400
    );
    settings["judgeModel"] = json!("unknown");
    assert_eq!(
        f.req("PUT", "", "admin", None, settings.clone()).await.0,
        400
    );
    settings["judgeModel"] = json!("judge");
    let doc = f.ok("PUT", "", "admin", None, settings).await;
    assert_eq!(doc["status"], "paused");
    assert_eq!(doc["setting"]["policyModel"], "task");
    assert_eq!(doc["maxRoundsPerDay"], 4);
    assert_eq!(
        f.req("POST", "/start", "admin", None, Value::Null).await.0,
        409
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn two_exhausted_leases_fail_the_incumbent_and_pause_after_three_rounds() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let internal = f.internal();
    for number in 1..=3 {
        let item = f.item("evolve", number).await;
        let mut first = Value::Null;
        for attempt in 1..=2 {
            let (status, lease) = executor_tests::post(
                &internal,
                "",
                &f.token,
                json!({"executor":Fixture::identity()}),
            )
            .await;
            assert_eq!(status, 200);
            if attempt == 1 {
                first = lease["rolloutId"].clone()
            } else {
                assert_eq!(first, lease["rolloutId"]);
            }
            assert_eq!(
                executor_tests::act(
                    &internal,
                    &lease,
                    "result",
                    json!({"error":{"code":"executor","message":"fixture"}})
                )
                .await
                .0,
                204
            );
        }
        let round = f
            .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
            .await;
        assert_eq!(round["reason"], "incumbent-evaluation-failed");
    }
    let state = f.ok("GET", "", "reader", None, Value::Null).await;
    assert_eq!(state["pauseReason"], "failed-rounds");
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM learning_rollouts WHERE status IN ('queued','running','grading')",
    )
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert_eq!(open, 0);
}
