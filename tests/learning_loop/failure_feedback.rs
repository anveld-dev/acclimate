use super::*;

/// Fails the next queued rollout on both of its attempts with this error.
async fn fail_rollout(f: &Fixture, code: &str, message: &str) {
    let internal = f.internal();
    let mut first = Value::Null;
    for attempt in 1..=2 {
        let (status, lease) = executor_tests::post(
            &internal,
            "",
            &f.token,
            json!({"executor":Fixture::identity()}),
        )
        .await;
        assert_eq!(status, 200, "{lease}");
        if attempt == 1 {
            first = lease["rolloutId"].clone();
        } else {
            assert_eq!(first, lease["rolloutId"]);
        }
        let reply = executor_tests::act(
            &internal,
            &lease,
            "result",
            json!({"error":{"code":code,"message":message}}),
        )
        .await;
        assert_eq!(reply.0, 204, "{}", reply.1);
    }
}

async fn failed_rounds(f: &Fixture) -> i32 {
    sqlx::query_scalar("SELECT failed_rounds FROM learning_loops")
        .fetch_one(&f.state.db)
        .await
        .unwrap()
}

fn timestamp(value: &Value) -> chrono::DateTime<chrono::Utc> {
    value.as_str().unwrap().parse().unwrap()
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn failed_round_reports_the_first_failed_rollout() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    // The executor redacts secrets. The service bounds what it keeps.
    let message = format!(
        "sandbox runtime refused the container: {}",
        "x".repeat(1000)
    );
    fail_rollout(&f, "sandbox-start", &message).await;
    let round = f
        .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await;
    assert_eq!(round["reason"], "incumbent-evaluation-failed");
    assert_eq!(round["failureCause"]["code"], "sandbox-start");
    let reported = round["failureCause"]["message"].as_str().unwrap();
    assert_eq!(reported.chars().count(), 500);
    assert!(message.starts_with(reported));
    let state = f.ok("GET", "", "reader", None, Value::Null).await;
    assert_eq!(state["rounds"][0]["failureCause"]["code"], "sandbox-start");
    assert_eq!(failed_rounds(&f).await, 1);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn held_out_failure_reports_its_code_only() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let evolve = f.item("evolve", 1).await;
    optimizer::evaluate(&f, &evolve, &[]).await;
    f.item("heldOut", 1).await;
    fail_rollout(
        &f,
        "judge-invalid-reply",
        "judge quoted held-out-private-text",
    )
    .await;
    let round = f
        .wait_for(&round_route(&evolve), "reader", |r| {
            r["state"] == "completed"
        })
        .await;
    assert_eq!(round["heldOutError"], "held-out-evaluation-failed");
    assert_eq!(
        round["failureCause"],
        json!({"code":"judge-invalid-reply","message":null})
    );
    let stored: Option<String> = sqlx::query_scalar("SELECT failure_message FROM learning_rounds")
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(stored, None);
    for caller in ["reader", "app"] {
        let loop_state = f.ok("GET", "", caller, None, Value::Null).await;
        let detail = f
            .ok("GET", &round_route(&evolve), caller, None, Value::Null)
            .await;
        for document in [loop_state, detail] {
            assert!(!document.to_string().contains("held-out-private-text"));
        }
    }
}

async fn round_count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM learning_rounds")
        .fetch_one(&f.state.db)
        .await
        .unwrap()
}

/// Fails round `number` with `code`, and returns the round once it has failed.
async fn fail_round(f: &Fixture, number: i32, code: &str) -> Value {
    let item = f.item("evolve", number).await;
    fail_rollout(f, code, "provider failed after retries").await;
    f.wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await
}

