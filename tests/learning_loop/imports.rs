use super::*;
use executor_tests::{act, post};

const PROSE: &str =
    "Sorry about the double charge. We refund the second payment within five business days.";

/// Posts raw import material, so a test can send several JSONL lines or plain text.
async fn import(
    f: &Fixture,
    caller: &str,
    filename: &str,
    media: &str,
    body: &str,
) -> (u16, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri(format!(
            "/v1/workspaces/{}/bundles/{}/learning/tasks/import?filename={filename}",
            f.project, f.bundle
        ))
        .header("content-type", media);
    req = if let Some(session) = caller.strip_prefix("console/") {
        req.header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
            .header("x-acclimate-session", session)
    } else {
        req.header("authorization", format!("Bearer {caller}"))
    };
    let reply = f
        .app
        .clone()
        .oneshot(req.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = reply.status().as_u16();
    let bytes = to_bytes(reply.into_body(), 2_097_152).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn jsonl(rows: &[Value]) -> String {
    rows.iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Takes leases until the executor is handed the next conversion.
async fn conversion_lease(f: &Fixture) -> Value {
    for _ in 0..50 {
        let (status, lease) = post(
            &f.internal(),
            "",
            &f.token,
            json!({"executor":Fixture::identity()}),
        )
        .await;
        if status == 200 && lease["kind"] == "conversion" {
            return lease;
        }
    }
    panic!("no conversion lease");
}

/// Reports drafted criteria for every row of a conversion lease.
async fn draft_criteria(f: &Fixture, lease: &Value, input: Option<&str>) {
    let cards: Vec<_> = lease["material"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| json!({"row":r["row"],"group":r["source"],"input":input.map_or(r["material"]["input"].clone(), |i| json!(i)),"criteriaDrafted":true,"grader":{"type":"criteria","criteria":["Says the charge is refunded"],"reference":r["material"]["expected"]}}))
        .collect();
    let report = json!({"cards":cards,"setAside":[],"judgeLog":[],"tokens":{"judge":{"input":1,"output":1}}});
    assert_eq!(act(&f.internal(), lease, "result", report).await.0, 204);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn grading_follows_the_answer_shape_unless_the_row_chooses() {
    let f = Fixture::new().await;
    f.enroll().await;
    let person = format!("console/{}", session(&f, "editor").await);
    let (status, reply) = import(
        &f,
        &person,
        "bad.jsonl",
        "application/jsonl",
        &jsonl(&[json!({"input":"q","expected":"a","grading":"fuzzy"})]),
    )
    .await;
    assert_eq!(status, 400);
    assert!(
        reply.to_string().contains("Row 1: grading must be"),
        "{reply}"
    );
    let rows = [
        json!({"input":"short","expected":"Paris"}),
        json!({"input":"prose","expected":PROSE}),
        json!({"input":"lines","expected":"First line\nSecond line"}),
        json!({"input":"object","expected":{"refund":true}}),
        json!({"input":"chosen exact","expected":PROSE,"grading":"exact"}),
        json!({"input":"chosen criteria","expected":"Paris","grading":"criteria"}),
    ];
    let (status, receipt) = import(
        &f,
        &person,
        "rows.jsonl",
        "application/jsonl",
        &jsonl(&rows),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(
        (
            receipt["rows"].as_i64(),
            receipt["converted"].as_i64(),
            receipt["pending"].as_i64()
        ),
        (Some(6), Some(3), Some(3))
    );
    let exact: Vec<_> = receipt["cards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["sourceRow"].as_i64().unwrap(),
                c["grader"]["type"].clone(),
            )
        })
        .collect();
    assert_eq!(
        exact,
        [
            (1, json!("exact")),
            (4, json!("exact")),
            (5, json!("exact"))
        ]
    );
    let lease = conversion_lease(&f).await;
    let pending: Vec<_> = lease["material"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["row"].as_i64().unwrap(), r["material"]["grading"].clone()))
        .collect();
    assert_eq!(pending, [2, 3, 6].map(|n| (n, json!("criteria"))).to_vec());
    draft_criteria(&f, &lease, None).await;
    let path = format!("/tasks/imports/{}", receipt["importId"].as_str().unwrap());
    let status = f.ok("GET", &path, &person, None, Value::Null).await;
    assert_eq!(
        (status["status"].as_str(), status["converted"].as_i64()),
        (Some("completed"), Some(6))
    );
    let page = f
        .ok(
            "GET",
            "/tasks?source=import&limit=100",
            &person,
            None,
            Value::Null,
        )
        .await;
    let task = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["input"] == "prose")
        .unwrap();
    assert_eq!(task["grader"]["type"], "criteria");
    assert_eq!(task["grader"]["reference"], PROSE);
    // Drafted criteria never confirm a task on their own.
    assert!(task["confirmedBy"].is_null());
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn an_outcome_with_a_prose_answer_is_converted_to_a_criteria_task() {
    let f = Fixture::new().await;
    f.enroll().await;
    let person = format!("console/{}", session(&f, "editor").await);
    let job = (0..200)
        .map(Uuid::from_u128)
        .find(|id| Sha256::digest(id.to_string())[0] >= 128)
        .unwrap();
    let outcome = |expected: Value| json!({"outcomeId":job,"versionId":f.version,"digest":DIGEST,"input":"Why was I charged twice?","expected":expected,"output":"wrong"});
    let mut bad = outcome(json!(PROSE));
    bad["grading"] = json!("fuzzy");
    assert_eq!(f.req("POST", "/outcomes", "app", None, bad).await.0, 400);
    let mut same = outcome(json!(PROSE));
    same["output"] = json!(PROSE);
    assert_eq!(f.req("POST", "/outcomes", "app", None, same).await.0, 400);
    let receipt = f
        .ok("POST", "/outcomes", "app", None, outcome(json!(PROSE)))
        .await;
    assert_eq!(receipt["taskId"], format!("outcome:{job}"));
    assert!(receipt["taskRevision"].is_i64());
    // The task waits for conversion to draft its criteria.
    let page = f
        .ok("GET", "/tasks?source=outcome", &person, None, Value::Null)
        .await;
    assert_eq!(page["items"], json!([]));
    let lease = conversion_lease(&f).await;
    assert_eq!(
        lease["material"]["rows"][0]["material"],
        json!({"input":"Why was I charged twice?","expected":PROSE,"grading":"criteria"})
    );
    // The outcome keeps its own input even if the conversion maps another one.
    draft_criteria(&f, &lease, Some("tampered")).await;
    let page = f
        .ok("GET", "/tasks?source=outcome", &person, None, Value::Null)
        .await;
    let task = &page["items"][0];
    assert_eq!(task["taskId"], format!("outcome:{job}"));
    assert_eq!(task["group"], job.to_string());
    assert_eq!(task["input"], "Why was I charged twice?");
    assert_eq!(task["output"], "wrong");
    assert_eq!(task["outcomeId"], job.to_string());
    assert_eq!(task["versionId"], f.version.to_string());
    assert_eq!(
        task["grader"],
        json!({"type":"criteria","criteria":["Says the charge is refunded"],"reference":PROSE})
    );
    // A one-line answer is compared exactly unless the caller chooses criteria.
    let short = |id: u128, grading: Option<&str>| {
        let mut o = json!({"outcomeId":Uuid::from_u128(1000 + id),"versionId":f.version,"digest":DIGEST,"input":format!("short {id}"),"expected":"Paris"});
        if let Some(g) = grading {
            o["grading"] = json!(g);
        }
        o
    };
    f.ok("POST", "/outcomes", "app", None, short(1, None)).await;
    f.ok("POST", "/outcomes", "app", None, short(2, Some("criteria")))
        .await;
    let listed = f
        .ok(
            "GET",
            "/tasks?source=outcome&limit=100",
            &person,
            None,
            Value::Null,
        )
        .await;
    let all: Vec<_> = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["input"].as_str().is_some_and(|i| i.starts_with("short")))
        .map(|t| (t["input"].clone(), t["grader"]["type"].clone()))
        .collect();
    assert_eq!(all, [(json!("short 1"), json!("exact"))]);
    // Outcome conversions never appear in the import history.
    let history = f
        .ok("GET", "/tasks/imports", &person, None, Value::Null)
        .await;
    assert_eq!(history["items"], json!([]));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn pasted_text_becomes_one_row_per_chunk() {
    let f = Fixture::new().await;
    f.enroll().await;
    let paste = "User: first\n---\n\n -----\nUser: second\nAgent: reply\n---\nUser: third\n";
    let (status, receipt) = import(&f, "writer", "paste", "text/plain", paste).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(
        (receipt["rows"].as_i64(), receipt["pending"].as_i64()),
        (Some(3), Some(3))
    );
    let lease = conversion_lease(&f).await;
    assert_eq!(lease["material"]["format"], "conversations");
    let rows: Vec<_> = lease["material"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["source"].clone(), r["material"].clone()))
        .collect();
    assert_eq!(
        rows,
        [
            (json!("row:1"), json!("User: first")),
            (json!("row:2"), json!("User: second\nAgent: reply")),
            (json!("row:3"), json!("User: third")),
        ]
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn imports_are_listed_and_rows_matching_live_tasks_are_set_aside() {
    let f = Fixture::new().await;
    f.enroll().await;
    let person = format!("console/{}", session(&f, "editor").await);
    let first = jsonl(&[json!({"input":{"q":"dup"},"expected":"x"})]);
    let (_, first) = import(&f, &person, "a.jsonl", "application/jsonl", &first).await;
    assert_eq!(first["converted"], 1);
    let second = jsonl(&[
        json!({"input":{"q":"dup"},"expected":"y"}),
        json!({"input":"fresh","expected":"z"}),
        json!({"input":"fresh","expected":"w"}),
    ]);
    let (_, second) = import(&f, &person, "b.jsonl", "application/jsonl", &second).await;
    assert_eq!(
        (
            second["converted"].as_i64(),
            second["setAsideCount"].as_i64(),
            second["pending"].as_i64()
        ),
        (Some(1), Some(2), Some(0))
    );
    assert_eq!(second["cards"].as_array().unwrap().len(), 1);
    assert_eq!(second["cards"][0]["input"], "fresh");
    let third = jsonl(&[json!({"input":"fresh","expected":"v"})]);
    let (_, third) = import(&f, "writer", "c.jsonl", "application/jsonl", &third).await;
    assert_eq!(
        third,
        json!({"importId":third["importId"],"rows":1,"converted":0,"pending":0,"setAsideCount":1})
    );
    let history = f
        .ok("GET", "/tasks/imports", &person, None, Value::Null)
        .await;
    let items = history["items"].as_array().unwrap();
    let ids: Vec<_> = items.iter().map(|i| i["importId"].clone()).collect();
    assert_eq!(
        ids,
        [&third, &second, &first].map(|r| r["importId"].clone())
    );
    assert_eq!(
        items
            .iter()
            .map(|i| i["source"].clone())
            .collect::<Vec<_>>(),
        ["c.jsonl", "b.jsonl", "a.jsonl"].map(|s| json!(s))
    );
    assert_eq!(
        items[1]["setAside"],
        json!([{"row":1,"source":"b.jsonl","reason":"duplicate"},{"row":3,"source":"b.jsonl","reason":"duplicate"}])
    );
    for item in items {
        assert!(item["createdAt"].is_string());
        let single = f
            .ok(
                "GET",
                &format!("/tasks/imports/{}", item["importId"].as_str().unwrap()),
                &person,
                None,
                Value::Null,
            )
            .await;
        let mut listed = item.clone();
        let fields = listed.as_object_mut().unwrap();
        fields.remove("createdAt");
        fields.remove("source");
        assert_eq!(listed, single);
    }
    let machine = f
        .ok("GET", "/tasks/imports", "writer", None, Value::Null)
        .await;
    let items = machine["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[1]["setAsideCount"], 2);
    assert!(items.iter().all(|i| i["setAside"] == json!([])));
    // A retired task no longer blocks the same input.
    let id = second["cards"][0]["taskId"].as_str().unwrap();
    f.ok(
        "DELETE",
        &format!("/tasks/{id}"),
        &person,
        None,
        Value::Null,
    )
    .await;
    let fourth = jsonl(&[json!({"input":"fresh","expected":"u"})]);
    let (_, again) = import(&f, &person, "d.jsonl", "application/jsonl", &fourth).await;
    assert_eq!(again["converted"], 1);
}
