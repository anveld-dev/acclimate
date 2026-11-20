use super::*;
use acclimate_service::{ModelFuture, OpenAiModel, OptimizerModel};
use axum::{
    Json, Router,
    extract::State,
    response::{IntoResponse, Response},
    routing::post,
};
use std::sync::Mutex;

pub(super) struct NoChangeModel(pub &'static str);

impl OptimizerModel for NoChangeModel {
    fn model(&self) -> &str {
        self.0
    }
    fn propose<'a>(&'a self, _: &'a Value) -> ModelFuture<'a> {
        Box::pin(async {
            Ok(proposal(
                "Review the supplied diff and support every finding.\n",
                "Review needs structure",
            )
            .to_string())
        })
    }
    fn screen<'a>(&'a self, _: &'a Value) -> ModelFuture<'a> {
        panic!("no samples changed")
    }
    fn select<'a>(&'a self, _: &'a Value) -> ModelFuture<'a> {
        panic!("no samples changed")
    }
}

fn proposal(text: &str, root: &str) -> Value {
    json!({
        "schemaVersion": 2, "rationale": "Check supporting evidence.",
        "edits": [], "files": [{"op": "write", "path": "instructions/review.md", "text": text}],
        "diagnosis": {"problem": {"new": root}, "predicted": ["a", "b"]}
    })
}

type Requests = Arc<Mutex<Vec<Value>>>;

struct ModelServer {
    task: JoinHandle<()>,
    requests: Requests,
}

impl Drop for ModelServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn model(
    f: &mut Fixture,
    script: impl Fn(usize, &Value) -> (StatusCode, Value) + Send + Sync + 'static,
) -> ModelServer {
    let requests: Requests = Default::default();
    let script = Arc::new(script);
    let app = Router::new().route("/chat/completions", post(
        async move |State(capture): State<Requests>, Json(body): Json<Value>| -> Response {
            assert_eq!(body["model"], "fixture");
            assert_eq!(body["max_completion_tokens"], 32768);
            assert!(body.get("temperature").is_none());
            assert!(body["messages"][0]["content"].as_str().unwrap().contains("Follow these rules."));
            let raw = body["messages"][1]["content"].as_str().unwrap();
            let inner = raw.strip_prefix("<untrusted-data>\n").unwrap().strip_suffix("\n</untrusted-data>").unwrap();
            assert!(!inner.contains(['<', '>']));
            let data: Value = serde_json::from_str(inner).unwrap();
            assert!(!inner.contains(HELD_OUT));
            assert!(!inner.contains("held-out-sentinel"));
            let n = {
                let mut requests = capture.lock().unwrap();
                let n = requests.len();
                requests.push(data.clone());
                n
            };
            let (status, output) = script(n, &data);
            if status.is_success() {
                Json(json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]})).into_response()
            } else {
                (status, Json(output)).into_response()
            }
        }
    )).with_state(requests.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    f.state.optimizer = Some(Arc::new(
        OpenAiModel::new(
            &format!("http://{addr}/chat/completions"),
            "fixture".into(),
            "fixture",
            30,
            32768,
        )
        .unwrap(),
    ));
    ModelServer { task, requests }
}

fn screen(data: &Value, skip: bool) -> Value {
    json!({"samples":data["candidates"].as_array().unwrap().iter().map(|candidate| json!({
        "sample":candidate["sample"],"verdict": if skip {"skip"} else {"evaluate"},"reason":"Screen decision."
    })).collect::<Vec<_>>()})
}

async fn evaluate(f: &Fixture, item: &Value, cases: &[Value]) {
    f.start(item, "attempt").await;
    f.ok(
        "POST",
        &eval_route(item, "report"),
        "app",
        Some("report"),
        report(cases),
    )
    .await;
}

