use super::*;
use acclimate_service::executor;

async fn post(app: &axum::Router, path: &str, token: &str, body: Value) -> (u16, Value) {
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
async fn act(app: &axum::Router, lease: &Value, action: &str, body: Value) -> (u16, Value) {
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
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE learning_rounds SET runtime=$1 WHERE id=(SELECT round_id FROM learning_evaluations WHERE id=$2)")
        .bind(json!({"executor":identity,"taskModel":"task","judgeModel":"judge","baseUrl":endpoint}))
        .bind(eval)
        .execute(&mut *tx).await.unwrap();
    assert_eq!(executor::queue_evaluation(&mut tx, eval).await.unwrap(), 10);
    tx.commit().await.unwrap();
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
    assert_eq!(
        executor::assemble(pool, eval).await.unwrap(),
        json!({"status":"failed"})
    );
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

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn evaluation_assembly_uses_all_five_scores_per_task() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    f.crash_worker().await;
    let pool = &f.state.db;
    let evaluation = item["evaluationId"].as_str().unwrap().parse().unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE learning_rounds SET runtime='{}' WHERE id=(SELECT round_id FROM learning_evaluations WHERE id=$1)")
        .bind(evaluation).execute(&mut *tx).await.unwrap();
    executor::queue_evaluation(&mut tx, evaluation)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        executor::assemble(pool, evaluation).await.unwrap()["status"],
        "pending"
    );
    sqlx::query(
        "UPDATE learning_rollouts SET status='scored',
        score=CASE WHEN task_id='a' THEN 0.8 ELSE 0.4 END,
        passed=rollout<=CASE WHEN task_id='a' THEN 3 ELSE 2 END WHERE evaluation_id=$1",
    )
    .bind(evaluation)
    .execute(pool)
    .await
    .unwrap();
    let result = executor::assemble(pool, evaluation).await.unwrap();
    assert_eq!(result["status"], "scored");
    assert!((result["score"].as_f64().unwrap() - 0.6).abs() < 1e-9);
    assert_eq!(
        result["tasks"][0],
        json!({"taskId":"a","passed":true,"score":0.8})
    );
    assert_eq!(
        result["tasks"][1],
        json!({"taskId":"b","passed":false,"score":0.4})
    );
}
