use super::*;
use acclimate_service::executor;

pub(super) async fn post(app: &axum::Router, path: &str, token: &str, body: Value) -> (u16, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/internal/executor/leases{path}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 2_097_152).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
pub(super) async fn act(
    app: &axum::Router,
    lease: &Value,
    action: &str,
    body: Value,
) -> (u16, Value) {
    post(
        app,
        &format!("/{}/{action}", lease["leaseId"].as_str().unwrap()),
        lease["leaseToken"].as_str().unwrap(),
        body,
    )
    .await
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn executor_leases_recover_and_keep_secrets_out_of_storage() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    f.crash_worker().await;
    let pool = &f.state.db;
    let eval: Uuid = item["evaluationId"].as_str().unwrap().parse().unwrap();
    let identity = json!({"build":"fixture","harnesses":{"chat":"1"},"sandboxRuntime":"docker","runnerImage":"fixture-image"});
    let acquire = json!({"executor":identity});
    let endpoint = "https://provider.invalid/v1";
    let secret = "private-fixture-provider-key";
    let key = executor::ProviderKey::from_hex(&"01".repeat(32)).unwrap();
    key.store(
        pool,
        &f.project,
        endpoint,
        &["task".into(), "judge".into()],
        secret,
    )
    .await
    .unwrap();
    let app = executor::router(pool.clone(), Some(key), f.state.runtime.clone());
    let (id, token) = executor::create_credential(pool).await.unwrap();
    assert_eq!(post(&f.app, "", &token, acquire.clone()).await.0, 404);
    assert_eq!(
        post(&app, "", &token, json!({"executor":{"build":"wrong","harnesses":{"chat":"1"},"sandboxRuntime":"docker","runnerImage":"fixture-image"}}))
            .await
            .0,
        204
    );
    let (status, first) = post(&app, "", &token, acquire.clone()).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["provider"]["apiKey"], secret);
    assert!(first.get("grader").is_none() && first.get("expected").is_none());
    assert_eq!(act(&app, &first, "heartbeat", json!({})).await.0, 200);
    let other = post(&app, "", &token, acquire.clone()).await.1;
    let mut wrong = other.clone();
    wrong["leaseToken"] = first["leaseToken"].clone();
    assert_eq!(act(&app, &wrong, "heartbeat", json!({})).await.0, 409);
    sqlx::query("UPDATE learning_rollouts SET lease_expires_at=now() WHERE id=$1")
        .bind(
            first["rolloutId"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        )
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(act(&app, &first, "heartbeat", json!({})).await.0, 409);
    let retry = post(&app, "", &token, acquire.clone()).await.1;
    assert_eq!(retry["rolloutId"], first["rolloutId"]);
    assert_ne!(retry["leaseToken"], first["leaseToken"]);
    let (status, grade) = act(
        &app,
        &retry,
        "output",
        json!({"output":"reply","stop":"completed","gatewayLog":[]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(grade["grader"], json!({"type":"exact","expected":null}));
    let counts = json!({"input":1,"output":2});
    let verdict = json!({"verdict":{"passed":true,"score":1,"reasons":[]},"judgeLog":[],"tokens":{"task":counts,"judge":counts}});
    assert_eq!(act(&app, &retry, "result", verdict).await.0, 204);
    let error = json!({"error":{"code":"sandbox-start","message":"fixture"}});
    assert_eq!(act(&app, &other, "result", error.clone()).await.0, 204);
    let last = post(&app, "", &token, acquire.clone()).await.1;
    assert_eq!(last["rolloutId"], other["rolloutId"]);
    assert_eq!(act(&app, &last, "result", error).await.0, 204);

    let failed:bool= sqlx::query_scalar("SELECT attempts=2 AND score IS NULL AND passed IS NULL AND error_code='sandbox-start' FROM learning_rollouts WHERE status='failed'")
        .fetch_one(pool).await.unwrap();
    assert!(failed);
    let trial_rollout: Uuid = sqlx::query_scalar(
        "WITH trial AS (INSERT INTO learning_trials(project_id,bundle_id,version_id,runtime)
         SELECT r.project_id,r.bundle_id,e.version_id,r.runtime FROM learning_evaluations e
         JOIN learning_rounds r ON r.id=e.round_id WHERE e.id=$1 RETURNING id)
         INSERT INTO learning_rollouts(trial_id,task_id,rollout,input,grader)
         SELECT id,'trial',1,'null','{}' FROM trial RETURNING id",
    )
    .bind(eval)
    .fetch_one(pool)
    .await
    .unwrap();
    let trial = post(&app, "", &token, acquire.clone()).await.1;
    assert_eq!(trial["rolloutId"], json!(trial_rollout));
    executor::revoke_credential(pool, id).await.unwrap();
    assert_eq!(post(&app, "", &token, acquire).await.0, 401);
    let leaks:bool= sqlx::query_scalar("SELECT EXISTS(SELECT FROM workspace_model_providers WHERE position($1::bytea in encrypted_key)>0) OR EXISTS(SELECT FROM learning_rollouts l WHERE strpos(to_jsonb(l)::text,$2)>0) OR EXISTS(SELECT FROM mutation_audit a WHERE strpos(to_jsonb(a)::text,$2)>0)")
        .bind(secret.as_bytes())
        .bind(secret)
        .fetch_one(pool).await.unwrap();
    assert!(!leaks);
    let entries: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mutation_audit WHERE service_principal=$1")
            .bind(format!("executor:{id}"))
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(entries, 8);
}

/// Fixture bridge for the real-process Docker gate. Runs in its disposable cluster.
#[tokio::test]
#[ignore = "run python3 executor/tests/central_learning.py"]
async fn combined_gate_fixture() {
    let Ok(path) = std::env::var("ACCLIMATE_GATE_FIXTURE") else {
        return;
    };
    if let Ok(config) = std::env::var("ACCLIMATE_GATE_TRIALS") {
        use executor::trials::*;
        let config: Value = serde_json::from_str(&config).unwrap();
        let pool = sqlx::PgPool::connect(&common::database_url())
            .await
            .unwrap();
        let bundle = config["bundle"].as_str().unwrap().parse().unwrap();
        let project = config["workspace"].as_str().unwrap();
        let mut results = Vec::new();
        if let Some(ids) = config["ids"].as_array() {
            for id in ids {
                results.push(
                    read_trial(
                        &pool,
                        project,
                        bundle,
                        id.as_str().unwrap().parse().unwrap(),
                    )
                    .await
                    .unwrap(),
                );
            }
        } else {
            let runtime: Value =
                serde_json::from_str(&std::env::var("ACCLIMATE_GATE_RUNTIME").unwrap()).unwrap();
            let target = TrialTarget {
                project,
                bundle,
                version: config["version"].as_str().unwrap().parse().unwrap(),
                runtime: &runtime,
            };
            let mut tx = pool.begin().await.unwrap();
            for criterion in [
                "admitted",
                "reference-failed",
                "empty-passed",
                "judge-unstable",
                "no-reference",
                "no-reference-split",
            ] {
                let mut g = json!({"type":"criteria","criteria":[criterion]});
                if !criterion.starts_with("no-reference") {
                    g["reference"] = json!("answer")
                }
                results.push(json!(
                    run_admission(&mut tx, &target, &json!("input"), &g)
                        .await
                        .unwrap()
                ));
            }
            results.push(json!(queue_conversion(&mut tx,&target,&json!({"format":"rows","rows":[{"row":1,"source":"sheet#1","question":"Question","answer":"Answer"},{"row":2,"source":"sheet#2","question":"Missing answer"}]})).await.unwrap()));
            tx.commit().await.unwrap();
        }
        std::fs::write(path, json!(results).to_string()).unwrap();
        return;
    }
    let f = Fixture::new().await;
    f.enroll().await;
    let answer = std::env::var("ACCLIMATE_GATE_ANSWER").unwrap();
    let runtime: Value =
        serde_json::from_str(&std::env::var("ACCLIMATE_GATE_RUNTIME").unwrap()).unwrap();
    let round = Uuid::new_v4();
    let id = Uuid::new_v4();
    let mut tx = f.state.db.begin().await.unwrap();
    sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,channel_revision,evolve_revision,memory_revision,setting,runtime,task_revision) VALUES($1,$2,$3,1,'scoring_incumbent',$4,'stable',7,1,0,'{}',$5,1)").bind(round).bind(&f.project).bind(f.bundle).bind(f.version).bind(runtime).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,evolve_revision) VALUES($1,$2,'incumbent','evolve',$3,$4,1)").bind(id).bind(round).bind(f.version).bind(DIGEST).execute(&mut *tx).await.unwrap();
    for task in ["a", "b"] {
        sqlx::query(r#"INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,added_revision,admission) VALUES($1,$2,$3,$3,to_jsonb($3::text),$4,'console',1,'admitted')"#)
            .bind(&f.project).bind(f.bundle).bind(task).bind(json!({"type":"exact","expected":answer})).execute(&mut *tx).await.unwrap();
    }
    executor::queue_evaluation(&mut tx, id).await.unwrap();
    tx.commit().await.unwrap();
    let schema: String = sqlx::query_scalar("SELECT current_schema()")
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    let browser = session(&f, "admin").await;
    std::fs::write(
        path,
        json!({"session":browser,"schema":schema,"evaluation":id,"workspace":f.project,"bundle":f.bundle,"version":f.version}).to_string(),
    )
    .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn trial_leases_resolve_admission_and_validate_material() {
    use executor::trials::*;
    let f = Fixture::new().await;
    f.state.runtime.ownership_acquired();
    let pool = &f.state.db;
    let identity = json!({"build":"test","sandboxRuntime":"docker","harnesses":{"chat":"1"},"runnerImage":"image"});
    let endpoint = "https://model.invalid/v1";
    let runtime =
        json!({"executor":identity,"taskModel":"task","judgeModel":"judge","baseUrl":endpoint});
    let key = executor::ProviderKey::from_hex(&"ab".repeat(32)).unwrap();
    key.store(
        pool,
        &f.project,
        endpoint,
        &["task".into(), "judge".into()],
        "hidden",
    )
    .await
    .unwrap();
    let app = executor::router(pool.clone(), Some(key), f.state.runtime.clone());
    let (_, token) = executor::create_credential(pool).await.unwrap();
    let target = TrialTarget {
        project: &f.project,
        bundle: f.bundle,
        version: f.version,
        runtime: &runtime,
    };
    let mut tx = pool.begin().await.unwrap();
    let grader = json!({"type":"exact","expected":"answer"});
    let attempt = start_try(&mut tx, &target, "trial-task", &json!("question"), &grader)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let lease = post(&app, "", &token, json!({"executor":identity})).await.1;
    assert_eq!(lease["kind"], "rollout");
    assert!(lease.get("grader").is_none());
    let output = act(
        &app,
        &lease,
        "output",
        json!({"output":"answer","stop":"completed","gatewayLog":[]}),
    )
    .await;
    assert_eq!(output.1["grader"], grader);
    let counts = json!({"input":0,"output":0});
    assert_eq!(act(&app,&lease,"result",json!({"verdict":{"passed":true,"score":1,"reasons":[]},"judgeLog":[],"tokens":{"task":counts,"judge":counts}})).await.0,204);
    let result = read_trial(pool, &f.project, f.bundle, attempt)
        .await
        .unwrap();
    assert_eq!(result["output"], "answer");
    assert_eq!(result["verdict"]["passed"], true);
    f.ok("PUT", "", "admin", None, enrollment()).await;
    let browser = format!("console/{}", session(&f, "admin").await);
    sqlx::query("UPDATE learning_loops SET task_model='task',judge_model='judge'")
        .execute(pool)
        .await
        .unwrap();
    for outcome in [
        "admitted",
        "empty-passed",
        "reference-failed",
        "judge-unstable",
        "pending",
    ] {
        let grader = json!({"type":"criteria","criteria":["Meets requirement"],"reference":"ref"});
        let card = f
            .ok(
                "POST",
                "/tasks",
                &browser,
                None,
                json!({"input":outcome,"grader":grader}),
            )
            .await;
        for _ in 0..if outcome == "pending" { 4 } else { 2 } {
            let (status, lease) = post(&app, "", &token, json!({"executor":identity})).await;
            assert_eq!(status, 200, "{lease}");
            assert_eq!(lease["kind"], "grade");
            assert_eq!(lease["judgeRuns"], 3);
            for field in ["bundle", "input", "harness"] {
                assert!(lease.get(field).is_none())
            }
            let passed = if lease["output"] == "ref" {
                outcome != "reference-failed"
            } else {
                outcome == "empty-passed"
            };
            let report = if outcome == "pending" {
                json!({"error":{"code":"executor","message":"malformed"}})
            } else {
                let counts = json!({"input":0,"output":0});
                json!({"verdict":{"passed":passed,"score":u8::from(passed),"reasons":["Reason"],"votes":[passed,passed,passed && outcome!="judge-unstable"]},"judgeLog":[],"tokens":{"task":counts,"judge":counts}})
            };
            assert_eq!(act(&app, &lease, "result", report).await.0, 204);
        }
        let page = f.ok("GET", "/tasks", &browser, None, Value::Null).await;
        let checked = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["taskId"] == card["taskId"])
            .unwrap();
        if matches!(outcome, "admitted" | "pending") {
            assert_eq!(checked["admission"], outcome);
        } else {
            assert_eq!(checked["admissionReason"], outcome);
            assert_eq!(checked["admission"], "set-aside");
        }
    }
    let mut tx = pool.begin().await.unwrap();
    let material = json!({"format":"rows","rows":[{"row":4,"source":"sheet#4","q":"Hi"}]});
    let id = queue_conversion(&mut tx, &target, &material).await.unwrap();
    tx.commit().await.unwrap();
    let lease = post(&app, "", &token, json!({"executor":identity})).await.1;
    assert_eq!(lease["kind"], "conversion");
    assert_eq!(lease["material"], material);
    let mut report = json!({"cards":[{"row":8,"group":"sheet#4","input":"Hi","grader":{"type":"exact","expected":"x"},"criteriaDrafted":false}],"setAside":[],"judgeLog":[],"tokens":{"judge":{"input":10,"output":5}}});
    assert_eq!(act(&app, &lease, "result", report.clone()).await.0, 400);
    report["cards"][0]["row"] = json!(4);
    assert_eq!(act(&app, &lease, "result", report.clone()).await.0, 204);
    assert_eq!(
        read_trial(pool, &f.project, f.bundle, id).await.unwrap()["cards"],
        report["cards"]
    );
    let receipt = f
        .ok(
            "POST",
            "/tasks/import?filename=materials.jsonl",
            "writer",
            None,
            json!({"question":"Hi","answer":"x"}),
        )
        .await;
    assert_eq!(receipt["pending"], 1);
    let path = format!("/tasks/imports/{}", receipt["importId"].as_str().unwrap());
    let lease = post(&app, "", &token, json!({"executor":identity})).await.1;
    let row = &lease["material"]["rows"][0];
    assert_eq!(row["material"]["answer"], "x");
    report["cards"][0]["row"] = row["row"].clone();
    report["cards"][0]["group"] = row["source"].clone();
    assert_eq!(act(&app, &lease, "result", report).await.0, 204);
    let status = f.ok("GET", &path, "reader", None, Value::Null).await;
    assert_eq!(
        (status["status"].as_str(), status["converted"].as_i64()),
        (Some("completed"), Some(1))
    );
    for _ in 0..2 {
        let lease = post(&app, "", &token, json!({"executor":identity})).await.1;
        assert_eq!(lease["kind"], "grade");
        let pass = lease["output"] == "x";
        assert_eq!(act(&app,&lease,"result",json!({"verdict":{"passed":pass,"score":u8::from(pass),"reasons":[]},"judgeLog":[],"tokens":{"task":counts,"judge":counts}})).await.0,204);
    }
    let cards = f
        .ok("GET", "/tasks?source=import", &browser, None, Value::Null)
        .await;
    assert_eq!(cards["items"][0]["admission"], "admitted");

    // A terminal infrastructure failure has no verdict. Once its cooldown expires,
    // the next poll creates a fresh admission trial for the same live revision.
    sqlx::query("UPDATE learning_rollouts SET lease_expires_at=now()-interval '2 minutes' WHERE status='failed'")
        .execute(pool).await.unwrap();
    for _ in 0..2 {
        let lease = post(&app, "", &token, json!({"executor":identity})).await.1;
        assert_eq!(lease["kind"], "grade");
        let pass = lease["output"] == "ref";
        let verdict = json!({"passed":pass,"score":u8::from(pass),"votes":[pass,pass,pass],"reasons":["Reason"]});
        assert_eq!(
            act(
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
    let page = f.ok("GET", "/tasks", &browser, None, Value::Null).await;
    let retried = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|card| card["input"] == "pending")
        .unwrap();
    assert_eq!(retried["admission"], "admitted");
}
