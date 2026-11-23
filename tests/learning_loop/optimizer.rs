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
    prompt_bytes: Arc<std::sync::atomic::AtomicUsize>,
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
    let prompt_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let measured = prompt_bytes.clone();
    let app = Router::new().route("/chat/completions", post(
        async move |State(capture): State<Requests>, Json(body): Json<Value>| -> Response {
            assert_eq!(body["model"], "fixture");
            assert_eq!(body["max_completion_tokens"], 32768);
            assert!(body.get("temperature").is_none());
            assert!(body["messages"][0]["content"].as_str().unwrap().contains("Follow these rules."));
            measured.store(body["messages"].as_array().unwrap().iter().map(|m|m["content"].as_str().unwrap().len()).sum(),std::sync::atomic::Ordering::Relaxed);
            let raw = body["messages"][1]["content"].as_str().unwrap();
            let inner = raw.strip_prefix("<untrusted-data>\n").unwrap().strip_suffix("\n</untrusted-data>").unwrap();
            assert!(!inner.contains(['<', '>']));
            let data: Value = serde_json::from_str(inner).unwrap();
            assert!(!inner.contains(HELD_OUT));
            for marker in ["held-out-sentinel", "private-trial-log", "private-trial-result","private-gateway-log","private-judge-reason"] {
                assert!(!inner.contains(marker));
            }
            let n = {
                let mut requests = capture.lock().unwrap();
                let n = requests.len();
                requests.push(data.clone());
                n
            };
            let (status, output) = script(n, &data);
            if status.is_success() {
                Json(json!({"usage":{"total_tokens":17},"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]})).into_response()
            } else {
                (status, Json(output)).into_response()
            }
        }
    )).layer(axum::extract::DefaultBodyLimit::max(8<<20)).with_state(requests.clone());
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
    ModelServer {
        task,
        requests,
        prompt_bytes,
    }
}

fn screen(data: &Value, skip: bool) -> Value {
    json!({"samples":data["candidates"].as_array().unwrap().iter().map(|candidate| json!({
        "sample":candidate["sample"],"verdict": if skip {"skip"} else {"evaluate"},"reason":"Screen decision."
    })).collect::<Vec<_>>()})
}

pub(super) async fn evaluate(f: &Fixture, item: &Value, cases: &[Value]) {
    let app = f.internal();
    let id = item["evaluationId"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM learning_rollouts WHERE evaluation_id=$1")
            .bind(id)
            .fetch_one(&f.state.db)
            .await
            .unwrap();
    for _ in 0..count {
        let (status, lease) =
            executor_tests::post(&app, "", &f.token, json!({"executor":Fixture::identity()})).await;
        assert_eq!(status, 200, "{lease}");
        let task = lease["input"].as_str().unwrap();
        let passed = cases
            .iter()
            .find(|c| c["caseId"] == task)
            .is_some_and(|c| c["rollouts"][0]["passed"] == true);
        let log = json!({"at":0,"route":"chat/completions","model":"task","status":200,"request":task,"response":if task.starts_with("held-out") {"private-gateway-log"} else {"evolve trace"},"usage":{}});
        let (status, grader) = executor_tests::act(
            &app,
            &lease,
            "output",
            json!({"output":"reply","stop":"completed","gatewayLog":[log]}),
        )
        .await;
        assert_eq!(status, 200, "{grader}");
        let counts = json!({"input":1,"output":2});
        let mut verdict = json!({"score":i32::from(passed),"passed":passed,"reasons":[]});
        if task.starts_with("held-out") {
            verdict["reasons"] = json!(["private-judge-reason"]);
        }
        if grader["grader"]["type"] == "criteria" {
            verdict["votes"] = json!([passed, !passed, passed]);
            verdict["reasons"] = json!(["Evidence is incomplete."]);
        }
        assert_eq!(
            executor_tests::act(
                &app,
                &lease,
                "result",
                json!({"verdict":verdict,"judgeLog":[],"tokens":{"task":counts,"judge":counts}})
            )
            .await
            .0,
            204
        );
    }
}

async fn incumbent(f: &Fixture, number: i32) -> Value {
    let item = f.item("evolve", number).await;
    assert_eq!(item["role"], "incumbent");
    evaluate(f, &item, &[result("a", 0.0), result("b", 0.0)]).await;
    item
}

async fn retained(f: &Fixture, n: i32) -> Value {
    let item = f.item("heldOut", n).await;
    assert_eq!(item["role"], "retained");
    evaluate(f, &item, &[result("held-out-sentinel", 0.0)]).await;
    let id = Uuid::parse_str(item["roundId"].as_str().unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(60),async {
        loop {
            let state=f.ok("GET",&round_route(&item),"reader",None,Value::Null).await;
            if state["state"]=="completed" {break state;}
            sqlx::query("UPDATE learning_rollouts l SET status='scored',score=0,passed=false FROM learning_evaluations e WHERE e.round_id=$1 AND e.id=l.evaluation_id AND e.measurement='baseline-parent' AND l.status='queued'").bind(id).execute(&f.state.db).await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }).await.unwrap()
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
        sqlx::query(r#"WITH trial AS (
            INSERT INTO learning_trials(project_id,bundle_id,version_id,runtime,held_out)
            VALUES ($1,$2,$3,'{"taskModel":"task","judgeModel":"judge"}',true) RETURNING id)
            INSERT INTO learning_rollouts(trial_id,task_id,rollout,input,grader,status,score,passed,gateway_log,reasons)
            SELECT id,'held-out-sentinel',1,'null','{}','scored',1,true,'["private-trial-log"]','["private-trial-result","private-gateway-log","private-judge-reason"]' FROM trial"#)
            .bind(&f.project).bind(f.bundle).bind(f.version).execute(&f.state.db).await.unwrap();
        f.ok("GET", "/memory", "reader", None, Value::Null).await
    };
    assert_eq!(
        empty["improvementMemory"],
        json!({"memoryRevision":0,"schemaVersion":1,"problems":[]})
    );
    f.seed().await;
    sqlx::query(r#"UPDATE learning_tasks SET grader='{"type":"criteria","criteria":["Require evidence"]}' WHERE task_id='a'"#).execute(&f.state.db).await.unwrap();
    f.spawn_worker();
    let mut prior_digest = Value::Null;
    for n in 1..=2 {
        if n == 1 {
            incumbent(&f, n).await;
        }
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
        assert_ne!(round["adoptedVersionId"], round["parentVersionId"]);
        assert_eq!(round["incumbentReused"], n == 2);
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
        assert_eq!(
            attempt["fixed"],
            if n == 1 { json!(["a"]) } else { json!([]) }
        );
        assert_eq!(
            attempt["missed"],
            if n == 1 {
                json!(["b"])
            } else {
                json!(["a", "b"])
            }
        );
        assert_eq!(attempt["passed"], 5);
        assert_eq!(attempt["total"], 100);
        assert!(
            memory["records"][0]["provenance"]
                .get("heldOutDigest")
                .is_none()
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
    let usage = f.ok("GET", "/usage", "reader", None, Value::Null).await;
    let flag: String =
        sqlx::query_scalar("SELECT reason FROM learning_flagged_tasks(3) WHERE task_id='a'")
            .fetch_one(&f.state.db)
            .await
            .unwrap();
    assert_eq!(flag, "judge-disagreement");
    assert_eq!(usage["items"][0]["rollouts"], 1300);
    assert_eq!(usage["items"][0]["taskTokens"], 3900);
    assert_eq!(usage["items"][0]["judgeTokens"], 3900);
    let calls = server.requests.lock().unwrap();
    assert_eq!(calls.len(), 14);
    for offset in [0, 7] {
        assert!(
            calls[offset..offset + 5]
                .iter()
                .all(|data| *data == calls[offset])
        );
    }
    for (i, request) in calls.iter().enumerate() {
        if i < 7 {
            assert_eq!(
                request["feedback"]["cases"][0]["rollouts"][0]["reasons"],
                json!(["Evidence is incomplete."])
            );
            assert_eq!(
                request["feedback"]["cases"][0]["rollouts"][0]["gatewayLog"][0]["response"],
                "evolve trace"
            );
        }
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
        if number == 1 {
            incumbent(&f, number).await;
        }
        let page = f
            .wait_for("/rounds", "reader", |p| {
                p["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["number"] == number && r["state"] == "failed")
            })
            .await;
        let id = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["number"] == number)
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let round = f
            .ok("GET", &format!("/rounds/{id}"), "reader", None, Value::Null)
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
    evaluate(&f, &candidate, &[result("a", 1.0), result("b", 0.0)]).await;
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
async fn failed_survivor_is_skipped_and_failed_held_out_completes() {
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

    f.ok("POST", "/pause", "admin", None, Value::Null).await;
    sqlx::query(
        "UPDATE learning_rollouts SET status='failed',error_code='executor',attempts=2 WHERE evaluation_id=$1",
    )
    .bind(Uuid::parse_str(candidate["evaluationId"].as_str().unwrap()).unwrap())
    .execute(&f.state.db)
    .await
    .unwrap();
    let held = f.item("heldOut", 1).await;
    sqlx::query("UPDATE learning_rollouts SET status='failed',error_code='executor',attempts=2 WHERE evaluation_id=$1").bind(Uuid::parse_str(held["evaluationId"].as_str().unwrap()).unwrap()).execute(&f.state.db).await.unwrap();
    let round = f
        .wait_for(&round_route(&candidate), "reader", |r| {
            r["state"] == "completed"
        })
        .await;
    assert_eq!(round["heldOutError"], "held-out-evaluation-failed");
    assert!(f.ok("GET", "", "reader", None, Value::Null).await["alert"].is_null());
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
    // A scored Try with a recognizable task, answer and trace must stay out
    // of the entire optimizer request, including history and improvement memory.
    sqlx::query("WITH trial AS (INSERT INTO learning_trials(project_id,bundle_id,version_id,runtime,kind)
        VALUES($1,$2,$3,jsonb_build_object('taskModel','task','judgeModel','judge'),'try') RETURNING id)
        INSERT INTO learning_rollouts(trial_id,task_id,rollout,input,grader,status,score,passed,output,gateway_log)
        SELECT id,'trial-only-sentinel',1,'null','{}','scored',1,true,'trial-only-sentinel','[\"trial-only-sentinel\"]' FROM trial")
        .bind(&f.project).bind(f.bundle).bind(f.version).execute(&f.state.db).await.unwrap();
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
            channel,channel_revision,task_revision,memory_revision,setting,incumbent_score,held_out_error,ended_at)
            SELECT gen_random_uuid(),$1,$2,n,'completed','kept','no-candidates',$3,'stable',7,1,0,$4,0,'held-out-sentinel',now()
            FROM generate_series($5::int,$6::int) n")
            .bind(&f.project).bind(f.bundle).bind(f.version).bind(pin)
            .bind(first).bind(last).execute(&f.state.db).await.unwrap();
    }
    sqlx::query("INSERT INTO learning_candidates(round_id,sample,status,rationale,diagnosis,changes,scan)
        SELECT id,1,'generated',repeat('x',10000),'{\"problem\":{\"new\":\"Fixture\"},\"predicted\":[]}',
        '{\"edits\":[],\"files\":[]}', '{\"clean\":true,\"findings\":[]}'
        FROM learning_rounds WHERE bundle_id=$1")
        .bind(f.bundle).execute(&f.state.db).await.unwrap();
    sqlx::query("UPDATE learning_loops SET next_round=62,resumed_at=now(),max_rounds_per_day=65 WHERE bundle_id=$1")
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
    assert!(!requests[0].to_string().contains("trial-only-sentinel"));
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

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn held_out_drops_alert_and_only_confirmed_clear_drops_revert() {
    for clear in [false, true] {
        let mut f = Fixture::new().await;
        let _server=model(&mut f,|n,data|(StatusCode::OK,match n {
            5=>screen(data,true),
            11=>json!({"samples":data["candidates"].as_array().unwrap().iter().map(|c| json!({"sample":c["sample"],"reason":"Screened","verdict":if c["sample"]==1 {"evaluate"}else{"skip"}})).collect::<Vec<_>>()}),
            12=>json!({"decision":"adopt","sample":1,"reason":"Better evolve results"}),
            _=>proposal("Regression fixture candidate","Review lacks structure"),
        })).await;
        let mut settings = enrollment();
        f.provider().await;
        settings["maxRoundsPerDay"] = json!(2);
        f.ok("PUT", "", "admin", None, settings.clone()).await;
        f.seed().await;
        f.spawn_worker();
        incumbent(&f, 1).await;
        let held = f.item("heldOut", 1).await;
        let _admin = session(&f, "admin").await;
        sqlx::query("UPDATE users SET email='admin@example.test',email_verified=true WHERE id IN (SELECT user_id FROM project_memberships WHERE role='admin')").execute(&f.state.db).await.unwrap();
        let before = [
            result("held-out-sentinel-1", 1.0),
            result("held-out-sentinel-2", 1.0),
        ];
        evaluate(&f, &held, &before).await;
        let candidate = f.item("evolve", 2).await;
        assert_eq!(candidate["role"], "candidate");
        evaluate(&f, &candidate, &[result("a", 1.0), result("b", 1.0)]).await;
        let held = f.item("heldOut", 2).await;
        let score = if clear { 0.0 } else { 0.05 };
        let after = [
            result("held-out-sentinel-1", score),
            result("held-out-sentinel-2", if clear { 0.0 } else { 1.0 }),
        ];
        evaluate(&f, &held, &after).await;
        if clear {
            f.item("heldOut", 2).await;
            let count=sqlx::query("UPDATE learning_rollouts l SET status='scored',score=(e.measurement='confirm-parent')::int,passed=e.measurement='confirm-parent' FROM learning_evaluations e WHERE e.round_id=$1 AND e.id=l.evaluation_id AND e.measurement LIKE 'confirm-%' AND l.status='queued'").bind(Uuid::parse_str(held["roundId"].as_str().unwrap()).unwrap()).execute(&f.state.db).await.unwrap().rows_affected();
            assert_eq!(count, 200);
        }
        let state = f
            .wait_for("", "reader", |v| v["waiting"] == "daily-cap")
            .await;
        assert_eq!(state["status"], "running");
        assert_eq!(state["alert"]["score"], score);
        let delivery: Option<(f64, f64)> =
            sqlx::query_as("SELECT previous_score,score FROM learning_alert_deliveries")
                .fetch_optional(&f.state.db)
                .await
                .unwrap();
        assert_eq!(delivery, clear.then_some((0.1, score)));
        assert_eq!(state["alert"]["reverted"], clear);
        assert_eq!(state["rounds"][0]["decision"], "adopted");
        assert!(!state.to_string().contains("held-out-sentinel"));
        let head: Uuid = sqlx::query_scalar(
            "SELECT version_id FROM channels WHERE bundle_id=$1 AND name='stable'",
        )
        .bind(f.bundle)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
        assert_eq!(head == f.version, clear);
        if !clear {
            let request = json!({"roundId":held["roundId"],"note":"restore baseline"});
            let receipt = f
                .ok(
                    "POST",
                    "/rollback",
                    "admin",
                    Some("restore"),
                    request.clone(),
                )
                .await;
            assert!(receipt["alert"].is_null());
            assert_eq!(
                f.ok("POST", "/rollback", "admin", Some("restore"), request)
                    .await,
                receipt
            );
            let audits: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM mutation_audit WHERE path LIKE '%/learning/rollback'",
            )
            .fetch_one(&f.state.db)
            .await
            .unwrap();
            assert_eq!(audits, 1);
        }
        let stale = f
            .req(
                "POST",
                "/rollback",
                "admin",
                None,
                json!({"roundId":held["roundId"]}),
            )
            .await;
        assert_eq!(stale.0, 409);
        let blocked = f
            .ok("GET", "/blocked-versions", "reader", None, Value::Null)
            .await;
        assert_eq!(blocked.as_array().unwrap().len(), 1);
        settings["maxRoundsPerDay"] = json!(3);
        f.ok("PUT", "", "admin", None, settings).await;
        let third = f
            .wait_for("/rounds", "reader", |p| {
                p["items"][0]["number"] == 3 && p["items"][0]["decision"] == "kept"
            })
            .await;
        let detail = f
            .ok(
                "GET",
                &format!("/rounds/{}", third["items"][0]["id"].as_str().unwrap()),
                "reader",
                None,
                Value::Null,
            )
            .await;
        assert_eq!(detail["trigger"], "adoption");
        assert!(
            detail["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["dropReason"] == "blocked-version")
        );
        assert!(!detail.to_string().contains("held-out-sentinel"));
        let usage = f.ok("GET", "/usage", "reader", None, Value::Null).await;
        assert_eq!(usage["items"][0]["optimizerTokens"], 18 * 17);
        let unblock = format!(
            "/blocked-versions/{}",
            blocked[0]["digest"].as_str().unwrap()
        );
        assert_eq!(
            f.req("DELETE", &unblock, "admin", None, Value::Null)
                .await
                .0,
            204
        );
        assert_eq!(
            f.ok("GET", "/blocked-versions", "reader", None, Value::Null)
                .await,
            json!([])
        );
    }
}

async fn monitor_scenario(scenario: &str) {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    let child = Uuid::new_v4();
    sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) SELECT $1,project_id,bundle_id,$2,payload,'fixture' FROM versions WHERE id=$3")
        .bind(child).bind("ab".repeat(32)).bind(f.version).execute(&f.state.db).await.unwrap();
    let round = Uuid::new_v4();
    let kept = scenario == "kept";
    let prior = scenario != "first";
    if prior {
        sqlx::query("WITH prev AS (INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,decision,reason,parent_version_id,channel,channel_revision,task_revision,memory_revision,setting,runtime,incumbent_score,held_out_score,ended_at) VALUES(gen_random_uuid(),$1,$2,1,'completed','kept','no-candidates',$3,'stable',7,$4,0,'{}',$5,1,1,now()) RETURNING id)
            INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,status,started_at,score) SELECT gen_random_uuid(),prev.id,'retained','held_out',v.id,v.digest,'scored',now(),1 FROM prev,versions v WHERE v.id=$6")
            .bind(&f.project).bind(f.bundle).bind(f.version).bind(if scenario=="revision"{0_i64}else{1}).bind(if scenario=="runtime"{json!({"taskModel":"task","judgeModel":"old"})}else{json!({"taskModel":"task","judgeModel":"judge"})}).bind(if matches!(scenario,"revision"|"runtime"|"confirm"){f.version}else{child}).execute(&f.state.db).await.unwrap();
    }
    sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,channel_revision,task_revision,memory_revision,setting,runtime,incumbent_score) VALUES($1,$2,$3,$4,'selecting',$5,'stable',7,1,0,'{}',$6,1)")
        .bind(round).bind(&f.project).bind(f.bundle).bind(if prior{2}else{1}).bind(f.version).bind(json!({"taskModel":"task","judgeModel":"judge"})).execute(&f.state.db).await.unwrap();
    sqlx::query("INSERT INTO learning_candidates(round_id,sample) VALUES($1,1)")
        .bind(round)
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE learning_rounds SET state='scoring_held_out',decision=$2,adopted_sample=$3,adopted_version_id=$4,reason=$5,selection='{}' WHERE id=$1")
        .bind(round).bind(if kept{"kept"}else{"adopted"}).bind((!kept).then_some(1_i16)).bind((!kept).then_some(child)).bind(kept.then_some("no-candidates")).execute(&f.state.db).await.unwrap();
    if !kept {
        sqlx::query("UPDATE channels SET version_id=$1,revision=8 WHERE name='stable'")
            .bind(child)
            .execute(&f.state.db)
            .await
            .unwrap();
    }
    let cases = |passed| json!({"cases":[result("held-out-sentinel-1",passed),result("held-out-sentinel-2",passed)]});
    sqlx::query("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,status,started_at,score,report) SELECT gen_random_uuid(),$1,'retained','held_out',id,digest,'scored',now(),0,$3 FROM versions WHERE id=$2")
        .bind(round).bind(if kept{f.version}else{child}).bind(cases(0.0)).execute(&f.state.db).await.unwrap();
    if matches!(scenario, "initial-failed" | "persistent-failure") {
        session(&f, "admin").await;
        sqlx::query("UPDATE users SET email='admin@example.test',email_verified=true WHERE issuer='https://fixture.example'").execute(&f.state.db).await.unwrap();
    }
    if scenario == "initial-failed" {
        sqlx::query("UPDATE learning_evaluations SET status='failed',error='rollout-failed',score=NULL WHERE round_id=$1").bind(round).execute(&f.state.db).await.unwrap();
    }
    if scenario == "confirm" {
        sqlx::query("UPDATE learning_evaluations SET report=$1 WHERE round_id<>$2")
            .bind(cases(1.0))
            .bind(round)
            .execute(&f.state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,measurement,status,error) SELECT gen_random_uuid(),$1,'retained','held_out',id,digest,'confirm-parent','failed','rollout-failed' FROM versions WHERE id=$2")
            .bind(round).bind(f.version).execute(&f.state.db).await.unwrap();
        sqlx::query("INSERT INTO learning_rollouts(evaluation_id,task_id,rollout,input,grader,status,error_code,attempts) SELECT id,'held-out-sentinel-'||n,k,'1','{}','failed','executor',2 FROM learning_evaluations CROSS JOIN generate_series(1,2) n CROSS JOIN generate_series(1,5) k WHERE round_id=$1 AND measurement='confirm-parent'").bind(round).execute(&f.state.db).await.unwrap();
    }
    sqlx::query("UPDATE learning_loops SET status='paused',pause_reason='operator'")
        .execute(&f.state.db)
        .await
        .unwrap();
    f.spawn_worker();
    let route = format!("/rounds/{round}");
    if matches!(scenario, "initial-failed" | "persistent-failure") {
        tokio::time::timeout(Duration::from_secs(12),async {
            loop {
                sqlx::query("UPDATE learning_rollouts l SET status='failed',error_code='executor' FROM learning_evaluations e WHERE l.evaluation_id=e.id AND e.round_id=$1 AND e.measurement='baseline-parent' AND l.status='queued'").bind(round).execute(&f.state.db).await.unwrap();
                let state=f.ok("GET",&route,"reader",None,Value::Null).await;
                if state["state"]=="completed" {assert!(state["heldOutError"].is_string());assert_eq!(state["reverted"],false);break;}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.unwrap();
        let state = f.ok("GET", "", "reader", None, Value::Null).await;
        assert_eq!(state["status"], "paused");
        assert_eq!(
            state["alert"],
            json!({"kind":"regression-check-incomplete","roundId":round,"versionId":child})
        );
        let emails: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM learning_alert_deliveries WHERE round_id=$1 AND score IS NULL",
        )
        .bind(round)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
        assert_eq!(emails, 1);
        return;
    }
    let state=tokio::time::timeout(Duration::from_secs(10),async {
        loop {
            let state=f.ok("GET",&route,"reader",None,Value::Null).await;
            let running:bool=sqlx::query_scalar("SELECT EXISTS(SELECT FROM learning_evaluations WHERE round_id=$1 AND version_id=$2 AND status='running')").bind(round).bind(f.version).fetch_one(&f.state.db).await.unwrap();
            if state["state"]!="scoring_held_out" || running {break state;}
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }).await.unwrap();
    if kept {
        assert_eq!(state["state"], "completed");
        assert!(f.ok("GET", "", "reader", None, Value::Null).await["alert"].is_null());
    } else {
        assert_eq!(state["state"], "scoring_held_out");
        let completed=tokio::time::timeout(Duration::from_secs(12),async {
            loop {
                sqlx::query("UPDATE learning_rollouts l SET status='scored',passed=e.version_id=$2,score=(e.version_id=$2)::int FROM learning_evaluations e WHERE e.round_id=$1 AND l.evaluation_id=e.id AND l.status='queued'").bind(round).bind(f.version).execute(&f.state.db).await.unwrap();
                let r=f.ok("GET",&route,"reader",None,Value::Null).await;
                if r["state"]=="completed" {break r;}
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }).await.unwrap();
        assert_eq!(completed["reverted"], true);
        assert_eq!(completed["confirmedParentScore"], 1.0);
        assert_eq!(completed["confirmedAdoptionScore"], 0.0);
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn monitor_first() {
    monitor_scenario("first").await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn monitor_revision() {
    monitor_scenario("revision").await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn monitor_runtime() {
    monitor_scenario("runtime").await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn monitor_restored() {
    monitor_scenario("restored").await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn monitor_kept() {
    monitor_scenario("kept").await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn monitor_confirm() {
    monitor_scenario("confirm").await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn prompt_size_at_task_floor() {
    let mut f = Fixture::new().await;
    let server = model(&mut f, |_, _| {
        (StatusCode::OK, proposal("Small edit", "Repeated error"))
    })
    .await;
    f.enroll().await;
    f.seed().await;
    let system = "x".repeat(50 * 1024);
    let payload = json!({"schemaVersion":1,"files":[{"path":"AGENTS.md","kind":"instruction","text":system}]});
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,'fixture')").bind(version).bind(&f.project).bind(f.bundle).bind("bc".repeat(32)).bind(payload.to_string().as_bytes()).execute(&f.state.db).await.unwrap();
    sqlx::query("UPDATE channels SET version_id=$1,revision=revision+1 WHERE name='stable'")
        .bind(version)
        .execute(&f.state.db)
        .await
        .unwrap();
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    let log = json!([{"request":{"messages":[{"role":"system","content":system},{"role":"user","content":"fixture"}]}}]);
    sqlx::query("UPDATE learning_rollouts SET gateway_log=$1,status='scored',score=0,passed=false WHERE evaluation_id=$2").bind(log).bind(Uuid::parse_str(item["evaluationId"].as_str().unwrap()).unwrap()).execute(&f.state.db).await.unwrap();
    f.wait_for(&round_route(&item), "reader", |_| {
        server
            .prompt_bytes
            .load(std::sync::atomic::Ordering::Relaxed)
            > 0
    })
    .await;
    let measured = server
        .prompt_bytes
        .load(std::sync::atomic::Ordering::Relaxed);
    eprintln!("Optimizer message content bytes: {measured}");
    assert!(measured < 100 * 1024);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn incomplete_regression_checks_end_and_alert() {
    monitor_scenario("initial-failed").await;
    monitor_scenario("persistent-failure").await;
}
