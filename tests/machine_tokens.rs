mod common;
use acclimate_service::{AppState, Grant, abandon_inactive_evaluations, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

/// A bearer is either a machine token or a console session secret.
enum As<'a> {
    Machine(&'a str),
    Browser(&'a str),
}

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    who: As<'_>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("idempotency-key", Uuid::new_v4().to_string())
        .header("content-type", "application/json");
    request = match who {
        As::Machine(token) => request.header("authorization", format!("Bearer {token}")),
        As::Browser(session) => request
            .header("authorization", format!("Bearer {}", common::CONSOLE_TOKEN))
            .header("x-acclimate-session", session),
    };
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(if method == "GET" {
                    String::new()
                } else {
                    body.to_string()
                }))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2_097_152).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct Fixture {
    db: sqlx::PgPool,
    app: axum::Router,
    project: String,
    other: String,
    bundle: Uuid,
    parent: Uuid,
    candidate: Uuid,
    admin: String,
    editor: String,
}

async fn session(db: &sqlx::PgPool, project: &str, role: &str) -> String {
    let user = Uuid::new_v4();
    let secret = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,issuer,subject) VALUES($1,'https://fixture.example',$2)")
        .bind(user)
        .bind(user.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,$3)")
        .bind(project)
        .bind(user)
        .bind(role)
        .execute(db)
        .await
        .unwrap();
    let hash = format!("sha256:{}", hex::encode(Sha256::digest(secret.as_bytes())));
    sqlx::query("INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(hash).bind(user).execute(db).await.unwrap();
    secret
}

async fn fixture() -> Fixture {
    let db = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    let project = format!("tokens-{}", Uuid::new_v4());
    let other = format!("tokens-{}", Uuid::new_v4());
    for p in [&project, &other] {
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1)")
            .bind(p)
            .execute(&db)
            .await
            .unwrap();
    }
    let bundle = Uuid::new_v4();
    let parent = Uuid::new_v4();
    let candidate = Uuid::new_v4();
    sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,$2,'token test')")
        .bind(bundle)
        .bind(&project)
        .execute(&db)
        .await
        .unwrap();
    let payload = include_bytes!("../contracts/fixtures/bundle-v1.json").to_vec();
    for (id, base, digest) in [
        (parent, None, "parent"),
        (candidate, Some(parent), "candidate"),
    ] {
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,'fixture-author')")
            .bind(id).bind(&project).bind(bundle).bind(base).bind(digest).bind(&payload).execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,'stable',1,$3)")
        .bind(&project).bind(bundle).bind(parent).execute(&db).await.unwrap();
    let admin = session(&db, &project, "admin").await;
    let editor = session(&db, &project, "editor").await;
    let grants = vec![
        Grant {
            token: "static-evaluate".into(),
            principal_id: "static-evaluator".into(),
            project_id: project.clone(),
            rights: vec!["evaluate".into()],
        },
        Grant {
            token: "static-writer".into(),
            principal_id: "static-writer".into(),
            project_id: project.clone(),
            rights: vec!["read".into(), "write".into(), "promote".into()],
        },
    ];
    let app = router(AppState {
        access: common::access(),
        runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
        db: db.clone(),
        grants: Arc::new(grants),
        provider: None,
    });
    Fixture {
        db,
        app,
        project,
        other,
        bundle,
        parent,
        candidate,
        admin,
        editor,
    }
}

