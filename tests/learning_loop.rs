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
                    ("app", &["evaluate", "promote"][..]),
                    ("other", &["evaluate"][..]),
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
        Self {
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
        let mut req = Request::builder()
            .method(method)
            .uri(format!(
                "/v1/workspaces/{}/bundles/{}/learning{suffix}",
                self.project, self.bundle
            ))
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
        self.ok("PUT", "", "admin", None, enrollment()).await
    }

    async fn seed(&self) {
        self.ok(
            "POST",
            "/evolve-cases",
            "app",
            None,
            json!({"cases":[case("a"),case("b")]}),
        )
        .await;
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
        self.wait_for("/work", "app", |v| {
            v["items"][0]["split"] == split && v["items"][0]["roundNumber"] == number
        })
        .await["items"][0]
            .clone()
    }

    async fn start(&self, item: &Value, attempt: &str) -> Value {
        self.ok(
            "POST",
            &eval_route(item, "start"),
            "app",
            Some(attempt),
            json!({"attemptId":attempt}),
        )
        .await
    }
}

fn enrollment() -> Value {
    json!({"channel":"stable","appPrincipalId":"app","setting":{"domain":"support","benchmark":"v3","policyModel":"fixed"},
           "heldOut":{"digest":HELD_OUT,"cases":1}})
}
fn case(id: &str) -> Value {
    json!({"caseId":id,"input":{"text":id},"expected":null})
}
fn result(id: &str, score: f64) -> Value {
    json!({"caseId":id,"rollouts":vec![json!({"score":score,"passed":score>=0.5});5]})
}
fn eval_route(item: &Value, action: &str) -> String {
    format!(
        "/evaluations/{}/{action}",
        item["evaluationId"].as_str().unwrap()
    )
}
fn report(cases: &[Value]) -> Value {
    json!({"attemptId":"attempt","cases":cases})
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

async fn principal(f: &Fixture, caller: &str) -> (u16, Value) {
    let mut req = Request::builder()
        .method("GET")
        .uri(format!("/v1/workspaces/{}/principal", f.project));
    if let Some(session) = caller.strip_prefix("console/") {
        req = req
            .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
            .header("x-acclimate-session", session);
    } else {
        req = req.header("authorization", format!("Bearer {caller}"));
    }
    let reply = f
        .app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = reply.status().as_u16();
    let bytes = to_bytes(reply.into_body(), 65_536).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn one_token_enrolls_itself_and_reads_its_identity() {
    let f = Fixture::new().await;
    assert_eq!(
        principal(&f, "app").await,
        (
            200,
            json!({"principalId":"app","kind":"machine","rights":["read","evaluate","promote"]})
        )
    );
    assert_eq!(principal(&f, "reader").await.1["rights"], json!(["read"]));
    let editor = format!("console/{}", session(&f, "editor").await);
    assert_eq!(
        principal(&f, &editor).await.1["rights"],
        json!(["read", "evaluate", "write"])
    );
    let admin = format!("console/{}", session(&f, "admin").await);
    assert_eq!(
        principal(&f, &admin).await.1["rights"],
        json!(["read", "evaluate", "write", "promote"])
    );
    assert_eq!(principal(&f, "unknown-token").await.0, 401);
    let loop_doc = f.ok("PUT", "", "app", None, enrollment()).await;
    assert_eq!(loop_doc["appPrincipalId"], "app");
    assert_eq!(loop_doc["enrolledBy"], "app");
    assert_eq!(
        f.ok("POST", "/pause", "app", None, Value::Null).await["status"],
        "paused"
    );
    assert_eq!(
        f.ok("POST", "/resume", "app", None, Value::Null).await["status"],
        "running"
    );
    // Improvement memory stays optimizer-only: the app principal cannot read it.
    assert_eq!(
        f.req("GET", "/memory", "app", None, Value::Null).await.0,
        403
    );
    assert_eq!(
        f.req("GET", "/memory", "admin", None, Value::Null).await.0,
        200
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn enrollment_authority_validation_and_idempotency() {
    let f = Fixture::new().await;
    let body = enrollment();
    let editor = format!("console/{}", session(&f, "editor").await);
    for caller in [&editor[..], "other", "reader"] {
        assert_eq!(f.req("PUT", "", caller, None, body.clone()).await.0, 403);
    }
    for (key, value) in [
        ("appPrincipalId", json!("reader")),
        ("channel", json!("unreleased")),
        ("permittedPaths", json!([])),
        ("automaticRollout", json!(true)),
        ("heldOut", json!({"digest":HELD_OUT,"cases":0})),
        (
            "setting",
            json!({"domain":"x".repeat(257),"benchmark":"v3","policyModel":"fixed"}),
        ),
    ] {
        let mut invalid = body.clone();
        invalid[key] = value;
        assert_eq!(
            f.req("PUT", "", "admin", None, invalid).await.0,
            400,
            "{key}"
        );
    }
    let admin = session(&f, "admin").await;
    let browser = format!("console/{admin}");
    let token_route = format!("/v1/workspaces/{}/machine-tokens", f.project);
    let token_reply = f
        .app
        .clone()
        .oneshot(
            Request::post(token_route)
                .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
                .header("x-acclimate-session", &admin)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"name":"evaluator","rights":["evaluate"]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(token_reply.status(), 201);
    let token: Value =
        serde_json::from_slice(&to_bytes(token_reply.into_body(), 65536).await.unwrap()).unwrap();
    let principal = token["token"]["principalId"]
        .as_str()
        .expect("token response principal");
    let mut machine = body.clone();
    machine["appPrincipalId"] = json!(principal);
    assert_eq!(
        f.ok("PUT", "", &browser, None, machine.clone()).await["appPrincipalId"],
        principal
    );
    sqlx::query(
        "UPDATE machine_tokens SET revoked_at=now(),revoked_by='fixture' WHERE principal_id=$1",
    )
    .bind(principal)
    .execute(&f.state.db)
    .await
    .unwrap();
    assert_eq!(f.req("PUT", "", "admin", None, machine).await.0, 400);

    let enrolled = f.ok("PUT", "", "admin", Some("enroll"), body.clone()).await;
    assert_eq!(enrolled["status"], "running");
    assert_eq!(enrolled["evolveRevision"], 0);
    assert_eq!(enrolled["nextRound"], 1);
    assert_eq!(f.ok("PUT", "", "admin", None, body.clone()).await, enrolled);
    assert_eq!(
        f.ok("PUT", "", "admin", Some("enroll"), body).await,
        enrolled
    );
    let pages = f.ok("GET", "/rounds", "reader", None, Value::Null).await;
    assert_eq!(pages, json!({"items":[],"next":null}));
    assert_eq!(
        f.req("GET", "/rounds?before=bad", "reader", None, Value::Null)
            .await
            .0,
        400
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn evolve_revisions_and_outcome_replay() {
    let f = Fixture::new().await;
    f.enroll().await;
    for caller in ["reader", "other"] {
        assert_eq!(
            f.req(
                "POST",
                "/evolve-cases",
                caller,
                None,
                json!({"cases":[case("a")]})
            )
            .await
            .0,
            403
        );
    }
    f.seed().await;
    let put = |body| f.req("POST", "/evolve-cases", "app", None, body);
    assert_eq!(
        put(json!({"cases":[case("a")]})).await.1,
        json!({"evolveRevision":1,"added":0,"retired":0,"liveCases":2})
    );
    assert_eq!(
        put(json!({"cases":[{"caseId":"a","input":"changed","expected":null}]}))
            .await
            .0,
        409
    );
    for bad in [
        json!({}),
        json!({"cases":[case("outcome:fake")]}),
        json!({"cases":[case("a"),case("a")]}),
        json!({"retire":["unknown"]}),
        json!({"cases":(0..101).map(|n|case(&format!("a{n}"))).collect::<Vec<_>>()}),
        json!({"cases":[{"caseId":"large","input":"x".repeat(65536),"expected":null}]}),
    ] {
        assert_eq!(put(bad).await.0, 400);
    }
    let receipt = put(json!({"cases":[case("c"),case("d")],"retire":["a","b"]})).await;
    assert_eq!(
        receipt.1,
        json!({"evolveRevision":2,"added":2,"retired":2,"liveCases":2})
    );
    assert_eq!(put(json!({"cases":[case("a")]})).await.0, 409);
    assert_eq!(put(json!({"retire":["a"]})).await.1["evolveRevision"], 2);
    let first = f
        .ok(
            "GET",
            "/evolve-cases?after=&limit=1",
            "app",
            None,
            Value::Null,
        )
        .await;
    let mut c = case("c");
    c["addedRevision"] = json!(2);
    assert_eq!(first, json!({"items":[c],"next":"c","evolveRevision":2}));
    let last = f
        .ok(
            "GET",
            "/evolve-cases?after=c&limit=1",
            "app",
            None,
            Value::Null,
        )
        .await;
    let mut d = case("d");
    d["addedRevision"] = json!(2);
    assert_eq!(last, json!({"items":[d],"next":null,"evolveRevision":2}));
    for query in ["limit=0", "limit=101", "after=%20"] {
        assert_eq!(
            f.req(
                "GET",
                &format!("/evolve-cases?{query}"),
                "app",
                None,
                Value::Null
            )
            .await
            .0,
            400
        );
    }
    let outcome_id = Uuid::from_u128(2);
    let mut outcome = json!({"outcomeId":outcome_id,"versionId":f.version,"digest":DIGEST,"input":null,"expected":{"action":"refund"}});
    let send = |body| f.req("POST", "/outcomes", "app", None, body);
    for (key, value) in [
        ("digest", json!(HELD_OUT)),
        (
            "versionId",
            json!(Fixture::create_bundle(&f.state.db, &f.project).await.1),
        ),
        ("lesson", json!("old")),
        ("feedback", json!("old")),
        ("status", json!("old")),
    ] {
        let mut bad = outcome.clone();
        bad[key] = value;
        assert_eq!(send(bad).await.0, 400);
    }
    let mut bad = outcome.clone();
    bad.as_object_mut().unwrap().remove("expected");
    assert_eq!(send(bad).await.0, 400);
    let receipt = send(outcome.clone()).await;
    assert_eq!(
        receipt,
        (
            200,
            json!({"outcomeId":outcome_id,"caseId":format!("outcome:{outcome_id}"),"evolveRevision":3})
        )
    );
    assert_eq!(send(outcome.clone()).await, receipt);
    outcome["expected"] = json!("different");
    assert_eq!(send(outcome).await.0, 409);
    let stored: (String, Uuid) = sqlx::query_as(
        "SELECT source,version_id FROM learning_evolve_cases WHERE bundle_id=$1 AND outcome_id=$2",
    )
    .bind(f.bundle)
    .bind(outcome_id)
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert_eq!(stored, ("outcome".into(), f.version));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn round_pins_recovery_monitoring_and_pagination() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.spawn_worker();
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        f.ok("GET", "", "reader", None, Value::Null).await["activeRound"],
        Value::Null
    );
    f.seed().await;
    let incumbent = f.item("evolve", 1).await;
    assert_eq!(incumbent["versionId"], json!(f.version));
    assert_eq!(incumbent["evolveRevision"], 1);
    assert_eq!(incumbent["heldOut"], Value::Null);
    let round = round_route(&incumbent);
    let first = f.ok("GET", &round, "reader", None, Value::Null).await;
    assert_eq!(first["channelRevision"], "7");
    assert_eq!(first["channel"], "stable");
    assert_eq!(first["heldOut"], enrollment()["heldOut"]);
    assert_eq!(first["memoryRevision"], 0);
    assert_eq!(first["optimizerModel"], "fixture");
    assert!(sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,
        channel_revision,evolve_revision,memory_revision,setting,held_out)
        SELECT $1,project_id,bundle_id,999,state,parent_version_id,channel,channel_revision,evolve_revision,memory_revision,setting,held_out
        FROM learning_rounds WHERE bundle_id=$2")
        .bind(Uuid::new_v4()).bind(f.bundle).execute(&f.state.db).await.is_err());
    for (key, value) in [
        ("channel", json!("beta")),
        ("appPrincipalId", json!("other")),
        ("heldOut", json!({"digest":HELD_OUT,"cases":4})),
    ] {
        let mut change = enrollment();
        change[key] = value;
        assert_eq!(f.req("PUT", "", "admin", None, change).await.0, 409);
    }
    let mut change = enrollment();
    change["setting"]["benchmark"] = json!("next");
    assert_eq!(
        f.ok("PUT", "", "admin", None, change).await["setting"]["benchmark"],
        "next"
    );
    f.ok(
        "POST",
        "/evolve-cases",
        "app",
        None,
        json!({"retire":["a"],"cases":[case("c")]}),
    )
    .await;
    let outcome_id = Uuid::from_u128(2);
    let correction = f.ok("POST","/outcomes","app",None,json!({
        "outcomeId":outcome_id,"versionId":f.version,"digest":DIGEST,"input":"new","expected":"correct"
    })).await;
    let assignment = f.start(&incumbent, "attempt").await;
    assert_eq!(assignment["cases"], json!([case("a"), case("b")]));
    let mut a = result("a", 1.0);
    let long_trace = "t".repeat(100 * 1024);
    a["rollouts"][0]["trace"] = json!(&long_trace);
    a["rollouts"][0]["error"] = Value::Null;
    let report_uri = eval_route(&incumbent, "report");
    let ack = f
        .ok(
            "POST",
            &report_uri,
            "app",
            Some("case-a"),
            report(&[a.clone()]),
        )
        .await;
    assert_eq!(ack["reportedCases"], 1);
    assert_eq!(
        f.ok(
            "POST",
            &report_uri,
            "app",
            Some("duplicate-a"),
            report(&[a])
        )
        .await,
        ack
    );
    assert_eq!(
        f.req(
            "POST",
            &report_uri,
            "app",
            Some("changed-a"),
            report(&[result("a", 0.0)])
        )
        .await
        .0,
        409
    );

    f.crash_worker().await;
    assert_eq!(
        f.start(&incumbent, "attempt").await["reportedCaseIds"],
        json!(["a"])
    );
    f.ok(
        "POST",
        &report_uri,
        "app",
        Some("case-b"),
        report(&[result("b", 0.25)]),
    )
    .await;
    assert_eq!(
        f.ok("GET", &round, "reader", None, Value::Null).await["state"],
        "scoring_incumbent"
    );
    f.spawn_worker();

    let retained = f.item("heldOut", 1).await;
    let heldout_id = retained["evaluationId"].as_str().unwrap();
    assert_eq!(retained["heldOut"], enrollment()["heldOut"]);
    assert_eq!(retained["evolveRevision"], Value::Null);
    let hold = f.start(&retained, "attempt").await;
    assert_eq!(hold["heldOut"], retained["heldOut"]);
    assert_eq!(hold["cases"], Value::Null);
    let hold_route = eval_route(&retained, "report");
    for field in ["trace", "error", "extra"] {
        let mut bad = result("private-sentinel", 0.25);
        bad["rollouts"][0][field] = Value::Null;
        assert_eq!(
            f.req("POST", &hold_route, "app", Some("bad-hold"), report(&[bad]))
                .await
                .0,
            400
        );
    }
    let private = result("private-sentinel", 0.25);
    assert_eq!(
        f.req(
            "POST",
            &hold_route,
            "app",
            Some("bad-hold"),
            report(&[private.clone(), result("extra", 0.0)])
        )
        .await
        .0,
        400
    );
    assert_eq!(
        f.req(
            "POST",
            &hold_route,
            "app",
            Some("bad-hold"),
            report(&[private.clone(), private.clone()])
        )
        .await
        .0,
        400
    );
    let held = f
        .ok(
            "POST",
            &hold_route,
            "app",
            Some("valid-hold"),
            report(&[private]),
        )
        .await;
    assert!(held.get("caseSummaries").is_none() && held.get("report").is_none());
    let completed = f
        .wait_for(&round, "reader", |v| v["state"] == "completed")
        .await;
    assert_eq!(completed["setting"]["benchmark"], "v3");
    assert_eq!(completed["incumbentScore"], 0.625);
    assert_eq!(completed["heldOutScore"], 0.25);
    assert_eq!(completed["decision"], "kept");
    assert_eq!(completed["reason"], "no-candidates");
    assert_eq!(completed["evaluations"].as_array().unwrap().len(), 2);
    assert!(!completed.to_string().contains("private-sentinel"));
    assert!(!completed.to_string().contains(&long_trace));
    let full = f
        .ok(
            "GET",
            &format!(
                "{round}?evaluation={}",
                incumbent["evaluationId"].as_str().unwrap()
            ),
            "reader",
            None,
            Value::Null,
        )
        .await;
    assert_eq!(
        full["evaluations"][0]["report"]["cases"][0]["rollouts"][0]["trace"],
        long_trace
    );
    assert!(!full.to_string().contains("private-sentinel"));
    assert_eq!(
        f.req(
            "GET",
            &format!("{round}?evaluation={heldout_id}"),
            "reader",
            None,
            Value::Null
        )
        .await
        .0,
        400
    );
    let second = f.item("evolve", 2).await;
    let second_assignment = f.start(&second, "attempt").await;
    let cases = second_assignment["cases"].as_array().unwrap();
    assert_eq!(
        cases
            .iter()
            .map(|c| c["caseId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["b", "c", correction["caseId"].as_str().unwrap()]
    );
    let page = f
        .ok("GET", "/rounds?limit=1", "reader", None, Value::Null)
        .await;
    assert_eq!(page["items"][0]["number"], 2);
    assert_eq!(page["next"], 2);
    let page = f
        .ok(
            "GET",
            "/rounds?before=2&limit=1",
            "reader",
            None,
            Value::Null,
        )
        .await;
    assert_eq!(page["items"][0]["number"], 1);
    assert_eq!(page["next"], Value::Null);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn evaluation_ownership_attempts_and_strict_reports() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    let user = format!("console/{}", session(&f, "admin").await);
    for caller in ["reader", "other", &user] {
        assert_eq!(
            f.req("GET", "/work", caller, None, Value::Null).await.0,
            403
        );
        for action in ["start", "report"] {
            assert_eq!(
                f.req(
                    "POST",
                    &eval_route(&item, action),
                    caller,
                    Some("attempt"),
                    json!({"attemptId":"attempt"})
                )
                .await
                .0,
                403
            );
        }
    }
    let other = Fixture::new().await;
    other.enroll().await;
    for action in ["start", "report"] {
        let unknown = json!({"evaluationId":Uuid::new_v4()});
        let body = json!({"attemptId":"attempt"});
        assert_eq!(
            f.req(
                "POST",
                &eval_route(&unknown, action),
                "app",
                Some("attempt"),
                body.clone()
            )
            .await
            .0,
            404
        );
        assert_eq!(
            other
                .req(
                    "POST",
                    &eval_route(&item, action),
                    "app",
                    Some("attempt"),
                    body
                )
                .await
                .0,
            404
        );
    }
    let start_uri = eval_route(&item, "start");
    assert_eq!(
        f.req(
            "POST",
            &start_uri,
            "app",
            None,
            json!({"attemptId":"attempt"})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        f.start(&item, "attempt").await,
        f.start(&item, "attempt").await
    );
    assert_eq!(
        f.req(
            "POST",
            &start_uri,
            "app",
            Some("another"),
            json!({"attemptId":"another"})
        )
        .await
        .0,
        409
    );
    let uri = eval_route(&item, "report");
    let mut wrong_count = result("a", 0.5);
    wrong_count["rollouts"].as_array_mut().unwrap().pop();
    let mut bad_trace = result("a", 0.5);
    bad_trace["rollouts"][0]["trace"] = json!(1);
    for bad in [
        wrong_count,
        bad_trace,
        result("a", 1.5),
        result("outside", 0.5),
    ] {
        assert_eq!(
            f.req("POST", &uri, "app", Some("bad"), report(&[bad]))
                .await
                .0,
            400
        );
    }
    let correct = report(&[result("a", 0.5), result("b", 0.75)]);
    let receipt = f
        .ok("POST", &uri, "app", Some("done"), correct.clone())
        .await;
    assert_eq!(receipt["score"], 0.625);
    assert_eq!(receipt["status"], "scored");
    assert_eq!(
        f.ok("POST", &uri, "app", Some("done"), correct).await,
        receipt
    );
    assert_eq!(
        f.req(
            "POST",
            &uri,
            "app",
            Some("done"),
            report(&[result("a", 0.5)])
        )
        .await
        .1["error"]["code"],
        "learning_conflict"
    );
    assert_eq!(
        f.start(&item, "attempt").await["evaluation"]["status"],
        "scored"
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn pause_resume_stop_and_held_out_failure() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    assert_eq!(
        f.ok("POST", "/resume", "admin", None, Value::Null).await["status"],
        "running"
    );
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    let paused = f
        .ok("POST", "/pause", "admin", Some("pause"), Value::Null)
        .await;
    assert_eq!(paused["pauseReason"], "operator");
    assert_eq!(
        f.ok("POST", "/pause", "admin", None, Value::Null).await,
        paused
    );
    assert_eq!(
        f.ok("GET", "/work", "app", None, Value::Null).await["status"],
        "paused"
    );
    f.start(&item, "attempt").await;
    f.ok(
        "POST",
        &eval_route(&item, "report"),
        "app",
        Some("both"),
        report(&[result("a", 0.5), result("b", 0.5)]),
    )
    .await;
    let held = f.item("heldOut", 1).await;
    f.start(&held, "attempt").await;
    let failure = f
        .ok(
            "POST",
            &eval_route(&held, "report"),
            "app",
            Some("error"),
            json!({"attemptId":"attempt","error":"learning.held_out_mismatch"}),
        )
        .await;
    assert_eq!(failure["status"], "failed");
    let round = f
        .wait_for(&round_route(&held), "reader", |v| v["state"] == "completed")
        .await;
    assert_eq!(round["heldOutError"], "learning.held_out_mismatch");
    assert_eq!(round["decision"], "kept");
    assert_eq!(
        f.ok("GET", "/work", "app", None, Value::Null).await["items"],
        json!([])
    );

    for (number, running) in [(2, false), (3, true)] {
        let resumed = f.ok("POST", "/resume", "admin", None, Value::Null).await;
        assert_eq!(resumed["pauseReason"], Value::Null);
        let item = f.item("evolve", number).await;
        if running {
            f.start(&item, "attempt").await;
        }
        let stopped = f.ok("POST", "/stop", "admin", None, Value::Null).await;
        assert_eq!(stopped["status"], "stopped");
        assert_eq!(stopped["failedRounds"], 0);
        assert_eq!(stopped["nextRound"], number + 1);
        assert_eq!(
            f.ok("POST", "/stop", "admin", None, Value::Null).await,
            stopped
        );
        assert_eq!(
            f.ok("GET", "/work", "app", None, Value::Null).await["items"],
            json!([])
        );
        let round = f
            .ok("GET", &round_route(&item), "reader", None, Value::Null)
            .await;
        assert_eq!(round["reason"], "stopped");
        assert_eq!(round["evaluations"][0]["status"], "cancelled");
        assert_eq!(
            f.req(
                "POST",
                &eval_route(&item, "report"),
                "app",
                Some("late"),
                report(&[result("a", 1.0)])
            )
            .await
            .0,
            409
        );
        for route in ["/pause", "/resume"] {
            assert_eq!(
                f.req("POST", route, "admin", None, Value::Null).await.0,
                409
            );
        }
        assert_eq!(f.enroll().await["status"], "running");
    }
    let item = f.item("evolve", 4).await;
    f.start(&item, "attempt").await;
    f.ok(
        "POST",
        &eval_route(&item, "report"),
        "app",
        Some("both"),
        report(&[result("a", 1.0), result("b", 1.0)]),
    )
    .await;
    let held = f.item("heldOut", 4).await;
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    f.ok("POST", "/stop", "admin", None, Value::Null).await;
    let round = f
        .ok("GET", &round_route(&held), "reader", None, Value::Null)
        .await;
    assert_eq!(round["state"], "stopped");
    assert_eq!(round["decision"], "kept");
    assert_eq!(round["reason"], "no-candidates");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn queue_and_run_deadlines_count_toward_auto_pause() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    for (number, running) in [(1, false), (2, true), (3, false)] {
        let item = f.item("evolve", number).await;
        if running {
            f.start(&item, "attempt").await;
        }
        f.crash_worker().await;
        let id = Uuid::parse_str(item["evaluationId"].as_str().unwrap()).unwrap();
        sqlx::query(
            "UPDATE learning_evaluations SET deadline_at=now()-interval '1 second' WHERE id=$1",
        )
        .bind(id)
        .execute(&f.state.db)
        .await
        .unwrap();
        assert_eq!(
            f.req(
                "POST",
                &eval_route(&item, "start"),
                "app",
                Some("attempt"),
                json!({"attemptId":"attempt"})
            )
            .await
            .0,
            409
        );
        if running {
            assert_eq!(
                f.req(
                    "POST",
                    &eval_route(&item, "report"),
                    "app",
                    Some("expired"),
                    report(&[result("a", 0.0)])
                )
                .await
                .0,
                409
            );
        }
        f.spawn_worker();
        let failed = f
            .wait_for(&round_route(&item), "reader", |v| v["state"] == "failed")
            .await;
        assert_eq!(failed["reason"], "incumbent-evaluation-failed");
        assert_eq!(
            failed["evaluations"][0]["error"],
            if running {
                "Evaluation run deadline passed"
            } else {
                "Evaluation queue deadline passed"
            }
        );
    }
    let paused = f.ok("GET", "", "reader", None, Value::Null).await;
    assert_eq!(paused["pauseReason"], "failed-rounds");
    assert_eq!(paused["failedRounds"], 3);
    let resumed = f.ok("POST", "/resume", "admin", None, Value::Null).await;
    assert_eq!(resumed["failedRounds"], 0);
    f.item("evolve", 4).await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn task_custody_revisions_confirmation_and_outcomes() {
    let f = Fixture::new().await;
    f.enroll().await;
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
    assert_eq!(
        f.ok("GET", "/evolve-cases", "app", None, Value::Null).await["items"],
        json!([])
    );
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
