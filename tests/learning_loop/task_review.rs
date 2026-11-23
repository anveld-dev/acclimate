//! Bulk confirmation, rechecks of checks that could not run, and trial error codes.
use super::*;

/// Finds console task inputs whose group lands on each split.
fn inputs(split: &str, count: usize) -> Vec<Value> {
    (0..)
        .map(|n| json!(format!("review {split} {n}")))
        .filter(|input| {
            let group = format!("console:{}", hex::encode(Sha256::digest(input.to_string())));
            (Sha256::digest(group)[0] < 128) == (split == "held-out")
        })
        .take(count)
        .collect()
}
fn task(input: &Value) -> Value {
    json!({"input":input,"grader":{"type":"exact","expected":"answer"}})
}
async fn rows(
    f: &Fixture,
    table: &str,
    id: &str,
) -> Vec<(i64, String, Option<String>, Option<String>)> {
    sqlx::query_as(&format!("SELECT added_revision,admission,admission_reason,confirmed_by FROM {table} WHERE task_id=$1 ORDER BY added_revision"))
        .bind(id).fetch_all(&f.state.db).await.unwrap()
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn held_out_tasks_are_confirmed_together_with_per_task_results() {
    let f = Fixture::new().await;
    f.enroll().await;
    let person = format!("console/{}", session(&f, "editor").await);
    // A machine writer creates unconfirmed held-out tasks; the person creates a confirmed one.
    let held = inputs("held-out", 3);
    for input in &held[..2] {
        assert_eq!(
            f.ok("POST", "/tasks", "writer", None, task(input)).await,
            json!({"heldOutCount":1})
        );
    }
    let confirmed = f.ok("POST", "/tasks", &person, None, task(&held[2])).await["taskId"].clone();
    let evolve = f
        .ok(
            "POST",
            "/tasks",
            "writer",
            None,
            task(&inputs("evolve", 1)[0]),
        )
        .await["taskId"]
        .clone();
    let waiting = f
        .ok(
            "GET",
            "/tasks?split=held-out&admission=pending&confirmed=false",
            &person,
            None,
            Value::Null,
        )
        .await;
    let ids: Vec<Value> = waiting["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["taskId"].clone())
        .collect();
    assert_eq!(ids.len(), 2, "{waiting}");
    assert_eq!(waiting["heldOutCount"], 2);
    let all = f
        .ok("GET", "/tasks?confirmed=true", &person, None, Value::Null)
        .await;
    assert_eq!(all["items"].as_array().unwrap().len(), 1);
    assert_eq!(all["items"][0]["taskId"], confirmed);

    let body = json!({"taskIds":[ids[0],ids[1],ids[0],confirmed,evolve,"missing"]});
    assert_eq!(
        f.req("POST", "/tasks/confirm", "writer", None, body.clone())
            .await
            .0,
        403
    );
    for invalid in [
        json!({"taskIds":[]}),
        json!({"taskIds":vec!["a";101]}),
        json!({"ids":["a"]}),
    ] {
        assert_eq!(
            f.req("POST", "/tasks/confirm", &person, None, invalid)
                .await
                .0,
            400
        );
    }
    let before: i64 = sqlx::query_scalar("SELECT task_revision FROM learning_loops")
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    let reply = f.ok("POST", "/tasks/confirm", &person, None, body).await;
    let revision = reply["revision"].as_i64().unwrap();
    assert_eq!(revision, before + 1);
    assert_eq!(
        reply["results"],
        json!([
            {"taskId":ids[0],"result":"confirmed"},
            {"taskId":ids[1],"result":"confirmed"},
            {"taskId":confirmed,"result":"already-confirmed"},
            {"taskId":evolve,"result":"not-held-out"},
            {"taskId":"missing","result":"not-found"},
        ])
    );
    // Confirming writes a new revision at the shared task revision, like PATCH {"confirm":true}.
    for id in &ids {
        let history = rows(&f, "learning_held_out_tasks", id.as_str().unwrap()).await;
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].0, revision);
        assert_eq!(history[1].1, "pending");
        assert!(history[1].3.is_some());
    }
    assert_eq!(
        rows(&f, "learning_held_out_tasks", confirmed.as_str().unwrap())
            .await
            .len(),
        1
    );
    assert_eq!(
        rows(&f, "learning_tasks", evolve.as_str().unwrap())
            .await
            .len(),
        1
    );
    let waiting = f
        .ok(
            "GET",
            "/tasks?split=held-out&confirmed=false",
            &person,
            None,
            Value::Null,
        )
        .await;
    assert_eq!(waiting["items"], json!([]));
    // Nothing left to confirm: no revision is spent.
    let again = f
        .ok(
            "POST",
            "/tasks/confirm",
            &person,
            None,
            json!({"taskIds":[ids[0]]}),
        )
        .await;
    assert_eq!(
        again,
        json!({"revision":null,"results":[{"taskId":ids[0],"result":"already-confirmed"}]})
    );
    let after: i64 = sqlx::query_scalar("SELECT task_revision FROM learning_loops")
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(after, revision);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn failed_checks_run_again_without_a_new_revision() {
    let f = Fixture::new().await;
    f.enroll().await;
    let person = format!("console/{}", session(&f, "editor").await);
    let evolve: Vec<String> = {
        let mut ids = vec![];
        for input in inputs("evolve", 3) {
            ids.push(
                f.ok("POST", "/tasks", "writer", None, task(&input)).await["taskId"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        ids
    };
    let held = f
        .ok(
            "POST",
            "/tasks",
            &person,
            None,
            task(&inputs("held-out", 1)[0]),
        )
        .await["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    for table in ["learning_tasks", "learning_held_out_tasks"] {
        sqlx::query(&format!("UPDATE {table} SET admission='set-aside',admission_reason='check-failed' WHERE task_id<>$1"))
            .bind(&evolve[2]).execute(&f.state.db).await.unwrap();
    }
    sqlx::query("UPDATE learning_tasks SET admission='set-aside',admission_reason='reference-failed' WHERE task_id=$1")
        .bind(&evolve[2]).execute(&f.state.db).await.unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT task_revision FROM learning_loops")
        .fetch_one(&f.state.db)
        .await
        .unwrap();

    let one = format!("/tasks/{}/recheck", evolve[0]);
    assert_eq!(
        f.req("POST", &one, "reader", None, Value::Null).await.0,
        403
    );
    assert_eq!(
        f.req(
            "POST",
            "/tasks/missing/recheck",
            "writer",
            None,
            Value::Null
        )
        .await
        .0,
        404
    );
    // A check that ran and failed is fixed by editing, not by running it again.
    let (status, reply) = f
        .req(
            "POST",
            &format!("/tasks/{}/recheck", evolve[2]),
            "writer",
            None,
            Value::Null,
        )
        .await;
    assert_eq!(status, 409, "{reply}");
    // A machine token cannot see held-out tasks, so it cannot recheck one.
    assert_eq!(
        f.req(
            "POST",
            &format!("/tasks/{held}/recheck"),
            "writer",
            None,
            Value::Null
        )
        .await
        .0,
        404
    );

    assert_eq!(
        f.ok("POST", &one, "writer", None, Value::Null).await,
        json!({"taskId":evolve[0],"admission":"pending"})
    );
    let history = rows(&f, "learning_tasks", &evolve[0]).await;
    assert_eq!(history.len(), 1);
    assert_eq!(
        (history[0].1.as_str(), history[0].2.as_deref()),
        ("pending", None)
    );
    assert!(history[0].0 <= revision);
    // The next executor poll queues the admission check on the same row.
    f.state.runtime.ownership_acquired();
    let (status, lease) = executor_tests::post(
        &f.internal(),
        "",
        &f.token,
        json!({"executor":Fixture::identity()}),
    )
    .await;
    assert_eq!(status, 200, "{lease}");
    let queued: bool = sqlx::query_scalar(
        "SELECT admission_trial IS NOT NULL FROM learning_tasks WHERE task_id=$1",
    )
    .bind(&evolve[0])
    .fetch_one(&f.state.db)
    .await
    .unwrap();
    assert!(queued);
    assert_eq!(
        f.req("POST", &one, "writer", None, Value::Null).await.0,
        409
    );

    // A machine writer reruns only evolve tasks; a person reruns the rest, limited by ids.
    assert_eq!(
        f.ok(
            "POST",
            "/tasks/recheck",
            "writer",
            None,
            json!({"taskIds":["missing"]})
        )
        .await,
        json!({"taskIds":[]})
    );
    assert_eq!(
        f.ok("POST", "/tasks/recheck", "writer", None, Value::Null)
            .await,
        json!({"taskIds":[evolve[1]]})
    );
    assert_eq!(
        f.ok("POST", "/tasks/recheck", &person, None, json!({}))
            .await,
        json!({"taskIds":[held]})
    );
    assert_eq!(
        f.req(
            "POST",
            "/tasks/recheck",
            &person,
            None,
            json!({"taskIds":[]})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        rows(&f, "learning_held_out_tasks", &held).await[0].1,
        "pending"
    );
    assert_eq!(
        rows(&f, "learning_tasks", &evolve[2]).await[0].2.as_deref(),
        Some("reference-failed")
    );
    let after: i64 = sqlx::query_scalar("SELECT task_revision FROM learning_loops")
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(after, revision);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn a_failed_trial_reports_its_error_code() {
    let f = Fixture::new().await;
    f.enroll().await;
    let id = f
        .ok(
            "POST",
            "/tasks",
            "writer",
            None,
            task(&inputs("evolve", 1)[0]),
        )
        .await["taskId"]
        .clone();
    let trial = f
        .ok(
            "POST",
            &format!("/tasks/{}/try", id.as_str().unwrap()),
            "writer",
            None,
            Value::Null,
        )
        .await["trialId"]
        .clone();
    let path = format!("/trials/{}", trial.as_str().unwrap());
    assert!(
        f.ok("GET", &path, "writer", None, Value::Null)
            .await
            .get("error")
            .is_none()
    );
    sqlx::query("UPDATE learning_rollouts SET status='failed',error_code='sandbox-start' WHERE trial_id=$1::uuid")
        .bind(trial.as_str().unwrap()).execute(&f.state.db).await.unwrap();
    let read = f.ok("GET", &path, "writer", None, Value::Null).await;
    assert_eq!(read["status"], "failed");
    assert_eq!(read["error"], json!({"code":"sandbox-start"}));
    sqlx::query(
        "UPDATE learning_rollouts SET status='cancelled',error_code=NULL WHERE trial_id=$1::uuid",
    )
    .bind(trial.as_str().unwrap())
    .execute(&f.state.db)
    .await
    .unwrap();
    assert_eq!(
        f.ok("GET", &path, "writer", None, Value::Null).await["error"],
        json!({"code":"cancelled"})
    );
}