async fn incumbent(f: &Fixture, number: i32) -> Value {
    let item = f.item("evolve", number).await;
    assert_eq!(item["role"], "incumbent");
    let mut a = result("a", 0.0);
    a["rollouts"][0]["trace"] = json!("evolve <trace>");
    a["rollouts"][0]["error"] = json!("evolve error");
    evaluate(f, &item, &[a, result("b", 0.0)]).await;
    item
}

async fn retained(f: &Fixture, n: i32) -> Value {
    let item = f.item("heldOut", n).await;
    assert_eq!(item["role"], "retained");
    evaluate(f, &item, &[result("held-out-sentinel", 0.0)]).await;
    f.wait_for(&round_route(&item), "reader", |round| {
        round["state"] == "completed"
    })
    .await
}

async fn prepare(f: &mut Fixture) {
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn adoption_releases_only_selected_sample_and_merges_memory_across_rounds() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| {
        let turn = n % 7;
        let round = n / 7;
        let output = match turn {
            0..=4 => {
                let root = match (round, turn) {
                    (0, 1) => "The harness needs review structure",
                    (1, 1) => " The  harness needs\treview structure ",
                    _ => "Unused alternative diagnosis",
                };
                proposal(
                    &format!("Checklist step {turn} for revision {round}."),
                    root,
                )
            }
            5 => screen(data, false),
            _ => json!({"decision":"adopt","sample":2,"reason":"Prefer sample two."}),
        };
        (StatusCode::OK, output)
    })
    .await;
    let empty = {
        f.enroll().await;
        f.ok("GET", "/memory", "reader", None, Value::Null).await
    };
    assert_eq!(
        empty["improvementMemory"],
        json!({"memoryRevision":0,"schemaVersion":1,"problems":[]})
    );
    prepare(&mut f).await;
    let mut prior_digest = Value::Null;
    for n in 1..=2 {
        let start = incumbent(&f, n).await;
        for sample in 1..=5 {
            let item = f.item("evolve", n).await;
            assert_eq!(item["sample"], sample);
            let round = f
                .ok("GET", &round_route(&item), "reader", None, Value::Null)
                .await;
            assert_eq!(round["candidates"].as_array().unwrap().len(), 5);
            for candidate in round["candidates"].as_array().unwrap() {
                assert_eq!(candidate["diagnosis"]["predicted"], json!(["a", "b"]));
            }
            let scores = if sample == 2 { (1.0, 0.0) } else { (0.0, 1.0) };
            evaluate(&f, &item, &[result("a", scores.0), result("b", scores.1)]).await;
        }
        if n == 2 {
            f.ok("POST", "/pause", "admin", None, Value::Null).await;
        }
        let round = retained(&f, n).await;
        assert_eq!(round["decision"], "adopted");
        assert_eq!(round["heldOutScore"], 0.0);
        assert_eq!(round["selection"]["sample"], 2);
        assert_eq!(
            round["adoptedVersionId"],
            round["candidates"][1]["versionId"]
        );
        assert_ne!(round["adoptedVersionId"], start["versionId"]);
        let memory = f.ok("GET", "/memory", "reader", None, Value::Null).await;
        assert_eq!(memory["currentRevision"], n);
        assert_eq!(
            memory["improvementMemory"]["problems"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let problem = &memory["improvementMemory"]["problems"][0];
        assert_eq!(problem["id"], "P1");
        assert_eq!(problem["attempts"].as_array().unwrap().len(), n as usize);
        let attempt = &problem["attempts"][n as usize - 1];
        assert_eq!(attempt["sample"], 2);
        assert_eq!(attempt["fixed"], json!(["a"]));
        assert_eq!(attempt["missed"], json!(["b"]));
        assert_eq!(attempt["passed"], 5);
        assert_eq!(attempt["total"], 10);
        assert_eq!(
            memory["records"][0]["provenance"]["heldOutDigest"],
            HELD_OUT
        );
        assert!(attempt["provenance"].get("heldOutDigest").is_none());
        if n == 1 {
            prior_digest = memory["memoryDigest"].clone();
        } else {
            assert_eq!(round["memoryDigest"], prior_digest);
            assert_eq!(
                f.ok("GET", "/memory?revision=1", "reader", None, Value::Null)
                    .await["memoryDigest"],
                prior_digest
            );
        }
    }
    for table in ["learning_memory_problems", "learning_memory_attempts"] {
        for statement in [
            format!("UPDATE {table} SET problem_id=problem_id WHERE bundle_id=$1"),
            format!("DELETE FROM {table} WHERE bundle_id=$1"),
        ] {
            let error = sqlx::query(&statement)
                .bind(f.bundle)
                .execute(&f.state.db)
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("improvement memory is append-only")
            );
        }
    }
    let calls = server.requests.lock().unwrap();
    assert_eq!(calls.len(), 14);
    for offset in [0, 7] {
        assert!(
            calls[offset..offset + 5]
                .iter()
                .all(|data| *data == calls[offset])
        );
    }
    for request in calls.iter() {
        assert_eq!(
            request["feedback"]["cases"][0]["rollouts"][0]["trace"],
            "evolve <trace>"
        );
        assert!(request["feedback"]["cases"][0].get("expected").is_none());
        assert!(request.get("heldOut").is_none());
    }
    assert!(calls[0]["history"].as_array().unwrap().is_empty());
    assert_eq!(
        calls[7]["history"][0]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(calls[7]["history"][0]["selection"]["decision"], "adopt");
    assert_eq!(calls[7]["improvementMemory"]["memoryRevision"], 1);
    assert_eq!(calls[6]["candidates"][1]["evolve"]["fixed"], json!(["a"]));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn selector_keeps_after_scoring_survivors() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| (StatusCode::OK, match n {
        0..=4 => proposal("Updated review instructions.", "Old instructions were vague"),
        5 => json!({"samples":data["candidates"].as_array().unwrap().iter().map(|c| json!({
            "sample":c["sample"],"reason":"Screen decision.","verdict": if c["sample"] == 3 {"evaluate"} else {"skip"}
        })).collect::<Vec<_>>()}),
        _ => json!({"decision":"keep","reason":"Performance did not improve."}),
    })).await;
    prepare(&mut f).await;
    incumbent(&f, 1).await;
    let item = f.item("evolve", 1).await;
    assert_eq!(item["sample"], 3);
    evaluate(&f, &item, &[result("a", 0.0), result("b", 0.0)]).await;
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    let round = retained(&f, 1).await;
    assert_eq!(round["reason"], "selector-kept");
    assert_eq!(round["selection"]["decision"], "keep");
    assert!(round["selection"]["versionId"].is_null());
    assert_eq!(
        server.requests.lock().unwrap()[6]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.ok("GET", "/memory", "reader", None, Value::Null).await["currentRevision"],
        0
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn every_generated_sample_can_be_screened_out() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| {
        (
            StatusCode::OK,
            if n < 5 {
                proposal("Changed review instructions.", "The review lacks structure")
            } else {
                screen(data, true)
            },
        )
    })
    .await;
    prepare(&mut f).await;
    incumbent(&f, 1).await;
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    let round = retained(&f, 1).await;
    assert_eq!(round["reason"], "no-survivors");
    assert!(
        round["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|candidate| {
                candidate["status"] == "screened_out" && candidate["versionId"].is_null()
            })
    );
    assert_eq!(server.requests.lock().unwrap().len(), 6);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn all_samples_drop_with_retry_and_scanner_findings() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| {
        let output = match n {
            0 | 1 => {
                assert_eq!(data.get("parserError").is_some(), n == 1);
                json!({"bad":"private provider response"})
            }
            2 => proposal("Call person@example.test", "A broad issue"),
            3 => proposal("General review update.", "Contact person@example.test"),
            _ => proposal(
                "Review the supplied diff and support every finding.\n",
                "A broad issue",
            ),
        };
        (StatusCode::OK, output)
    })
    .await;
    prepare(&mut f).await;
    incumbent(&f, 1).await;
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    let round = retained(&f, 1).await;
    assert_eq!(round["reason"], "no-candidates");
    assert_eq!(round["candidates"][0]["dropReason"], "format-rejected");
    assert_eq!(
        round["candidates"][1]["scan"]["findings"][0]["rule"],
        "email"
    );
    assert_eq!(
        round["candidates"][1]["scan"]["findings"][0]["field"],
        "text"
    );
    assert_eq!(round["candidates"][2]["diagnosis"], Value::Null);
    assert_eq!(round["candidates"][4]["dropReason"], "no-change");
    assert!(!round.to_string().contains("person@example.test"));
    let calls = server.requests.lock().unwrap();
    assert_eq!(calls.len(), 6);
    let mut retry = calls[1].clone();
    retry.as_object_mut().unwrap().remove("parserError");
    assert_eq!(calls[0], retry);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn provider_failures_pause_after_three_rounds_without_format_retries() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |_, _| {
        (
            StatusCode::UNAUTHORIZED,
            json!({"error":"private provider response"}),
        )
    })
    .await;
    prepare(&mut f).await;
    for number in 1..=3 {
        let item = incumbent(&f, number).await;
        let round = f
            .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
            .await;
        assert_eq!(round["reason"], "optimizer-unavailable");
        assert_eq!(round["evaluations"].as_array().unwrap().len(), 1);
    }
    let stopped = f.ok("GET", "", "reader", None, Value::Null).await;
    assert_eq!(stopped["pauseReason"], "failed-rounds");
    assert_eq!(stopped["failedRounds"], 3);
    assert_eq!(server.requests.lock().unwrap().len(), 15);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn context_overflow_pauses_immediately() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |_, _| {
        (
            StatusCode::BAD_REQUEST,
            json!({"error":{"message":"Maximum context exceeded"}}),
        )
    })
    .await;
    prepare(&mut f).await;
    let item = incumbent(&f, 1).await;
    let round = f
        .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await;
    assert_eq!(round["reason"], "optimizer-context-too-large");
    let stopped = f.ok("GET", "", "reader", None, Value::Null).await;
    assert_eq!(stopped["pauseReason"], "optimizer-context-too-large");
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn memory_and_evolve_cases_require_the_right_principal() {
    let f = Fixture::new().await;
    assert_eq!(
        f.req("GET", "/memory", "reader", None, Value::Null).await.0,
        404
    );
    f.enroll().await;
    assert_eq!(
        f.req("GET", "/memory", "app", None, Value::Null).await.0,
        403
    );
    assert_eq!(
        f.req("GET", "/memory?revision=-1", "reader", None, Value::Null)
            .await
            .0,
        400
    );
    assert_eq!(
        f.req("GET", "/memory?revision=1", "reader", None, Value::Null)
            .await
            .0,
        404
    );
    let editor = format!("console/{}", session(&f, "editor").await);
    let viewer = format!("console/{}", session(&f, "viewer").await);
    let request = json!({"cases":[case("human-case")]});
    assert_eq!(
        f.req("POST", "/evolve-cases", &viewer, None, request.clone())
            .await
            .0,
        403
    );
    assert_eq!(
        f.ok("POST", "/evolve-cases", &editor, None, request).await["added"],
        1
    );
    assert_eq!(
        f.req("GET", "/work", &editor, None, Value::Null).await.0,
        403
    );
    assert_eq!(
        f.req("POST", "/outcomes", &editor, None, json!({})).await.0,
        403
    );
}

