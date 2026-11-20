mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
async fn call(
    app: &axum::Router,
    method: &str,
    url: &str,
    key: &str,
    value: Value,
) -> (u16, Value) {
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(url)
                .header("authorization", "Bearer draft-test")
                .header("content-type", "application/json")
                .header("idempotency-key", key)
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status().as_u16();
    let body = to_bytes(r.into_body(), 2 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn immutable_siblings_generation_publish_and_expired_replay() {
    // Explicit fixture URL prevents accidentally migrating or mutating the demo database.
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("draft-test-{}", uuid::Uuid::new_v4());
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "draft-test".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
        provider: None,
    });
    let payload = |text: &str| json!({"schemaVersion":1,"files":[{"path":"AGENTS.md","kind":"instruction","text":text}]});
    let setup_url = format!("/v1/workspaces/{project}/bundle-setups");
    let (status,setup)=call(&app,"POST",&setup_url,"setup",json!({"name":"fixture","origin":"created","channel":"stable","payload":payload("base"),"reason":"initial seed"})).await;
    assert_eq!(status, 201, "{setup}");
    let base = setup["version"]["id"].as_str().unwrap();
    let bundle = setup["bundle"]["id"].as_str().unwrap();
    let drafts = format!("/v1/workspaces/{project}/bundles/{bundle}/channels/stable/drafts");
    let (status, d1) = call(
        &app,
        "POST",
        &drafts,
        "create",
        json!({"baseVersionId":base,"baseRevision":"1","payload":payload("one")}),
    )
    .await;
    assert_eq!(status, 201, "{d1}");
    let url = format!("{drafts}/{}", d1["id"].as_str().unwrap());
    let save = json!({"expectedGeneration":1,"payload":payload("two")});
    let (status, d2) = call(&app, "POST", &format!("{url}/save"), "save", save.clone()).await;
    assert_eq!(status, 200, "{d2}");
    assert_eq!(d2["generation"], 2);
    assert_eq!(d2["snapshotVersion"]["parentVersionId"], base);
    assert_ne!(d1["snapshotVersion"]["id"], d2["snapshotVersion"]["id"]);
    let (status, conflict) =
        call(&app, "POST", &format!("{url}/save"), "stale", save.clone()).await;
    assert_eq!(status, 409);
    assert_eq!(conflict["error"]["code"], "generation_conflict");
    sqlx::query("UPDATE idempotency SET expires_at=now()-interval '1 second' WHERE project_id=$1")
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let (status, replay) = call(&app, "POST", &format!("{url}/save"), "save", save).await;
    assert_eq!(status, 200);
    assert_eq!(replay, d2);
    let (_, history) = call(
        &app,
        "GET",
        &format!("{url}/history"),
        "unused",
        Value::Null,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    let (status, stale_draft) = call(
        &app,
        "POST",
        &drafts,
        "other-draft",
        json!({"baseVersionId":base,"baseRevision":"1","payload":payload("other")}),
    )
    .await;
    assert_eq!(status, 201);
    let(status,published)=call(&app,"POST",&format!("{url}/publish"),"publish",json!({"expectedGeneration":2,"expectedRevision":"1","unevaluatedReason":"reviewed manually"})).await;
    assert_eq!(status, 200, "{published}");
    assert_eq!(published["status"], "published");
    assert!(published["promotionId"].is_string());
    let stale_url = format!("{drafts}/{}/publish", stale_draft["id"].as_str().unwrap());
    let (status, stale) = call(
        &app,
        "POST",
        &stale_url,
        "stale-publish",
        json!({"expectedGeneration":1,"expectedRevision":"1","unevaluatedReason":"stale"}),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(stale["error"]["code"], "base_conflict");
    let (status, same_base_draft)=call(&app,"POST",&drafts,"same-base",json!({"baseVersionId":published["snapshotVersion"]["id"],"baseRevision":"2","payload":payload("third")})).await;
    assert_eq!(status, 201);
    let promotion_url =
        format!("/v1/workspaces/{project}/bundles/{bundle}/channels/stable/releases");
    let (status,_)=call(&app,"POST",&promotion_url,"repeat-version",json!({"versionId":published["snapshotVersion"]["id"],"expectedRevision":"2","unevaluatedReason":"same version reviewed"})).await;
    assert_eq!(status, 201);
    let (status, conflict) = call(
        &app,
        "POST",
        &format!(
            "{drafts}/{}/publish",
            same_base_draft["id"].as_str().unwrap()
        ),
        "same-version-changed-revision",
        json!({"expectedGeneration":1,"expectedRevision":"2","unevaluatedReason":"must reject"}),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(conflict["error"]["code"], "base_conflict");
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM bundles WHERE project_id=$1")
        .bind(&project)
        .fetch_one(&db)
        .await
        .unwrap();
    let (status,_)=call(&app,"POST",&setup_url,"bad-seed",json!({"name":"must rollback","origin":"imported","channel":"stable","payload":payload("bad"),"reason":" "})).await;
    assert_eq!(status, 400);
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM bundles WHERE project_id=$1")
        .bind(&project)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(before, after);
    let (status, closed) = call(
        &app,
        "POST",
        &format!("{url}/discard"),
        "discard",
        json!({"expectedGeneration":2}),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(closed["error"]["code"], "draft_closed");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn publication_observes_concurrent_policy_checks_and_records_an_exact_override() {
    let url = common::database_url();
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("policy-publish-{}", uuid::Uuid::new_v4());
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "draft-test".into(),
            principal_id: project.clone(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
        provider: None,
    });
    let payload = |text| json!({"schemaVersion":1,"files":[{"path":"AGENTS.md","kind":"instruction","text":text}]});
    let (status,setup) = call(&app,"POST",&format!("/v1/workspaces/{project}/bundle-setups"),"setup",json!({"name":"test","origin":"created","channel":"stable","payload":payload("parent"),"reason":"first release"})).await;
    assert_eq!(status, 201, "{setup}");
    let root = format!(
        "/v1/workspaces/{project}/bundles/{}",
        setup["bundle"]["id"].as_str().unwrap()
    );
    let drafts = format!("{root}/channels/stable/drafts");
    let promotions = format!("{root}/channels/stable/releases");
    let parent = &setup["version"];
    let (status, draft) = call(
        &app,
        "POST",
        &drafts,
        "create",
        json!({"baseVersionId":parent["id"],"baseRevision":"1","payload":payload("candidate")}),
    )
    .await;
    assert_eq!(status, 201, "{draft}");
    let candidate = &draft["snapshotVersion"];
    let bid: uuid::Uuid = setup["bundle"]["id"].as_str().unwrap().parse().unwrap();
    let vid: uuid::Uuid = candidate["id"].as_str().unwrap().parse().unwrap();
    let publish = format!("{drafts}/{}/publish", draft["id"].as_str().unwrap());
    let initial = json!({"expectedGeneration":1,"expectedRevision":"1"});
    let score = json!({"executionStatus":"completed","gradingStatus":"scored","reward":1});
    let evidence = json!({"parentVersionId":parent["id"],"candidateVersionId":candidate["id"],
        "parentDigest":parent["digest"],"candidateDigest":candidate["digest"],"datasetRevision":"dataset","graderRevision":"grade",
        "runtime":{"model":"local"},"expectedCases":[{"caseId":"task","repetition":0}],
        "results":[{"caseId":"task","repetition":0,"parent":score,"candidate":score}]});
    let (status, first) = call(
        &app,
        "POST",
        &format!("{root}/comparisons"),
        "first",
        evidence.clone(),
    )
    .await;
    assert_eq!(status, 201, "{first}");
    let (status, second) = call(
        &app,
        "POST",
        &format!("{root}/comparisons"),
        "alternative",
        evidence,
    )
    .await;
    assert_eq!(status, 201, "{second}");
    let mut publish_body = initial.clone();
    publish_body["comparisonId"] = second["id"].clone();

    // Hold the same transaction lock the reporting endpoint takes and insert
    // a verdict before commit. A concurrent publication must wait for it.
    let mut tx = db.begin().await.unwrap();
    let lock_owner: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("policy-receipt:{project}:{bid}:{vid}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    let comparison: uuid::Uuid = first["id"].as_str().unwrap().parse().unwrap();
    let add_blocker = "INSERT INTO evaluation_policy_receipts(project_id,bundle_id,candidate_version_id,comparison_id,policy_digest,reported_by,body) VALUES($1,$2,$3,$4,$5,'evaluator',$6)";
    sqlx::query(add_blocker)
        .bind(&project)
        .bind(bid)
        .bind(vid)
        .bind(comparison)
        .bind(&digest)
        .bind(json!({"verdict":"fail"}))
        .execute(&mut *tx)
        .await
        .unwrap();
    let waiting = tokio::spawn({
        let app = app.clone();
        let path = publish.clone();
        let body = publish_body.clone();
        async move { call(&app, "POST", &path, "racing", body).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(15),async {
        loop {
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))")
                .bind(lock_owner).fetch_one(&db).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("publication should be waiting for the policy receipt transaction");
    tx.commit().await.unwrap();
    let (status, conflict) = waiting.await.unwrap();
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["error"]["code"], "policy_override_required");
    assert!(conflict["error"]["details"].is_null());
    for bypass in [
        json!({"versionId":vid,"expectedRevision":"1","comparisonId":second["id"]}),
        json!({"versionId":vid,"expectedRevision":"1","unevaluatedReason":"manual"}),
    ] {
        let (status, err) = call(&app, "POST", &promotions, "bypass", bypass).await;
        assert_eq!(status, 409, "{err}");
        assert_eq!(err["error"]["code"], "policy_override_required");
    }
    let decision = json!({"reason":"Known limitation reviewed","receipts":[{"comparisonId":comparison,"policyDigest":digest}]});
    let mut stale = publish_body.clone();
    stale["policyOverride"] = decision.clone();
    stale["policyOverride"]["receipts"][0]["comparisonId"] = second["id"].clone();
    assert_eq!(call(&app, "POST", &publish, "stale", stale).await.0, 409);
    publish_body["policyOverride"] = decision.clone();
    let (status, approved) = call(&app, "POST", &publish, "approved", publish_body.clone()).await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        call(&app, "POST", &publish, "approved", publish_body)
            .await
            .1,
        approved
    );
    let (_, history) = call(&app, "GET", &promotions, "", Value::Null).await;
    assert_eq!(history["items"][0]["policyOverride"], decision);
    let original_approval = history["items"][0]["id"].clone();

    // A later release can roll back to this exact, previously approved revision.
    let (status, next) = call(
        &app,
        "POST",
        &format!("{root}/versions"),
        "next",
        json!({"parentVersionId":vid,"payload":payload("later")}),
    )
    .await;
    assert_eq!(status, 201, "{next}");
    let forward = |revision| json!({"versionId":next["id"],"expectedRevision":revision,"unevaluatedReason":"reviewed"});
    assert_eq!(
        call(&app, "POST", &promotions, "forward", forward("2"))
            .await
            .0,
        201
    );
    let rollback = |revision| json!({"versionId":vid,"expectedRevision":revision,"unevaluatedReason":"Restore the approved release"});
    let (status, restored) = call(&app, "POST", &promotions, "restore", rollback("3")).await;
    assert_eq!(status, 201, "{restored}");
    assert!(restored["policyOverride"].is_null());
    let (_, historical) = call(&app, "GET", &promotions, "", Value::Null).await;
    assert_eq!(historical["items"][0]["policyOverride"], decision);
    assert_eq!(restored["policyApprovalPromotionId"], original_approval);
    assert_eq!(
        call(&app, "POST", &promotions, "forward-again", forward("4"))
            .await
            .0,
        201
    );
    sqlx::query(add_blocker)
        .bind(&project)
        .bind(bid)
        .bind(vid)
        .bind(comparison)
        .bind(format!("sha256:{}", "b".repeat(64)))
        .bind(json!({"verdict":"indeterminate"}))
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "POST", &promotions, "stale-approval", rollback("5"))
            .await
            .0,
        409
    );
}
