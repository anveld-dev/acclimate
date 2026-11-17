mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;
async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    call_with_key(app, method, path, token, body, None).await
}
async fn call_with_key(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
    key: Option<&str>,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header(
                    "idempotency-key",
                    key.map(str::to_owned)
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                )
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
async fn opt_in_credentials_are_scoped_revocable_and_receipts_idempotent() {
    let Ok(url) = std::env::var("ACCLIMATE_TEST_DATABASE_URL") else {
        return;
    };
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let p = format!("receipt-{}", Uuid::new_v4());
    let b = Uuid::new_v4();
    let v = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    let digest = format!("sha256:{}", "a".repeat(64));
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'fixture')")
        .bind(b)
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    for id in [v, candidate] {
        sqlx::query(
            "INSERT INTO versions(id,project_id,bundle_id,digest,payload) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(id)
        .bind(&p)
        .bind(b)
        .bind(&digest)
        .bind(b"{}".as_slice())
        .execute(&db)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)").bind(&p).bind(b).bind(v).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,reviewer) VALUES($1,$2,$3,'stable',1,$4,'fixture')").bind(Uuid::new_v4()).bind(&p).bind(b).bind(v).execute(&db).await.unwrap();
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![Grant {
            token: "operator".into(),
            principal_id: "operator".into(),
            project_id: p.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        }]),
        provider: None,
    });
    let base = format!("/v1/projects/{p}/integrations");
    let mut ids = vec![];
    for _ in 0..2 {
        let (status, r) = call(
            &app,
            "POST",
            &base,
            "operator",
            json!({"displayName":"fixture","bundleId":b,"channel":"stable"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        ids.push(r["id"].as_str().unwrap().to_owned());
    }
    let endpoint = format!("{base}/{}", ids[0]);
    let create_key = Uuid::new_v4().to_string();
    let create_body = json!({"displayName":"replay fixture","bundleId":b,"channel":"stable"});
    let (status, created) = call_with_key(
        &app,
        "POST",
        &base,
        "operator",
        create_body.clone(),
        Some(&create_key),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        call_with_key(
            &app,
            "POST",
            &base,
            "operator",
            create_body,
            Some(&create_key)
        )
        .await
        .1,
        created
    );
    let issue_key = Uuid::new_v4().to_string();
    let (status, issued) = call_with_key(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"receipt-write"}),
        Some(&issue_key),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, repeated) = call_with_key(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"receipt-write"}),
        Some(&issue_key),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(repeated["error"]["code"], "credential_already_issued");
    assert!(repeated.get("secret").is_none());
    let listed = call(&app, "GET", &base, "operator", Value::Null).await.1;
    let found = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == ids[0])
        .unwrap();
    assert!(
        found["credentials"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == issued["id"])
    );
    assert!(
        !listed
            .to_string()
            .contains(issued["secret"].as_str().unwrap())
    );

    let (_, read) = call(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"content-read"}),
    )
    .await;
    let (_, write) = call(
        &app,
        "POST",
        &format!("{endpoint}/credentials"),
        "operator",
        json!({"kind":"receipt-write"}),
    )
    .await;
    let read = read["secret"].as_str().unwrap();
    let write = write["secret"].as_str().unwrap();
    let mut event = json!({"eventId":Uuid::new_v4(),"integrationId":ids[0],"projectId":p,"bundleId":b,"versionId":v,"digest":digest,"stage":"verified","source":"cache","occurredAt":chrono::Utc::now()});
    let receipt = format!("{endpoint}/receipts");
    assert_eq!(
        call(&app, "POST", &receipt, read, event.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", &receipt, write, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut bad = event.clone();
    bad["stage"] = json!("downloaded");
    assert_eq!(
        call(&app, "POST", &receipt, write, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut bad = event.clone();
    bad["occurredAt"] = json!(chrono::Utc::now() - chrono::Duration::hours(25));
    assert_eq!(
        call(&app, "POST", &receipt, write, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut bad = event.clone();
    bad["digest"] = json!(format!("sha256:{}", "b".repeat(64)));
    assert_eq!(
        call(&app, "POST", &receipt, write, bad).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, first) = call(&app, "POST", &receipt, write, event.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (_, second) = call(&app, "POST", &receipt, write, event.clone()).await;
    assert_eq!(first, second);
    event["stage"] = json!("prepared");
    assert_eq!(
        call(&app, "POST", &receipt, write, event.clone()).await.0,
        StatusCode::CONFLICT
    );
    event["eventId"] = json!(Uuid::new_v4());
    event["integrationId"] = json!(ids[1]);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{base}/{}/receipts", ids[1]),
            write,
            event.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    event["integrationId"] = json!(ids[0]);
    event["versionId"] = json!(candidate);
    assert_eq!(
        call(&app, "POST", &receipt, write, event.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let payload = format!("/v1/projects/{p}/bundles/{b}/versions/{candidate}");
    assert_eq!(
        call(&app, "GET", &payload, read, Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    call(
        &app,
        "POST",
        &format!("{endpoint}/revoke"),
        "operator",
        json!({}),
    )
    .await;
    event["versionId"] = json!(v);
    assert_eq!(
        call(&app, "POST", &receipt, write, event).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn learning_admission_and_delivery_are_connection_scoped() {
    let Ok(url) = std::env::var("ACCLIMATE_TEST_DATABASE_URL") else {
        return;
    };
    let db = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let p = format!("connected-{}", Uuid::new_v4());
    let bundle = Uuid::new_v4();
    let baseline = Uuid::new_v4();
    let replacement = Uuid::new_v4();
    let enrollment_id = Uuid::new_v4();
    let sibling_id = Uuid::new_v4();
    let digest = format!("sha256:{}", "b".repeat(64));
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'fixture')")
        .bind(bundle)
        .bind(&p)
        .execute(&db)
        .await
        .unwrap();
    for version in [baseline, replacement] {
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload) VALUES($1,$2,$3,$4,$5)")
            .bind(version).bind(&p).bind(bundle).bind(&digest)
            .bind(serde_json::to_vec(&json!({"schemaVersion":1,"files":[{"path":"guide.md","kind":"instruction","text":"guide"}]})).unwrap())
            .execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)")
        .bind(&p).bind(bundle).bind(baseline).execute(&db).await.unwrap();
    let legacy_id = Uuid::new_v4();
    for id in [enrollment_id, sibling_id, legacy_id] {
        sqlx::query("INSERT INTO integrations(id,project_id,bundle_id,channel,display_name) VALUES($1,$2,$3,'stable','fixture')")
            .bind(id).bind(&p).bind(bundle).execute(&db).await.unwrap();
    }
    let grant = |principal: &str, rights: &[&str]| Grant {
        token: principal.into(),
        principal_id: principal.into(),
        project_id: p.clone(),
        rights: rights.iter().map(|right| (*right).into()).collect(),
    };
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(vec![
            grant("owner", &["read", "write", "promote"]),
            grant("other-operator", &["read", "write", "promote"]),
            grant("outcome", &["read", "write", "promote"]),
            grant("observer", &["read"]),
            grant("evaluator", &["read", "write"]),
        ]),
        provider: None,
    });
    let connection = format!("/v1/projects/{p}/integrations/{enrollment_id}");
    let sibling = format!("/v1/projects/{p}/integrations/{sibling_id}");
    let enrollment = format!("{connection}/learning");
    let descriptor = |cohort: &str| {
        // The API test's private input is the cohort string itself; the driver qualification
        // separately uses connectedEvaluationDescriptor() on executing app fixtures.
        use sha2::{Digest, Sha256};
        let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(cohort).unwrap()));
        let expected = hex::encode(Sha256::digest(b"true"));
        let cases =
            json!([{"caseId":cohort,"input":fingerprint,"expected":expected,"repetitions":1}]);
        let dataset = hex::encode(Sha256::digest(serde_json::to_vec(&cases).unwrap()));
        json!({
            "datasetRevision":cohort,"runtime":{"fixture":"local"},"graderRevision":"grader",
            "expectedCases":[{"caseId":cohort,"repetition":0}],
            "fixtureProtocol":"installed-v1","datasetDigest":dataset,"caseFingerprints":[fingerprint],
        })
    };
    let settings = json!({
      "installationId":"fixture","permittedPaths":["guide.md"],"maxProposalAdmissions":2,
      "development":descriptor("dev"),"audits":[descriptor("audit")],"automaticRollout":true,
      "outcomePrincipal":"outcome","evaluatorPrincipal":"evaluator",
    });
    let legacy_endpoint = format!("/v1/projects/{p}/integrations/{legacy_id}/learning");
    let dev = descriptor("legacy-dev");
    let audit = descriptor("legacy-audit");
    let mut legacy = settings.clone();
    legacy["development"] = dev.clone();
    legacy["audits"] = json!([audit]);
    legacy["development"]
        .as_object_mut()
        .unwrap()
        .remove("fixtureProtocol");
    legacy["audits"][0]
        .as_object_mut()
        .unwrap()
        .remove("fixtureProtocol");
    // Previous schemas allowed declared fingerprints without checking the installed fixtures.
    assert_eq!(
        call(&app, "PUT", &legacy_endpoint, "owner", legacy.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    legacy["automaticRollout"] = json!(false);
    assert_eq!(
        call(&app, "PUT", &legacy_endpoint, "owner", legacy.clone())
            .await
            .0,
        StatusCode::OK
    );
    legacy["automaticRollout"] = json!(true);
    assert_eq!(
        call(&app, "PUT", &legacy_endpoint, "owner", legacy.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    // Retain the original development identities and the old audit slot while authorizing
    // a new bound development epoch and an independent, content-bound audit.
    let fresh = descriptor("fresh-audit");
    let renew_legacy = json!({"renewalId":Uuid::new_v4(),"expectedRevision":0,
        "proposalAdmissions":0,"development":dev,"audits":[fresh]});
    let upgraded = call(
        &app,
        "POST",
        &format!("{legacy_endpoint}/renew"),
        "owner",
        renew_legacy,
    )
    .await;
    assert_eq!(upgraded.0, StatusCode::OK, "{}", upgraded.1);
    legacy["development"] = dev;
    legacy["audits"].as_array_mut().unwrap().push(fresh);
    let enabled = call(&app, "PUT", &legacy_endpoint, "owner", legacy).await;
    assert_eq!(enabled.0, StatusCode::OK, "{}", enabled.1);
    let upgraded = call(&app, "GET", &legacy_endpoint, "owner", Value::Null)
        .await
        .1;
    assert_eq!(upgraded["auditCount"], 2);
    assert_eq!(upgraded["remainingAudits"], 1);
    let actual = call(&app, "PUT", &enrollment, "owner", settings.clone()).await;
    assert_eq!(actual.0, StatusCode::OK, "{}", actual.1);
    assert_eq!(
        call(&app, "PUT", &enrollment, "owner", settings.clone()).await,
        actual
    );
    assert_eq!(actual.1["automaticRollback"], true);
    let mut stale_rollback = settings.clone();
    stale_rollback["automaticRollback"] = json!(false);
    stale_rollback["expectedAutomaticRollout"] = actual.1["automaticRollout"].clone();
    let mut stopped_rollout = settings.clone();
    stopped_rollout["automaticRollout"] = json!(false);
    stopped_rollout["expectedAutomaticRollout"] = json!(true);
    let updated = call(&app, "PUT", &enrollment, "other-operator", stopped_rollout).await;
    assert_eq!(updated.0, StatusCode::OK);
    assert_eq!(updated.1["automaticRollout"], false);
    assert!(updated.1.get("expectedAutomaticRollout").is_none());
    let stale = call(&app, "PUT", &enrollment, "owner", stale_rollback.clone()).await;
    assert_eq!(stale.0, StatusCode::CONFLICT);
    let current = call(&app, "GET", &enrollment, "owner", Value::Null).await.1;
    assert_eq!(current["automaticRollout"], false);
    assert_eq!(current["automaticRollback"], true);
    assert_eq!(current["authorizedBy"], "other-operator");
    stale_rollback["automaticRollout"] = json!(false);
    stale_rollback["expectedAutomaticRollout"] = json!(false);
    let applied = call(&app, "PUT", &enrollment, "owner", stale_rollback).await;
    assert_eq!(applied.0, StatusCode::OK);
    assert_eq!(applied.1["automaticRollout"], false);
    assert_eq!(applied.1["automaticRollback"], false);
    let edited = call(&app, "PUT", &enrollment, "owner", settings.clone()).await;
    assert_eq!(edited.0, StatusCode::OK);
    assert_eq!(edited.1["automaticRollout"], true);
    assert_eq!(edited.1["automaticRollback"], false);
    let mut settings = settings;
    settings["automaticRollback"] = json!(true);
    assert_eq!(
        call(&app, "PUT", &enrollment, "owner", settings.clone()).await,
        actual
    );
    let limited = call(&app, "GET", &enrollment, "outcome", Value::Null)
        .await
        .1;
    assert_eq!(limited["auditCount"], 1);
    assert_eq!(limited["remainingAudits"], 1);
    assert_eq!(limited["renewalRevision"], 0);
    assert!(limited.get("audits").is_none());

    let renew = format!("{enrollment}/renew");
    let mut audit = descriptor("more-audit");
    audit["datasetDigest"] = json!("a".repeat(64));
    audit["caseFingerprints"] = json!(["b".repeat(64)]);
    audit["familyFingerprints"] = json!(["c".repeat(64)]);
    let append = json!({"renewalId":Uuid::new_v4(),"expectedRevision":0,
                        "proposalAdmissions":100,"audits":[audit]});
    assert_eq!(
        call(&app, "POST", &renew, "outcome", append.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let competing = json!({"renewalId":Uuid::new_v4(),"expectedRevision":0,
                           "proposalAdmissions":1,"audits":[]});
    // A scheduler admission and renewal lock the same row. Commit an
    // admission while two requests contend for the same renewal revision.
    let mut reservation = db.begin().await.unwrap();
    sqlx::query("UPDATE connected_learning_enrollments SET proposal_admissions=1 WHERE project_id=$1 AND integration_id=$2")
        .bind(&p).bind(enrollment_id).execute(&mut *reservation).await.unwrap();
    let (first, second, ()) = tokio::join!(
        call(&app, "POST", &renew, "owner", append.clone()),
        call(&app, "POST", &renew, "owner", competing.clone()),
        async { reservation.commit().await.unwrap() }
    );
    let (applied, applied_body, stale_body) = if first.0 == StatusCode::OK {
        assert_eq!(second.0, StatusCode::CONFLICT, "{}", second.1);
        (first, append.clone(), competing)
    } else {
        assert_eq!(first.0, StatusCode::CONFLICT, "{}", first.1);
        assert_eq!(second.0, StatusCode::OK, "{}", second.1);
        (second, competing, append.clone())
    };
    assert_eq!(applied.1["proposalAdmissions"], 1);
    assert_eq!(applied.1["appliedRenewalRevision"], 1);
    assert_eq!(
        call(&app, "POST", &renew, "owner", applied_body.clone()).await,
        applied
    );
    let mut changed_retry = applied_body;
    changed_retry["proposalAdmissions"] = json!(0);
    changed_retry["audits"] = json!([descriptor("changed-retry")]);
    assert_eq!(
        call(&app, "POST", &renew, "owner", changed_retry).await.0,
        StatusCode::CONFLICT
    );
    let mut next = stale_body;
    next["expectedRevision"] = json!(1);
    let second_window = call(&app, "POST", &renew, "owner", next).await;
    assert_eq!(second_window.0, StatusCode::OK, "{}", second_window.1);
    assert_eq!(second_window.1["maxProposalAdmissions"], 103);
    assert_eq!(second_window.1["proposalAdmissions"], 1);
    let same_dataset = json!({"renewalId":Uuid::new_v4(),"expectedRevision":2,
                              "proposalAdmissions":0,"audits":[descriptor("audit")]});
    assert_eq!(
        call(&app, "POST", &renew, "owner", same_dataset).await.0,
        StatusCode::CONFLICT
    );
    for (field, fingerprint) in [
        ("datasetDigest", 'a'),
        ("caseFingerprints", 'b'),
        ("familyFingerprints", 'c'),
    ] {
        let mut sibling_settings = settings.clone();
        sibling_settings["audits"] = json!([descriptor("relabeled")]);
        let digest = fingerprint.to_string().repeat(64);
        sibling_settings["audits"][0][field] = if field == "datasetDigest" {
            json!(digest)
        } else {
            json!([digest])
        };
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("{sibling}/learning"),
                "owner",
                sibling_settings
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    let inspected = call(&app, "GET", &enrollment, "outcome", Value::Null)
        .await
        .1;
    assert_eq!(inspected["remainingAudits"], 2);
    assert_eq!(inspected["renewalRevision"], 2);
    let concurrent_audit = descriptor("bundle-wide-race");
    let concurrent_renewal = json!({"renewalId":Uuid::new_v4(),"expectedRevision":2,
        "proposalAdmissions":0,"audits":[concurrent_audit.clone()]});
    let mut concurrent_enrollment = settings;
    concurrent_enrollment["audits"] = json!([concurrent_audit]);
    let sibling_learning = format!("{sibling}/learning");
    let (left, right) = tokio::join!(
        call(&app, "POST", &renew, "owner", concurrent_renewal),
        call(
            &app,
            "PUT",
            &sibling_learning,
            "owner",
            concurrent_enrollment
        ),
    );
    assert!(
        (left.0 == StatusCode::OK && right.0 == StatusCode::CONFLICT)
            || (left.0 == StatusCode::CONFLICT && right.0 == StatusCode::OK),
        "Cohort race must have exactly one winner: {left:?}, {right:?}"
    );
    let owner_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM connected_learning_cohorts
         WHERE project_id=$1 AND bundle_id=$2 AND kind='dataset' AND identity='bundle-wide-race'",
    )
    .bind(&p)
    .bind(bundle)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(owner_count, 1);
    let mut read_tokens = vec![];
    for path in [&connection, &sibling] {
        let (status, token) = call(
            &app,
            "POST",
            &format!("{path}/credentials"),
            "owner",
            json!({"kind":"content-read"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        read_tokens.push(token["secret"].as_str().unwrap().to_owned());
    }
    let (_, receipt_token) = call(
        &app,
        "POST",
        &format!("{connection}/credentials"),
        "owner",
        json!({"kind":"receipt-write"}),
    )
    .await;
    let receipt_token = receipt_token["secret"].as_str().unwrap();

    let outcome = json!({"outcomeId":Uuid::new_v4(),"versionId":baseline,"digest":digest,
        "status":"completed","lesson":{"path":"guide.md","instruction":"Owner-approved correction"}});
    let outcomes = format!("{enrollment}/outcomes");
    for principal in [receipt_token, "evaluator"] {
        assert!(
            call(&app, "POST", &outcomes, principal, outcome.clone())
                .await
                .0
                .is_client_error()
        );
    }
    let accepted = call(&app, "POST", &outcomes, "outcome", outcome.clone()).await;
    assert_eq!(accepted.0, StatusCode::OK, "{}", accepted.1);
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", outcome.clone()).await,
        accepted
    );
    let mut changed = outcome.clone();
    changed["lesson"]["instruction"] = json!("changed");
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", changed).await.0,
        StatusCode::CONFLICT
    );
    let graded = json!({"outcomeId":Uuid::new_v4(),"versionId":baseline,"digest":digest,
        "status":"failed","feedback":{"expected":"Reconcile item","observed":"Repeated payment"}});
    let graded = call(&app, "POST", &outcomes, "outcome", graded).await;
    assert_eq!(graded.0, StatusCode::OK);
    assert_eq!(graded.1["eligible"], true);
    // Old submitters lacked a delivery epoch. Recover their observations only after
    // the trusted evaluator checks the private job on the exact active delivery.
    let corrections = format!("{enrollment}/corrections");
    let rechecks = format!("{enrollment}/rechecks");
    let completed = json!({"outcomeId":Uuid::new_v4(),"versionId":baseline,"digest":digest,"status":"completed"});
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", completed.clone())
            .await
            .0,
        StatusCode::OK
    );
    let correction_id = Uuid::new_v4();
    let correction = json!({"outcomeId":completed["outcomeId"],"correctionId":correction_id,"feedback":{"observed":"A","expected":"B"}});
    assert_eq!(
        call(&app, "POST", &corrections, "evaluator", correction.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let receipt = call(&app, "POST", &corrections, "outcome", correction.clone()).await;
    assert_eq!(receipt.0, StatusCode::OK, "{}", receipt.1);
    assert_eq!(
        call(&app, "POST", &corrections, "outcome", correction.clone()).await,
        receipt
    );
    let mut changed = correction.clone();
    changed["feedback"]["expected"] = json!("different");
    assert_eq!(
        call(&app, "POST", &corrections, "outcome", changed).await.0,
        StatusCode::CONFLICT
    );
    let work = call(
        &app,
        "GET",
        &format!("{enrollment}/work"),
        "evaluator",
        Value::Null,
    )
    .await
    .1;
    assert!(
        work["rechecks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|job| job["correctionId"] == json!(correction_id) && job["revision"] == "1")
    );
    let recheck = json!({"correctionId":correction_id,"versionId":baseline,"revision":"1","digest":digest,"verdict":"reproduced"});
    assert_eq!(
        call(&app, "POST", &rechecks, "outcome", recheck.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut wrong = recheck.clone();
    wrong["revision"] = json!("2");
    assert_eq!(
        call(&app, "POST", &rechecks, "evaluator", wrong).await.0,
        StatusCode::CONFLICT
    );
    let verdict = call(&app, "POST", &rechecks, "evaluator", recheck.clone()).await;
    assert_eq!(verdict.0, StatusCode::OK, "{}", verdict.1);
    assert_eq!(
        call(&app, "POST", &rechecks, "evaluator", recheck).await,
        verdict
    );
    let action:String=sqlx::query_scalar("SELECT action FROM connected_learning_correction_work WHERE project_id=$1 AND correction_id=$2")
        .bind(&p).bind(correction_id).fetch_one(&db).await.unwrap();
    assert_eq!(action, "ready");
    let development_id = Uuid::new_v4();
    let audit_id = Uuid::new_v4();
    let development_comparison = Uuid::new_v4();
    let audit_comparison = Uuid::new_v4();
    for (request, comparison, cohort) in [
        (
            development_id,
            development_comparison,
            "ordinary-development-case",
        ),
        (audit_id, audit_comparison, "private-audit-case"),
    ] {
        let mut controls = descriptor(cohort);
        controls.as_object_mut().unwrap().retain(|key, _| {
            matches!(
                key.as_str(),
                "datasetRevision" | "runtime" | "graderRevision" | "expectedCases"
            )
        });
        controls["parentVersionId"] = json!(baseline);
        controls["parentDigest"] = json!(digest);
        controls["candidateVersionId"] = json!(replacement);
        controls["candidateDigest"] = json!(digest);
        sqlx::query("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status) VALUES($1,$2,$3,$4,'owner','requested')")
            .bind(request).bind(&p).bind(bundle).bind(&controls).execute(&db).await.unwrap();
        controls["evaluation"] = json!({"requestId":request,"attemptId":Uuid::new_v4()});
        controls["results"] = json!([]);
        sqlx::query("INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter) VALUES($1,$2,$3,$4,true,'evaluator')")
            .bind(comparison).bind(&p).bind(bundle).bind(controls).execute(&db).await.unwrap();
    }
    let proposal = Uuid::new_v4();
    sqlx::query("INSERT INTO proposals(id,project_id,bundle_id,parent_version_id,request,status) VALUES($1,$2,$3,$4,'{}','succeeded')")
        .bind(proposal).bind(&p).bind(bundle).bind(baseline).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO connected_learning_rounds(project_id,bundle_id,integration_id,id,outcome_id,parent_version_id,parent_revision,proposal_id,candidate_version_id,development_request_id,development_comparison_id,audit_index,audit_request_id,state,correction_id,attempt) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,0,$11,'audit',$5,1)")
        .bind(&p).bind(bundle).bind(enrollment_id).bind(Uuid::new_v4())
        .bind(Uuid::parse_str(outcome["outcomeId"].as_str().unwrap()).unwrap()).bind(baseline)
        .bind(proposal).bind(replacement).bind(development_id).bind(development_comparison).bind(audit_id)
        .execute(&db).await.unwrap();

    let bundle_path = format!("/v1/projects/{p}/bundles/{bundle}");
    for (path, visible_id, audit_id) in [
        ("evaluation-requests", development_id, audit_id),
        ("comparisons", development_comparison, audit_comparison),
    ] {
        let collection = format!("{bundle_path}/{path}");
        let private = format!("{collection}/{audit_id}");
        assert_eq!(
            call(&app, "GET", &private, "outcome", Value::Null).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&app, "GET", &private, "observer", Value::Null).await.0,
            StatusCode::NOT_FOUND
        );
        for authorized in ["evaluator", "owner"] {
            assert_eq!(
                call(&app, "GET", &private, authorized, Value::Null).await.0,
                StatusCode::OK
            );
        }
        let page = call(
            &app,
            "GET",
            &format!("{collection}?limit=1"),
            "outcome",
            Value::Null,
        )
        .await;
        assert_eq!(page.0, StatusCode::OK, "{}", page.1);
        assert_eq!(page.1["items"][0]["id"], visible_id.to_string());
        assert!(page.1["nextCursor"].is_null());
    }
    let progress = format!("{bundle_path}/evaluation-requests/{audit_id}/progress");
    assert_eq!(
        call(&app, "GET", &progress, "outcome", Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", &progress, "evaluator", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let work = format!("{enrollment}/work");
    assert_eq!(
        call(&app, "GET", &work, "outcome", Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", &work, "evaluator", Value::Null).await.1["active"],
        true
    );

    let private_channel = format!("learn-{enrollment_id}");
    sqlx::query(
        "UPDATE channels SET revision=2,version_id=$4 WHERE (project_id,bundle_id,name)=($1,$2,$3)",
    )
    .bind(&p)
    .bind(bundle)
    .bind(&private_channel)
    .bind(replacement)
    .execute(&db)
    .await
    .unwrap();
    let promotion = Uuid::new_v4();
    sqlx::query("INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,previous_version_id,comparison_id,reviewer) VALUES($1,$2,$3,$4,2,$5,$6,$7,'fixture')")
        .bind(promotion).bind(&p).bind(bundle).bind(&private_channel).bind(replacement)
        .bind(baseline).bind(audit_comparison).execute(&db).await.unwrap();
    sqlx::query("UPDATE connected_learning_rounds SET state='promoted',promotion_id=$1,audit_comparison_id=$2 WHERE project_id=$3 AND integration_id=$4")
        .bind(promotion).bind(audit_comparison).bind(&p).bind(enrollment_id).execute(&db).await.unwrap();

    let receipt_route = format!("{connection}/receipts");
    let stale_id = Uuid::new_v4();
    let started = Uuid::new_v4();
    let timestamp = chrono::Utc::now();
    for (id, stale) in [(stale_id, true), (started, false)] {
        let accepted = call(&app, "POST", &receipt_route, receipt_token, json!({
            "eventId":id,"integrationId":enrollment_id,"projectId":p,"bundleId":bundle,
            "channel":"stable","revision":"2","versionId":replacement,"digest":digest,
            "stage":"started","occurredAt":timestamp,"resolvedAt":timestamp,"stale":stale,"source":"network",
        })).await;
        assert_eq!(accepted.0, StatusCode::OK, "{}", accepted.1);
    }
    let mut field_outcome = json!({
        "outcomeId":Uuid::new_v4(),"versionId":replacement,"digest":digest,"status":"completed",
        "startedReceiptId":stale_id,"deliveryRevision":"2",
    });
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", field_outcome.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    field_outcome["startedReceiptId"] = json!(started);
    field_outcome["deliveryRevision"] = json!("1");
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", field_outcome.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    field_outcome["deliveryRevision"] = json!("2");
    let accepted = call(&app, "POST", &outcomes, "outcome", field_outcome.clone()).await;
    assert_eq!(accepted.0, StatusCode::OK, "{}", accepted.1);
    assert_eq!(accepted.1["eligible"], false);
    assert_eq!(
        accepted.1["fieldAudit"]["parentVersionId"],
        baseline.to_string()
    );
    assert_eq!(accepted.1["fieldAudit"]["parentDigest"], digest);
    let mut duplicate = field_outcome.clone();
    duplicate["outcomeId"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", duplicate).await.0,
        StatusCode::CONFLICT
    );
    sqlx::query("DELETE FROM integration_receipts WHERE integration_id=$1 AND event_id=$2")
        .bind(enrollment_id)
        .bind(started)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", field_outcome).await,
        accepted
    );
    let channels = format!("/v1/projects/{p}/bundles/{bundle}/channels");
    let resolve = format!("{channels}/stable");
    assert_eq!(
        call(&app, "GET", &resolve, &read_tokens[0], Value::Null)
            .await
            .1["version"]["id"],
        replacement.to_string()
    );
    assert_eq!(
        call(&app, "GET", &resolve, &read_tokens[1], Value::Null)
            .await
            .1["version"]["id"],
        baseline.to_string()
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{channels}/{private_channel}"),
            "owner",
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let content = format!("/v1/projects/{p}/bundles/{bundle}/versions/{replacement}/payload");
    assert_eq!(
        call(&app, "GET", &content, &read_tokens[0], Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &content, &read_tokens[1], Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{enrollment}/stop"),
            "owner",
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &work, "evaluator", Value::Null).await.1["active"],
        false
    );
    let mut fresh = outcome;
    fresh["outcomeId"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&app, "POST", &outcomes, "outcome", fresh).await.0,
        StatusCode::CONFLICT
    );

    // A stopped enrollment still serves its private channel and supports reviewed recovery.
    let restore = format!("{enrollment}/restore");
    let reviewed = json!({
        "restoreId":Uuid::new_v4(), "expectedRevision":"2", "reason":"Restore previously reviewed instructions",
        "target":{"kind":"delivery", "versionId":baseline, "revision":"1"}
    });
    let available = call(&app, "GET", &enrollment, "owner", Value::Null).await.1;
    assert!(
        available["restoreTargets"]
            .as_array()
            .unwrap()
            .contains(&reviewed["target"])
    );
    for forbidden in ["outcome", "evaluator", "observer"] {
        assert_eq!(
            call(&app, "POST", &restore, forbidden, reviewed.clone())
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let (restored, concurrent_retry) = tokio::join!(
        call(&app, "POST", &restore, "owner", reviewed.clone()),
        call(&app, "POST", &restore, "owner", reviewed.clone()),
    );
    assert_eq!(restored.0, StatusCode::OK, "{}", restored.1);
    assert_eq!(concurrent_retry, restored);
    assert_eq!(restored.1["revision"], "3");
    assert_eq!(restored.1["version"]["id"], baseline.to_string());
    let mut refresh = json!({
        "restoreId":Uuid::new_v4(), "expectedRevision":"3", "reason":"Adopt an operator-reviewed source correction",
        "target":{"kind":"source", "revision":"1", "versionId":replacement}
    });
    let published = call(&app, "POST", &format!("{resolve}/promotions"), "owner",
        json!({"expectedRevision":"1","versionId":replacement,"unevaluatedReason":"Reviewed source update"})).await;
    assert_eq!(published.0, StatusCode::CREATED, "{}", published.1);
    assert_eq!(
        call(&app, "POST", &restore, "owner", refresh.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    refresh["target"]["revision"] = json!("2");
    let updated = call(&app, "POST", &restore, "owner", refresh).await;
    assert_eq!(updated.0, StatusCode::OK, "{}", updated.1);
    assert_eq!(updated.1["revision"], "4");
    assert_eq!(
        call(&app, "POST", &restore, "owner", reviewed.clone()).await,
        restored
    );
    let mut reused = reviewed.clone();
    reused["reason"] = json!("different review");
    assert_eq!(
        call(&app, "POST", &restore, "owner", reused).await.0,
        StatusCode::CONFLICT
    );
    let mut stale = reviewed;
    stale["restoreId"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&app, "POST", &restore, "owner", stale).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "GET", &work, "evaluator", Value::Null).await.1["active"],
        false
    );
}