async fn await_sql(f: &Fixture, query: &str, round: Uuid) {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let ready: bool = sqlx::query_scalar(query)
                .bind(round)
                .fetch_one(&f.state.db)
                .await
                .unwrap();
            if ready {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("database state did not become ready for round {round}: {query}"));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn restart_replays_all_new_states_and_keeps_if_channel_moves_after_selection() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| (StatusCode::OK, match n {
        0..=4 => proposal("Revised guide.", "The review lacks structure"),
        5 => json!({"samples":data["candidates"].as_array().unwrap().iter().map(|c| json!({
            "sample":c["sample"],"reason":"Screen decision.","verdict": if c["sample"] == 2 {"evaluate"} else {"skip"}
        })).collect::<Vec<_>>()}),
        _ => json!({"decision":"adopt","sample":2,"reason":"Adopt the revision."}),
    })).await;
    prepare(&mut f).await;
    // Hold each transition after its call output commits so the worker can
    // be restarted at that checkpoint independent of when the poll runs.
    sqlx::raw_sql(
        "
        CREATE FUNCTION test_replay_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'fixture interrupted round advancement';
        END $$;
        CREATE TRIGGER test_proposing_guard BEFORE UPDATE ON learning_rounds FOR EACH ROW
        WHEN (OLD.state='proposing' AND NEW.state IS DISTINCT FROM OLD.state)
        EXECUTE FUNCTION test_replay_guard();
        CREATE TRIGGER test_screening_guard BEFORE UPDATE ON learning_rounds FOR EACH ROW
        WHEN (OLD.state='screening' AND NEW.state IS DISTINCT FROM OLD.state)
        EXECUTE FUNCTION test_replay_guard();",
    )
    .execute(&f.state.db)
    .await
    .unwrap();
    let item = incumbent(&f, 1).await;
    let id = Uuid::parse_str(item["roundId"].as_str().unwrap()).unwrap();
    for (kind, sample, state) in [("propose", 5, "proposing"), ("screen", 0, "screening")] {
        let query = format!("SELECT EXISTS(SELECT 1 FROM learning_rounds r JOIN learning_optimizer_calls c ON r.id=c.round_id
            WHERE r.id=$1 AND r.state='{state}' AND c.kind='{kind}' AND c.sample={sample} AND c.status='succeeded')");
        await_sql(&f, &query, id).await;
        f.crash_worker().await;
        sqlx::query(&format!(
            "DROP TRIGGER test_{state}_guard ON learning_rounds"
        ))
        .execute(&f.state.db)
        .await
        .unwrap();
        f.spawn_worker();
    }
    let candidate = f.item("evolve", 1).await;
    assert_eq!(candidate["sample"], 2);
    f.start(&candidate, "attempt").await;
    f.crash_worker().await;
    f.spawn_worker();
    assert_eq!(
        f.item("evolve", 1).await["evaluationId"],
        candidate["evaluationId"]
    );
    // Pause while the last survivor is running; the active round continues.
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    // A test trigger denies the adoption step, leaving the successful select
    // output committed and forcing the same transition to replay after restart.
    sqlx::raw_sql(&format!(
        "
        CREATE FUNCTION test_adopt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.id='{id}' AND NEW.decision='adopted' THEN
                RAISE EXCEPTION 'fixture interrupted adoption';
            END IF;
            RETURN NEW;
        END $$;
        CREATE TRIGGER test_adopt_guard BEFORE UPDATE ON learning_rounds
        FOR EACH ROW EXECUTE FUNCTION test_adopt_guard();"
    ))
    .execute(&f.state.db)
    .await
    .unwrap();
    f.ok(
        "POST",
        &eval_route(&candidate, "report"),
        "app",
        Some("report"),
        report(&[result("a", 1.0), result("b", 0.0)]),
    )
    .await;
    await_sql(&f,"SELECT EXISTS(SELECT 1 FROM learning_optimizer_calls WHERE round_id=$1 AND kind='select' AND status='succeeded')",id).await;
    f.crash_worker().await;
    let promotions: i64 = sqlx::query_scalar("SELECT count(*) FROM promotions WHERE bundle_id=$1")
        .bind(f.bundle)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(promotions, 0);
    assert_eq!(
        f.ok("GET", "/memory", "reader", None, Value::Null).await["currentRevision"],
        0
    );
    let moved = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by)
        SELECT $1,project_id,$2,digest,payload,'test' FROM versions WHERE id=$3",
    )
    .bind(moved)
    .bind(f.bundle)
    .bind(f.version)
    .execute(&f.state.db)
    .await
    .unwrap();
    let reply = f.app.clone().oneshot(Request::post(format!("/v1/workspaces/{}/bundles/{}/channels/stable/releases", f.project,f.bundle))
        .header("authorization","Bearer admin").header("idempotency-key","manual-release").header("content-type","application/json")
        .body(Body::from(json!({"versionId":moved,"expectedRevision":"7","unevaluatedReason":"Manual release"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(
        reply.status(),
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&to_bytes(reply.into_body(), 4096).await.unwrap())
    );
    f.spawn_worker();
    let round = retained(&f, 1).await;
    assert_eq!(round["decision"], "kept");
    assert_eq!(round["reason"], "channel-moved");
    assert_eq!(round["selection"]["decision"], "adopt");
    assert_eq!(round["selection"]["sample"], 2);
    assert_eq!(
        round["evaluations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["role"] == "retained")
            .unwrap()["versionId"],
        json!(moved)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 7);
    assert_eq!(
        f.ok("GET", "/memory", "reader", None, Value::Null).await["currentRevision"],
        0
    );
    sqlx::raw_sql(
        "DROP TRIGGER test_adopt_guard ON learning_rounds; DROP FUNCTION test_adopt_guard()",
    )
    .execute(&f.state.db)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn failed_survivor_deadline_advances_to_held_out() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| (StatusCode::OK, if n < 5 {
        proposal("Revised guide.", "The review lacks structure")
    } else {
        json!({"samples":data["candidates"].as_array().unwrap().iter().map(|c| json!({
            "sample":c["sample"],"reason":"Screen decision.","verdict": if c["sample"] == 1 {"evaluate"} else {"skip"}
        })).collect::<Vec<_>>()})
    })).await;
    prepare(&mut f).await;
    incumbent(&f, 1).await;
    let candidate = f.item("evolve", 1).await;
    f.start(&candidate, "attempt").await;
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    sqlx::query(
        "UPDATE learning_evaluations SET deadline_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(Uuid::parse_str(candidate["evaluationId"].as_str().unwrap()).unwrap())
    .execute(&f.state.db)
    .await
    .unwrap();
    let round = retained(&f, 1).await;
    assert_eq!(round["reason"], "no-evaluated-candidates");
    assert_eq!(round["candidates"][0]["status"], "evaluation_failed");
    assert_eq!(server.requests.lock().unwrap().len(), 6);
}

#[derive(Default)]
struct BlockFirstCall {
    requests: std::sync::atomic::AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl OptimizerModel for BlockFirstCall {
    fn model(&self) -> &str {
        "fixture"
    }
    fn propose<'a>(&'a self, _: &'a Value) -> ModelFuture<'a> {
        Box::pin(async {
            if self
                .requests
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                self.entered.notify_one();
                self.release.notified().await;
            }
            Ok(proposal(
                "Review the supplied diff and support every finding.\n",
                "A fixture diagnosis",
            )
            .to_string())
        })
    }
    fn screen<'a>(&'a self, _: &'a Value) -> ModelFuture<'a> {
        panic!("no survivors were expected")
    }
    fn select<'a>(&'a self, _: &'a Value) -> ModelFuture<'a> {
        panic!("no survivors were expected")
    }
}

async fn blocked_proposal() -> (Fixture, Arc<BlockFirstCall>, Value) {
    let mut f = Fixture::new().await;
    let model = Arc::new(BlockFirstCall::default());
    f.state.optimizer = Some(model.clone());
    prepare(&mut f).await;
    let item = incumbent(&f, 1).await;
    // The claim is visible in PostgreSQL before the task enters the model.
    tokio::time::timeout(Duration::from_secs(60), model.entered.notified())
        .await
        .expect("first proposal did not enter the model");
    (f, model, item)
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn orphan_claim_requeues_and_exhausted_claim_fails() {
    {
        let (mut f, _, item) = blocked_proposal().await;
        let id = Uuid::parse_str(item["roundId"].as_str().unwrap()).unwrap();
        let digest: String = sqlx::query_scalar(
            "SELECT input_digest FROM learning_optimizer_calls
             WHERE round_id=$1 AND kind='propose' AND sample=1 AND status='running' AND attempts=1",
        )
        .bind(id)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
        f.crash_worker().await;
        f.ok("POST", "/pause", "admin", None, Value::Null).await;
        f.spawn_worker();
        await_sql(&f,"SELECT EXISTS(SELECT 1 FROM learning_optimizer_calls WHERE round_id=$1 AND kind='propose' AND sample=1 AND status='succeeded' AND attempts=2)",id).await;
        let recovered_digest: String = sqlx::query_scalar(
            "SELECT input_digest FROM learning_optimizer_calls WHERE round_id=$1 AND kind='propose' AND sample=1",
        )
        .bind(id)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
        assert_eq!(recovered_digest, digest);
        f.crash_worker().await;
    }

    // Give the exhausted claim its own round so advancement can never
    // consume a success before we set up the orphan at its attempt limit.
    let (mut f, _, item) = blocked_proposal().await;
    let id = Uuid::parse_str(item["roundId"].as_str().unwrap()).unwrap();
    f.crash_worker().await;
    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    let digest: String = sqlx::query_scalar(
        "UPDATE learning_optimizer_calls SET attempts=3
         WHERE round_id=$1 AND kind='propose' AND sample=1 AND status='running' AND attempts=1
         RETURNING input_digest",
    )
    .bind(id)
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    f.spawn_worker();
    let doc = retained(&f, 1).await;
    assert_eq!(doc["candidates"][0]["dropReason"], "provider-failed");
    let status: (String,String,i32) = sqlx::query_as("SELECT error,input_digest,attempts FROM learning_optimizer_calls WHERE round_id=$1 AND sample=1")
        .bind(id).fetch_one(&f.state.db).await.unwrap();
    assert_eq!(status, ("attempt limit reached".into(), digest, 3));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn live_call_is_not_requeued_and_late_reply_after_stop_is_discarded() {
    let (f, model, item) = blocked_proposal().await;
    let id = Uuid::parse_str(item["roundId"].as_str().unwrap()).unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await; // cross a sweep while the provider is blocked
    let claim: (String, i32) = sqlx::query_as(
        "SELECT status,attempts FROM learning_optimizer_calls WHERE round_id=$1 AND kind='propose' AND sample=1",
    )
    .bind(id)
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert_eq!(claim, ("running".into(), 1));
    f.ok("POST", "/stop", "admin", None, Value::Null).await;
    model.release.notify_one();
    let doc = f
        .wait_for(&round_route(&item), "reader", |r| r["state"] == "stopped")
        .await;
    assert_eq!(doc["candidates"][0]["status"], "generating");
    let state: (String, String, i32, Option<Value>) = sqlx::query_as(
        "SELECT status,error_code,attempts,output FROM learning_optimizer_calls WHERE round_id=$1",
    )
    .bind(id)
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert_eq!(state, ("failed".into(), "cancelled".into(), 1, None));
    assert_eq!(model.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        f.ok("GET", "/memory", "reader", None, Value::Null).await["currentRevision"],
        0
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn history_keeps_all_same_setting_rounds_and_omits_held_out_data() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |_, _| (StatusCode::PAYLOAD_TOO_LARGE, json!({}))).await;
    f.enroll().await;
    f.seed().await;
    let setting = enrollment()["setting"].clone();
    for (first, last, pin) in [
        (1, 60, setting.clone()),
        (
            61,
            61,
            json!({"domain":"support","benchmark":"v3","policyModel":"other"}),
        ),
    ] {
        sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,decision,reason,parent_version_id,
            channel,channel_revision,evolve_revision,memory_revision,setting,held_out,incumbent_score,held_out_error,ended_at)
            SELECT gen_random_uuid(),$1,$2,n,'completed','kept','no-candidates',$3,'stable',7,1,0,$4,$5,0,'held-out-sentinel',now()
            FROM generate_series($6::int,$7::int) n")
            .bind(&f.project).bind(f.bundle).bind(f.version).bind(pin).bind(enrollment()["heldOut"].clone())
            .bind(first).bind(last).execute(&f.state.db).await.unwrap();
    }
    sqlx::query("INSERT INTO learning_candidates(round_id,sample,status,rationale,diagnosis,changes,scan)
        SELECT id,1,'generated',repeat('x',10000),'{\"problem\":{\"new\":\"Fixture\"},\"predicted\":[]}',
        '{\"edits\":[],\"files\":[]}', '{\"clean\":true,\"findings\":[]}'
        FROM learning_rounds WHERE bundle_id=$1")
        .bind(f.bundle).execute(&f.state.db).await.unwrap();
    sqlx::query("UPDATE learning_loops SET next_round=62 WHERE bundle_id=$1")
        .bind(f.bundle)
        .execute(&f.state.db)
        .await
        .unwrap();
    f.spawn_worker();
    let item = incumbent(&f, 62).await;
    f.wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let history = requests[0]["history"].as_array().unwrap();
    assert_eq!(history.len(), 60);
    for (i, item) in history.iter().enumerate() {
        assert_eq!(item["round"], i + 1);
        assert_eq!(
            item["candidates"][0]["rationale"].as_str().unwrap().len(),
            10_000
        );
        assert_eq!(item["setting"], setting);
    }
    assert!(
        !serde_json::to_string(history)
            .unwrap()
            .contains("held-out-sentinel")
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn invalid_screen_retries_once_and_fails_without_executing() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |n, data| {
        if n < 5 {
            (
                StatusCode::OK,
                proposal("New guide for reviewing.", "The review needs structure"),
            )
        } else {
            assert_eq!(data.get("parserError").is_some(), n == 6);
            assert_eq!(data["candidates"].as_array().unwrap().len(), 5);
            (StatusCode::OK, json!({"samples":[]}))
        }
    })
    .await;
    prepare(&mut f).await;
    let item = incumbent(&f, 1).await;
    let round = f
        .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await;
    assert_eq!(round["reason"], "selector-unavailable");
    assert_eq!(round["evaluations"].as_array().unwrap().len(), 1);
    assert!(
        round["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["status"] == "generated" && c["versionId"].is_null())
    );
    assert_eq!(server.requests.lock().unwrap().len(), 7);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn restart_with_another_model_leaves_the_pinned_round_unmixed() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    f.crash_worker().await;
    f.state.optimizer = Some(Arc::new(NoChangeModel("replacement")));
    let id = Uuid::parse_str(item["roundId"].as_str().unwrap()).unwrap();
    f.spawn_worker();
    evaluate(&f, &item, &[result("a", 0.0), result("b", 0.0)]).await;
    let round = f
        .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await;
    assert_eq!(round["optimizerModel"], "fixture");
    assert_eq!(round["reason"], "optimizer-unavailable");
    let errors: Vec<String> = sqlx::query_scalar(
        "SELECT error FROM learning_optimizer_calls WHERE round_id=$1 ORDER BY sample",
    )
    .bind(id)
    .fetch_all(&f.state.db)
    .await
    .unwrap();
    assert_eq!(errors, vec!["model changed"; 5]);
}
