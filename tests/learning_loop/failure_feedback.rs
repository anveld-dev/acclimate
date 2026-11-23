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

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn provider_outage_waits_ten_minutes_without_counting_toward_the_pause() {
    let mut f = Fixture::new().await;
    f.enroll().await;
    f.seed().await;
    // Two failures already: one more counted failure would pause the loop.
    sqlx::query("UPDATE learning_loops SET failed_rounds=2")
        .execute(&f.state.db)
        .await
        .unwrap();
    f.spawn_worker();
    for number in 1..=2 {
        let item = f.item("evolve", number).await;
        fail_rollout(
            &f,
            "gateway-upstream",
            "provider answered 429 after retries",
        )
        .await;
        let round = f
            .wait_for(&round_route(&item), "reader", |r| r["state"] == "failed")
            .await;
        assert_eq!(round["reason"], "provider-unavailable");
        assert_eq!(round["failureCause"]["code"], "gateway-upstream");
        let state = f
            .wait_for("", "reader", |r| r["waiting"] == "provider-unavailable")
            .await;
        assert_eq!(state["status"], "running");
        assert_eq!(state["pauseReason"], Value::Null);
        assert_eq!(failed_rounds(&f).await, 2);
        let ended = timestamp(&round["endedAt"]);
        assert_eq!(
            timestamp(&state["nextRoundAt"]),
            ended + chrono::Duration::minutes(10)
        );
        // The worker ticks every 500 ms, so this covers several ticks without a new round.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let rounds: i64 = sqlx::query_scalar("SELECT count(*) FROM learning_rounds")
            .fetch_one(&f.state.db)
            .await
            .unwrap();
        assert_eq!(rounds, i64::from(number));
        sqlx::query(
            "UPDATE learning_rounds SET ended_at=now()-interval '11 minutes' WHERE number=$1",
        )
        .bind(number)
        .execute(&f.state.db)
        .await
        .unwrap();
    }
    let next = f
        .wait_for("", "reader", |r| r["activeRound"]["number"] == 3)
        .await;
    assert_eq!(next["activeRound"]["trigger"], "retry");
    assert_eq!(next["waiting"], Value::Null);
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