/// Checks that the loop waits out the provider for `minutes` after `round`, starting no round
/// in the meantime, then moves the round's end back past the wait.
async fn wait_out(f: &Fixture, round: &Value, minutes: i64) {
    assert_eq!(round["reason"], "provider-unavailable");
    let state = f
        .wait_for("", "reader", |r| r["waiting"] == "provider-unavailable")
        .await;
    assert_eq!(
        (&state["status"], &state["pauseReason"]),
        (&json!("running"), &Value::Null)
    );
    assert_eq!(
        timestamp(&state["nextRoundAt"]),
        timestamp(&round["endedAt"]) + chrono::Duration::minutes(minutes)
    );
    // The worker ticks every 500 ms, so this covers several ticks without a new round.
    let rounds = round_count(f).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(round_count(f).await, rounds);
    sqlx::query(
        "UPDATE learning_rounds SET ended_at=ended_at-make_interval(mins=>$2) WHERE number=$1",
    )
    .bind(round["number"].as_i64().unwrap() as i32)
    .bind(minutes as i32 + 1)
    .execute(&f.state.db)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn provider_outage_backs_off_without_counting_toward_the_pause_or_the_cap() {
    let mut f = Fixture::new().await;
    f.provider().await;
    // Two rounds a day: the outage rounds below would fill that cap if they counted.
    let mut input = enrollment();
    input["maxRoundsPerDay"] = json!(2);
    f.ok("PUT", "", "admin", None, input).await;
    f.seed().await;
    sqlx::query("UPDATE learning_loops SET failed_rounds=1")
        .execute(&f.state.db)
        .await
        .unwrap();
    f.spawn_worker();
    // Each consecutive outage doubles the wait.
    for (number, minutes) in [(1, 10), (2, 20), (3, 40)] {
        let round = fail_round(&f, number, "gateway-upstream").await;
        assert_eq!(round["failureCause"]["code"], "gateway-upstream");
        assert_eq!(failed_rounds(&f).await, 1);
        wait_out(&f, &round, minutes).await;
    }
    let round = fail_round(&f, 4, "gateway-upstream").await;
    assert_eq!(round["trigger"], "retry");
    let waiting = f
        .wait_for("", "reader", |r| r["waiting"] == "provider-unavailable")
        .await;
    assert_eq!(
        timestamp(&waiting["nextRoundAt"]),
        timestamp(&round["endedAt"]) + chrono::Duration::minutes(80)
    );
    // Start during the wait asks for a round now, and resets the backoff.
    let started = f.ok("POST", "/start", "admin", None, Value::Null).await;
    assert_eq!(started["waiting"], Value::Null);
    let round = fail_round(&f, 5, "gateway-upstream").await;
    assert_eq!(round["trigger"], "resume");
    wait_out(&f, &round, 10).await;
    let round = fail_round(&f, 6, "gateway-upstream").await;
    wait_out(&f, &round, 20).await;
    // A round that fails otherwise counts, and resets the backoff.
    let round = fail_round(&f, 7, "sandbox-start").await;
    assert_eq!(round["reason"], "incumbent-evaluation-failed");
    assert_eq!(failed_rounds(&f).await, 2);
    let round = fail_round(&f, 8, "gateway-upstream").await;
    assert_eq!(round["trigger"], "retry");
    wait_out(&f, &round, 10).await;
    assert_eq!(failed_rounds(&f).await, 2);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn a_rejected_provider_request_counts_toward_the_pause() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    sqlx::query("UPDATE learning_loops SET failed_rounds=2")
        .execute(&f.state.db)
        .await
        .unwrap();
    f.spawn_worker();
    let round = fail_round(&f, 1, "provider-rejected").await;
    assert_eq!(round["reason"], "incumbent-evaluation-failed");
    assert_eq!(round["failureCause"]["code"], "provider-rejected");
    let state = f.wait_for("", "reader", |r| r["status"] == "paused").await;
    assert_eq!(state["pauseReason"], "failed-rounds");
    assert_eq!(failed_rounds(&f).await, 3);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn a_round_with_mixed_failure_codes_is_not_an_outage() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    f.spawn_worker();
    let item = f.item("evolve", 1).await;
    // Fail two rollouts before the worker sees either failure.
    f.crash_worker().await;
    fail_rollout(&f, "gateway-upstream", "provider answered 503").await;
    fail_rollout(&f, "sandbox-start", "sandbox runtime refused").await;
    let failed: Vec<String> = sqlx::query_scalar(
        "SELECT error_code FROM learning_rollouts WHERE status='failed' ORDER BY error_code",
    )
    .fetch_all(&f.state.db)
    .await
    .unwrap();
    assert_eq!(failed, ["gateway-upstream", "sandbox-start"]);
    f.spawn_worker();
    let round = f
        .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
        .await;
    assert_eq!(round["reason"], "incumbent-evaluation-failed");
    assert_eq!(failed_rounds(&f).await, 1);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn waiting_loop_reports_the_tasks_needed_and_the_next_round_time() {
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
    // Twenty live evolve tasks and no change: five more wake the loop.
    assert_eq!(idle["evolveTasksNeeded"], 5);
    assert_eq!(idle["nextRoundAt"], Value::Null);
    let change = |tasks: &'static str| {
        let db = f.state.db.clone();
        async move {
            sqlx::query(&format!(
                "UPDATE learning_tasks SET retired_revision=2 WHERE task_id IN ({tasks})"
            ))
            .execute(&db)
            .await
            .unwrap();
            sqlx::query(&format!(r#"INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,added_revision)
                SELECT project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,2 FROM learning_tasks WHERE task_id IN ({tasks})"#))
                .execute(&db).await.unwrap();
            sqlx::query("UPDATE learning_loops SET task_revision=2")
                .execute(&db)
                .await
                .unwrap();
        }
    };
    change("'extra-3','extra-4','extra-5'").await;
    let fewer = f
        .wait_for("", "reader", |r| r["evolveTasksNeeded"] == 2)
        .await;
    assert_eq!(fewer["waiting"], "no-new-evidence");
    change("'extra-6','extra-7'").await;
    let capped = f
        .wait_for("", "reader", |r| r["waiting"] == "daily-cap")
        .await;
    assert_eq!(capped["evolveTasksNeeded"], Value::Null);
    let window: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT created_at+interval '24 hours' FROM learning_rounds WHERE number=1",
    )
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert_eq!(timestamp(&capped["nextRoundAt"]), window);
}