impl Fixture {
    fn identity(&self) -> Value {
        json!({"parentVersionId":self.parent,"parentDigest":"parent","candidateVersionId":self.candidate,"candidateDigest":"candidate","datasetRevision":"fixtures-v1","runtime":{"model":"fixture"},"graderRevision":"grader-v1","expectedCases":[{"caseId":"a","repetition":0}]})
    }
    fn root(&self) -> String {
        format!("/v1/workspaces/{}/bundles/{}", self.project, self.bundle)
    }
    async fn request(&self, who: As<'_>) -> String {
        let (s, e) = call(
            &self.app,
            "POST",
            &format!("{}/evaluation-requests", self.root()),
            who,
            self.identity(),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED, "{e}");
        format!(
            "{}/evaluation-requests/{}",
            self.root(),
            e["id"].as_str().unwrap()
        )
    }
    fn report(&self, request: &str, attempt: &str) -> Value {
        let outcome = json!({"executionStatus":"completed","gradingStatus":"scored","reward":1});
        let mut comparison = self.identity();
        comparison["results"] =
            json!([{"caseId":"a","repetition":0,"parent":outcome,"candidate":outcome}]);
        comparison["evaluation"] =
            json!({"requestId":request.rsplit('/').next().unwrap(),"attemptId":attempt});
        comparison
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn admins_issue_rotate_and_revoke_narrow_evaluator_tokens_without_restart() {
    let f = fixture().await;
    let tokens = format!("/v1/workspaces/{}/machine-tokens", f.project);
    // Only workspace admins administer tokens; machine credentials never do.
    for who in [As::Browser(&f.editor), As::Machine("static-writer")] {
        assert_eq!(
            call(&f.app, "GET", &tokens, who, Value::Null).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &f.app,
            "POST",
            &tokens,
            As::Browser(&f.editor),
            json!({"name":"ci"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for body in [
        json!({"name":"CI"}),
        json!({"name":"ci","rights":["admin"]}),
        json!({"name":"ci","expiresInDays":400}),
        json!({"name":"ci","rights":[]}),
    ] {
        assert_eq!(
            call(&f.app, "POST", &tokens, As::Browser(&f.admin), body)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (s, issued) = call(
        &f.app,
        "POST",
        &tokens,
        As::Browser(&f.admin),
        json!({"name":"ci","reason":"GitHub Actions evaluator"}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{issued}");
    let secret = issued["secret"].as_str().unwrap().to_owned();
    assert!(secret.starts_with("acm_"));
    assert_eq!(issued["token"]["rights"], json!(["evaluate"]));
    assert_eq!(issued["token"]["principalId"], "machine:ci");
    assert_eq!(issued["token"]["status"], "active");
    let token_id = issued["token"]["id"].as_str().unwrap().to_owned();
    // The secret is never stored or listed; only its digest is persisted.
    let (s, listed) = call(&f.app, "GET", &tokens, As::Browser(&f.admin), Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!listed.to_string().contains(&secret));
    assert_eq!(listed["items"][0]["secretPrefix"], &secret[..12]);
    let stored: String =
        sqlx::query_scalar("SELECT secret_hash FROM machine_tokens WHERE id=$1::uuid")
            .bind(&token_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_ne!(stored, secret);

    // The capability snapshot reports the narrow right.
    let caps = format!("/v1/workspaces/{}/evaluation-capabilities", f.project);
    let (s, c) = call(&f.app, "GET", &caps, As::Machine(&secret), Value::Null).await;
    assert_eq!(s, StatusCode::OK, "{c}");
    assert_eq!(c["principalId"], "machine:ci");
    assert_eq!(c["writeEvaluation"], true);
    assert_eq!(
        c["rights"],
        json!({"read":true,"evaluate":true,"write":false,"propose":false,"promote":false})
    );
    assert_eq!(c["credential"]["kind"], "machineToken");
    assert!(c["abandonment"]["inactivitySeconds"].as_u64().unwrap() >= 60);
    let (_, c) = call(
        &f.app,
        "GET",
        &caps,
        As::Machine("static-writer"),
        Value::Null,
    )
    .await;
    assert_eq!(c["rights"]["write"], true);
    assert_eq!(c["rights"]["evaluate"], true);
    assert_eq!(c["credential"]["kind"], "static");

    // Evaluate runs a whole evaluation and reads what it needs.
    let request = f.request(As::Machine(&secret)).await;
    let (s, v) = call(
        &f.app,
        "POST",
        &format!("{request}/start"),
        As::Machine(&secret),
        json!({"attemptId":"one"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(v["lastActivityAt"].is_string());
    let (s, v) = call(
        &f.app,
        "GET",
        &format!("{}/versions/{}", f.root(), f.candidate),
        As::Machine(&secret),
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");

    // Rotation keeps the principal, so the successor finishes the in-flight attempt.
    let (s, rotated) = call(
        &f.app,
        "POST",
        &format!("{tokens}/{token_id}/rotate"),
        As::Browser(&f.admin),
        json!({"reason":"scheduled"}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{rotated}");
    let successor = rotated["secret"].as_str().unwrap().to_owned();
    assert_eq!(rotated["token"]["principalId"], "machine:ci");
    assert_eq!(rotated["token"]["rotatedFrom"], json!(token_id));
    assert_eq!(rotated["previous"]["status"], "revoked");
    assert_eq!(
        call(&f.app, "GET", &caps, As::Machine(&secret), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (s, c) = call(
        &f.app,
        "POST",
        &format!("{}/comparisons", f.root()),
        As::Machine(&successor),
        f.report(&request, "one"),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{c}");
    let (s, v) = call(
        &f.app,
        "POST",
        &format!("{request}/finish"),
        As::Machine(&successor),
        json!({"attemptId":"one","comparisonId":c["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "completed");

    // Evaluate never publishes, promotes, authors versions or changes channels.
    let promote = format!("{}/channels/stable/releases", f.root());
    let release = json!({"versionId":f.candidate,"expectedRevision":"1","comparisonId":c["id"]});
    for who in [As::Machine(&successor), As::Machine("static-evaluate")] {
        assert_eq!(
            call(&f.app, "POST", &promote, who, release.clone()).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let payload: Value =
        serde_json::from_slice(include_bytes!("../contracts/fixtures/bundle-v1.json")).unwrap();
    let (s, _) = call(
        &f.app,
        "POST",
        &format!("{}/versions", f.root()),
        As::Machine(&successor),
        json!({"parentVersionId":f.parent,"payload":payload}),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, draft) = call(
        &f.app,
        "POST",
        &format!("{}/channels/stable/drafts", f.root()),
        As::Machine(&successor),
        json!({"baseVersionId":f.parent,"baseRevision":"1","payload":payload}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{draft}");
    let draft_path = format!(
        "{}/channels/stable/drafts/{}",
        f.root(),
        draft["id"].as_str().unwrap()
    );
    for action in ["publish", "discard"] {
        let body = if action == "publish" {
            json!({"expectedGeneration":1,"expectedRevision":"1","unevaluatedReason":"no"})
        } else {
            json!({"expectedGeneration":1})
        };
        assert_eq!(
            call(
                &f.app,
                "POST",
                &format!("{draft_path}/{action}"),
                As::Machine(&successor),
                body
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    // A workspace token never crosses workspaces.
    assert_eq!(
        call(
            &f.app,
            "GET",
            &format!("/v1/workspaces/{}/evaluation-capabilities", f.other),
            As::Machine(&successor),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    // Static grants may also use the narrow right.
    let static_request = f.request(As::Machine("static-evaluate")).await;
    assert!(static_request.contains("/evaluation-requests/"));

    // Revocation applies to the next request, without a restart, and is idempotent.
    let successor_id = rotated["token"]["id"].as_str().unwrap();
    for _ in 0..2 {
        let (s, v) = call(
            &f.app,
            "POST",
            &format!("{tokens}/{successor_id}/revoke"),
            As::Browser(&f.admin),
            json!({"reason":"CI moved"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["token"]["status"], "revoked");
        assert_eq!(v["token"]["revokeReason"], "CI moved");
    }
    assert_eq!(
        call(&f.app, "GET", &caps, As::Machine(&successor), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{tokens}/{successor_id}/rotate"),
            As::Browser(&f.admin),
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    // Expired tokens stop working; an overlapping rotation keeps the old token briefly.
    let (_, short) = call(
        &f.app,
        "POST",
        &tokens,
        As::Browser(&f.admin),
        json!({"name":"nightly","rights":["read"],"expiresInDays":1}),
    )
    .await;
    let short_secret = short["secret"].as_str().unwrap().to_owned();
    let short_id = short["token"]["id"].as_str().unwrap().to_owned();
    let (_, overlap) = call(
        &f.app,
        "POST",
        &format!("{tokens}/{short_id}/rotate"),
        As::Browser(&f.admin),
        json!({"overlapSeconds":600}),
    )
    .await;
    assert_eq!(overlap["previous"]["status"], "active");
    assert_eq!(overlap["token"]["rights"], json!(["read"]));
    assert_eq!(
        call(
            &f.app,
            "GET",
            &format!("{}/versions/{}", f.root(), f.parent),
            As::Machine(&short_secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE machine_tokens SET expires_at=created_at+interval '1 millisecond' WHERE id=$1::uuid")
        .bind(&short_id).execute(&f.db).await.unwrap();
    assert_eq!(
        call(
            &f.app,
            "GET",
            &format!("{}/versions/{}", f.root(), f.parent),
            As::Machine(&short_secret),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // A read-only token cannot evaluate.
    let read_only = overlap["secret"].as_str().unwrap();
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{}/evaluation-requests", f.root()),
            As::Machine(read_only),
            f.identity()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // The audit trail records every change, never a secret.
    let (s, events) = call(
        &f.app,
        "GET",
        &format!("/v1/workspaces/{}/machine-token-events", f.project),
        As::Browser(&f.admin),
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let actions: Vec<_> = events["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        [
            "issued", "rotated", "issued", "revoked", "issued", "rotated", "issued"
        ]
    );
    assert!(!events.to_string().contains("acm_"));
    assert!(
        sqlx::query("DELETE FROM machine_token_events WHERE project_id=$1")
            .bind(&f.project)
            .execute(&f.db)
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn abandoned_attempts_are_fenced_and_their_evidence_never_counts() {
    let f = fixture().await;
    let evaluator = As::Machine("static-evaluate");
    // An explicit abandonment records who and why, and fences the old attempt.
    let request = f.request(As::Machine("static-evaluate")).await;
    call(
        &f.app,
        "POST",
        &format!("{request}/start"),
        As::Machine("static-evaluate"),
        json!({"attemptId":"cancelled-job"}),
    )
    .await;
    // The report reached the service, but the job was cancelled before finishing.
    let (s, early) = call(
        &f.app,
        "POST",
        &format!("{}/comparisons", f.root()),
        As::Machine("static-evaluate"),
        f.report(&request, "cancelled-job"),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{early}");
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{request}/abandon"),
            evaluator,
            json!({"reason":""})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for _ in 0..2 {
        let (s, v) = call(
            &f.app,
            "POST",
            &format!("{request}/abandon"),
            As::Browser(&f.editor),
            json!({"reason":"CI job cancelled"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["status"], "abandoned");
        assert_eq!(v["error"], "CI job cancelled");
        assert!(v["abandonedBy"].as_str().unwrap().starts_with("user:"));
        assert!(v["abandonedAt"].is_string());
    }
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{request}/abandon"),
            As::Machine("static-evaluate"),
            json!({"reason":"other"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for (action, body) in [
        (
            "finish",
            json!({"attemptId":"cancelled-job","comparisonId":early["id"]}),
        ),
        ("start", json!({"attemptId":"cancelled-job"})),
        (
            "progress",
            json!({"attemptId":"cancelled-job","sequence":1,"phase":"executing","completed":1,"total":2}),
        ),
    ] {
        assert_eq!(
            call(
                &f.app,
                "POST",
                &format!("{request}/{action}"),
                As::Machine("static-evaluate"),
                body
            )
            .await
            .0,
            StatusCode::CONFLICT,
            "{action}"
        );
    }
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{}/comparisons", f.root()),
            As::Machine("static-evaluate"),
            f.report(&request, "cancelled-job")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let promote = format!("{}/channels/stable/releases", f.root());
    let (s, v) = call(
        &f.app,
        "POST",
        &promote,
        As::Machine("static-writer"),
        json!({"versionId":f.candidate,"expectedRevision":"1","comparisonId":early["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "evidence_abandoned");

    // A new attempt for the same candidate content may start and settle.
    let retry = f.request(As::Machine("static-evaluate")).await;
    call(
        &f.app,
        "POST",
        &format!("{retry}/start"),
        As::Machine("static-evaluate"),
        json!({"attemptId":"retry"}),
    )
    .await;
    let (_, c) = call(
        &f.app,
        "POST",
        &format!("{}/comparisons", f.root()),
        As::Machine("static-evaluate"),
        f.report(&retry, "retry"),
    )
    .await;
    let (s, v) = call(
        &f.app,
        "POST",
        &format!("{retry}/finish"),
        As::Machine("static-evaluate"),
        json!({"attemptId":"retry","comparisonId":c["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        call(
            &f.app,
            "POST",
            &format!("{retry}/abandon"),
            As::Machine("static-evaluate"),
            json!({"reason":"late"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (s, v) = call(
        &f.app,
        "POST",
        &promote,
        As::Machine("static-writer"),
        json!({"versionId":f.candidate,"expectedRevision":"1","comparisonId":c["id"]}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");

    // Inactivity abandons stale unmanaged attempts only.
    let stale = f.request(As::Machine("static-evaluate")).await;
    let fresh = f.request(As::Machine("static-evaluate")).await;
    for (path, attempt) in [(&stale, "stale"), (&fresh, "fresh")] {
        call(
            &f.app,
            "POST",
            &format!("{path}/start"),
            As::Machine("static-evaluate"),
            json!({"attemptId":attempt}),
        )
        .await;
    }
    let id = |path: &str| Uuid::parse_str(path.rsplit('/').next().unwrap()).unwrap();
    sqlx::query("UPDATE evaluation_requests SET last_activity_at=now()-interval '2 hours',started_at=now()-interval '2 hours' WHERE id=$1")
        .bind(id(&stale)).execute(&f.db).await.unwrap();
    let managed = Uuid::new_v4();
    sqlx::query("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status,evaluator_principal,attempt_id,started_at,last_activity_at) VALUES($1,$2,$3,$4,'service:connected-learning','running','static-evaluator','managed',now()-interval '2 hours',now()-interval '2 hours')")
        .bind(managed).bind(&f.project).bind(f.bundle).bind(f.identity()).execute(&f.db).await.unwrap();
    assert!(abandon_inactive_evaluations(&f.db, 3600).await.unwrap() >= 1);
    let (_, v) = call(
        &f.app,
        "GET",
        &stale,
        As::Machine("static-evaluate"),
        Value::Null,
    )
    .await;
    assert_eq!(v["status"], "abandoned");
    assert_eq!(v["abandonedBy"], "service:evaluation-expiry");
    let (_, v) = call(
        &f.app,
        "GET",
        &fresh,
        As::Machine("static-evaluate"),
        Value::Null,
    )
    .await;
    assert_eq!(v["status"], "running");
    let status: String = sqlx::query_scalar("SELECT status FROM evaluation_requests WHERE id=$1")
        .bind(managed)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(status, "running");
    // Managed requests are never abandoned through the API either.
    let managed_path = format!("{}/evaluation-requests/{managed}", f.root());
    let (s, v) = call(
        &f.app,
        "POST",
        &format!("{managed_path}/abandon"),
        As::Machine("static-evaluate"),
        json!({"reason":"no"}),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "managed_evaluation");
}
