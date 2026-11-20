mod common;
use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::Digest;
use std::{collections::HashSet, sync::Arc};
use tower::ServiceExt;
use uuid::Uuid;

struct Harness {
    app: axum::Router,
    db: sqlx::PgPool,
    project: String,
}
impl Harness {
    async fn new() -> Self {
        let url = common::database_url();
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(12)
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        let project = format!("contract-{}", Uuid::new_v4());
        let grants = vec![
            Grant {
                token: "rw".into(),
                principal_id: format!("principal-{}", Uuid::new_v4()),
                project_id: project.clone(),
                rights: vec![
                    "read".into(),
                    "write".into(),
                    "promote".into(),
                    "propose".into(),
                ],
            },
            Grant {
                token: "write-only".into(),
                principal_id: "writer".into(),
                project_id: project.clone(),
                rights: vec!["write".into()],
            },
            Grant {
                token: "read".into(),
                principal_id: format!("reader-{}", Uuid::new_v4()),
                project_id: project.clone(),
                rights: vec!["read".into()],
            },
        ];
        Self {
            app: router(AppState {
                access: common::access(),
                runtime: Arc::new(acclimate_service::RuntimeStatus::new()),
                db: db.clone(),
                grants: Arc::new(grants),
                provider: None,
            }),
            db,
            project,
        }
    }
    async fn req(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        key: Option<&str>,
        body: Value,
        extra: Option<(&str, &str)>,
    ) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        if let Some(k) = key {
            b = b.header("idempotency-key", k);
        }
        if method == "POST" {
            b = b.header("content-type", "application/json");
        }
        if let Some((k, v)) = extra {
            b = b.header(k, v);
        }
        let r = self
            .app
            .clone()
            .oneshot(
                b.body(Body::from(if body.is_null() {
                    String::new()
                } else {
                    body.to_string()
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let status = r.status();
        let headers = r.headers().clone();
        let bytes = to_bytes(r.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, bytes, headers)
    }
    fn root(&self) -> String {
        format!("/v1/workspaces/{}/bundles", self.project)
    }
    async fn bundle(&self) -> String {
        let (s, b, _) = self
            .req(
                "POST",
                &self.root(),
                Some("rw"),
                Some(&format!("b-{}", Uuid::new_v4())),
                json!({"name":"bundle"}),
                None,
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
        serde_json::from_slice::<Value>(&b).unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    async fn version(&self, bundle: &str, parent: Value, text: &str, key: &str) -> Value {
        let req = json!({"parentVersionId":parent,"payload":{"schemaVersion":1,"files":[{"path":"guide.md","kind":"instruction","text":text}]}});
        let (s, b, _) = self
            .req(
                "POST",
                &format!("{}/{bundle}/versions", self.root()),
                Some("rw"),
                Some(key),
                req,
                None,
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
        serde_json::from_slice(&b).unwrap()
    }
}
fn err_code(bytes: &[u8]) -> String {
    serde_json::from_slice::<Value>(bytes).unwrap()["error"]["code"]
        .as_str()
        .unwrap_or("")
        .into()
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn scope_payload_bytes_and_validation_contract() {
    let h = Harness::new().await;
    let bundle = h.bundle().await;
    let base = format!("{}/{bundle}", h.root());
    let (s, _, _) = h
        .req(
            "POST",
            &h.root(),
            Some("read"),
            Some("no-write"),
            json!({"name":"x"}),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _, _) = h
        .req(
            "POST",
            &h.root(),
            None,
            Some("no-auth"),
            json!({"name":"x"}),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let v = h.version(&bundle, Value::Null, "hello", "payload-1").await;
    let uri = format!("{}/versions/{}/payload", base, v["id"].as_str().unwrap());
    let (s, bytes, _) = h
        .req("GET", &uri, Some("read"), None, Value::Null, None)
        .await;
    let expected=b"{\"schemaVersion\":1,\"files\":[{\"path\":\"guide.md\",\"kind\":\"instruction\",\"text\":\"hello\"}]}\n";
    assert_eq!(s, StatusCode::OK);
    assert_eq!(bytes, expected);
    let digest = format!("sha256:{}", hex::encode(sha2::Sha256::digest(expected)));
    assert_eq!(v["digest"], digest);
    let invalids = [
        json!({"parentVersionId":null,"payload":{"schemaVersion":2,"files":[{"path":"a","kind":"instruction","text":"x"}]}}),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"../a","kind":"instruction","text":"x"}]}}),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"CON.txt","kind":"instruction","text":"x"}]}}),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"a","kind":"bad","text":"x"}]}}),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"a","kind":"instruction","text":"x"},{"path":"A","kind":"instruction","text":"y"}]}}),
        json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"a","kind":"instruction","text":"x"}]},"unexpected":true}),
    ];
    for (i, body) in invalids.into_iter().enumerate() {
        let (s, b, _) = h
            .req(
                "POST",
                &format!("{}/{bundle}/versions", h.root()),
                Some("rw"),
                Some(&format!("invalid-{i}")),
                body,
                None,
            )
            .await;
        assert_eq!(
            s,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&b)
        );
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn idempotency_replay_conflict_distinct_paths_and_parallel_duplicates() {
    let h = Harness::new().await;
    let bundle = h.bundle().await;
    let uri = format!("{}/{bundle}/versions", h.root());
    let body = json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"a","kind":"skill","text":"x"}]}});
    let (s, b, _) = h
        .req(
            "POST",
            &uri,
            Some("rw"),
            Some("same-key"),
            body.clone(),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, b2, _) = h
        .req(
            "POST",
            &uri,
            Some("rw"),
            Some("same-key"),
            body.clone(),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(b, b2, "replay must return stored response bytes");
    let changed = json!({"parentVersionId":null,"payload":{"schemaVersion":1,"files":[{"path":"a","kind":"skill","text":"changed"}]}});
    let (s, b, _) = h
        .req("POST", &uri, Some("rw"), Some("same-key"), changed, None)
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(err_code(&b), "idempotency_conflict");
    let bundle2 = h.bundle().await;
    let uri2 = format!("{}/{bundle2}/versions", h.root());
    let (s, _, _) = h
        .req(
            "POST",
            &uri2,
            Some("rw"),
            Some("same-key"),
            body.clone(),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let k = format!("parallel-{}", Uuid::new_v4());
    let mut joins = Vec::new();
    for _ in 0..6 {
        let app = h.app.clone();
        let uri = uri.clone();
        let body = body.clone();
        let key = k.clone();
        joins.push(tokio::spawn(async move {
            let r = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("authorization", "Bearer rw")
                        .header("idempotency-key", key)
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let s = r.status();
            let b = to_bytes(r.into_body(), 100000).await.unwrap().to_vec();
            (s, b)
        }));
    }
    let mut bodies = HashSet::new();
    for j in joins {
        let (s, b) = j.await.unwrap();
        assert_eq!(s, StatusCode::CREATED);
        bodies.insert(b);
    }
    assert_eq!(
        bodies.len(),
        1,
        "concurrent duplicate callers must receive one stable result"
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn channel_etag_cas_comparisons_and_promotion_history() {
    let h = Harness::new().await;
    let bundle = h.bundle().await;
    let base = format!("{}/{bundle}", h.root());
    let parent = h.version(&bundle, Value::Null, "base", "parent").await;
    let p = parent["id"].as_str().unwrap().to_owned();
    let channel = format!("{base}/channels/stable");
    let promote_uri = format!("{channel}/releases");
    let (s, b, _) = h
        .req(
            "POST",
            &promote_uri,
            Some("rw"),
            Some("seed"),
            json!({"versionId":p,"expectedRevision":"0","unevaluatedReason":"initial seed"}),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
    let seed: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(seed["revision"], "1");
    assert_eq!(seed["unevaluatedReason"], "initial seed");
    let (s, _, head) = h
        .req("GET", &channel, Some("read"), None, Value::Null, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let etag = head
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_owned();
    let (s, _, _) = h
        .req(
            "GET",
            &channel,
            Some("read"),
            None,
            Value::Null,
            Some(("if-none-match", &etag)),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_MODIFIED);
    let cand = h.version(&bundle, json!(p), "candidate", "candidate").await;
    let c = cand["id"].as_str().unwrap().to_owned();
    let empty_comparison = json!({"parentVersionId":p,"candidateVersionId":c,"parentDigest":parent["digest"],"candidateDigest":cand["digest"],"datasetRevision":"dataset-1","runtime":{"engine":"unit"},"graderRevision":"grader-1","expectedCases":[{"caseId":"one","repetition":0},{"caseId":"two","repetition":0}],"results":[{"caseId":"one","repetition":0,"parent":{"executionStatus":"completed","gradingStatus":"scored","reward":0.2,"outputRef":null,"error":null,"usage":null},"candidate":{"executionStatus":"completed","gradingStatus":"scored","reward":0.3,"outputRef":null,"error":null,"usage":null}}]});
    let comp_uri = format!("{base}/comparisons");
    let mut no_cases = empty_comparison.clone();
    no_cases["expectedCases"] = json!([]);
    no_cases["results"] = json!([]);
    let (status, bytes, _) = h
        .req(
            "POST",
            &comp_uri,
            Some("rw"),
            Some("no-cases"),
            no_cases,
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "{}",
        String::from_utf8_lossy(&bytes)
    );

    let (s, b, _) = h
        .req(
            "POST",
            &comp_uri,
            Some("rw"),
            Some("incomplete"),
            empty_comparison.clone(),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
    let comp: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(comp["complete"], false);
    let (s, b, _) = h
        .req(
            "POST",
            &promote_uri,
            Some("rw"),
            Some("incomplete-promote"),
            json!({"versionId":c,"expectedRevision":"1","comparisonId":comp["id"]}),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{}", String::from_utf8_lossy(&b));
    let mut complete = empty_comparison.clone();
    complete["results"] = json!([{"caseId":"one","repetition":0,"parent":{"executionStatus":"completed","gradingStatus":"scored","reward":0.2,"outputRef":null,"error":null,"usage":null},"candidate":{"executionStatus":"completed","gradingStatus":"scored","reward":0.3,"outputRef":null,"error":null,"usage":null}},{"caseId":"two","repetition":0,"parent":{"executionStatus":"completed","gradingStatus":"scored","reward":0.4,"outputRef":null,"error":null,"usage":null},"candidate":{"executionStatus":"completed","gradingStatus":"scored","reward":0.5,"outputRef":null,"error":null,"usage":null}}]);
    let (s, b, _) = h
        .req(
            "POST",
            &comp_uri,
            Some("rw"),
            Some("complete"),
            complete.clone(),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
    let good: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(good["complete"], true);
    // A report with a mismatched stored digest is rejected.
    complete["candidateDigest"] = json!("sha256:bad");
    let (s, _, _) = h
        .req(
            "POST",
            &comp_uri,
            Some("rw"),
            Some("bad-digest"),
            complete,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // Candidate parent relation and channel parent are checked against stored records.
    let other = h.version(&bundle, Value::Null, "unrelated", "other").await;
    let mut wrong = empty_comparison.clone();
    wrong["candidateVersionId"] = other["id"].clone();
    wrong["candidateDigest"] = other["digest"].clone();
    let (s, _, _) = h
        .req(
            "POST",
            &comp_uri,
            Some("rw"),
            Some("wrong-parent"),
            wrong,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, b, _) = h
        .req(
            "POST",
            &promote_uri,
            Some("rw"),
            Some("good-promote"),
            json!({"versionId":c,"expectedRevision":"1","comparisonId":good["id"]}),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
    let promotion: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(promotion["previousVersionId"], p);
    assert_eq!(promotion["comparisonId"], good["id"]);
    assert_eq!(promotion["revision"], "2");
    // Competing channel updates using the same observed revision must have one winner.
    let a = h.version(&bundle, json!(c), "race-a", "race-a").await;
    let z = h.version(&bundle, json!(c), "race-z", "race-z").await;
    let mut tasks = Vec::new();
    for (i, v) in [a.clone(), z].into_iter().enumerate() {
        let app = h.app.clone();
        let uri = promote_uri.clone();
        let payload =
            json!({"versionId":v["id"],"expectedRevision":"2","unevaluatedReason":"race"});
        tasks.push(tokio::spawn(async move {
            let r = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("authorization", "Bearer rw")
                        .header("idempotency-key", format!("race-promote-{i}"))
                        .header("content-type", "application/json")
                        .body(Body::from(payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            r.status()
        }));
    }
    let outcomes = [
        tasks.remove(0).await.unwrap(),
        tasks.remove(0).await.unwrap(),
    ];
    assert_eq!(
        outcomes
            .iter()
            .filter(|&&s| s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|&&s| s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let stale = json!({"parentVersionId":c,"candidateVersionId":a["id"],"parentDigest":cand["digest"],"candidateDigest":a["digest"],"datasetRevision":"dataset-2","runtime":{"engine":"unit"},"graderRevision":"grader-1","expectedCases":[{"caseId":"one","repetition":0}],"results":[{"caseId":"one","repetition":0,"parent":{"executionStatus":"completed","gradingStatus":"scored","reward":0.2,"outputRef":null,"error":null,"usage":null},"candidate":{"executionStatus":"completed","gradingStatus":"scored","reward":0.3,"outputRef":null,"error":null,"usage":null}}]});
    let (s, b, _) = h
        .req(
            "POST",
            &comp_uri,
            Some("rw"),
            Some("stale-evidence"),
            stale,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
    let stale_id = serde_json::from_slice::<Value>(&b).unwrap()["id"].clone();
    let (s, b, _) = h
        .req(
            "POST",
            &promote_uri,
            Some("rw"),
            Some("stale-promote"),
            json!({"versionId":a["id"],"expectedRevision":"3","comparisonId":stale_id}),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{}", String::from_utf8_lossy(&b));
    let (s,b,_)=h.req("POST",&promote_uri,Some("rw"),Some("rollback"),json!({"versionId":p,"expectedRevision":"3","unevaluatedReason":"rollback after review"}),None).await;
    assert_eq!(s, StatusCode::CREATED, "{}", String::from_utf8_lossy(&b));
    let rollback: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(rollback["revision"], "4");
    assert_eq!(rollback["unevaluatedReason"], "rollback after review");
    let history: i64 =
        sqlx::query_scalar("SELECT count(*) FROM promotions WHERE project_id=$1 AND bundle_id=$2")
            .bind(&h.project)
            .bind(Uuid::parse_str(&bundle).unwrap())
            .fetch_one(&h.db)
            .await
            .unwrap();
    assert_eq!(history, 4);
    let _ = h.db; // Keep the dedicated test pool alive through all assertions.
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn oversized_requests_return_the_typed_error_contract() {
    let h = Harness::new().await;
    let (status, body, _) = h
        .req(
            "POST",
            &h.root(),
            Some("rw"),
            Some("too-large"),
            json!({"name":"x".repeat(2*1024*1024)}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(err_code(&body), "payload_too_large");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn paginated_history_is_scoped_stable_and_includes_rollback() {
    let h = Harness::new().await;
    let bundle = h.bundle().await;
    let first = h.version(&bundle, Value::Null, "first", "history-v1").await;
    let second = h
        .version(&bundle, first["id"].clone(), "second", "history-v2")
        .await;
    let uri = format!("{}/{bundle}/channels/stable/releases", h.root());
    let mut records = Vec::new();
    for (i, version) in [&first, &second, &first].iter().enumerate() {
        let (status, body, _) = h.req("POST", &uri, Some("rw"), Some(&format!("history-{i}")),
            json!({"versionId":version["id"],"expectedRevision":i.to_string(),"unevaluatedReason":if i == 2 {"rollback"} else {"review"}}), None).await;
        assert_eq!(status, StatusCode::CREATED);
        records.push(serde_json::from_slice::<Value>(&body).unwrap());
    }
    let (status, body, _) = h
        .req(
            "GET",
            &format!("{uri}?limit=2"),
            Some("read"),
            None,
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let page: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(page["items"], json!([records[2], records[1]]));
    assert_eq!(page["items"][0]["version"], first);
    assert_eq!(page["nextBeforeRevision"], "2");
    let (status, body, _) = h.req("POST", &uri, Some("rw"), Some("history-new"), json!({"versionId":second["id"],"expectedRevision":"3","unevaluatedReason":"new release"}), None).await;
    assert_eq!(status, StatusCode::CREATED);
    let new_record: Value = serde_json::from_slice(&body).unwrap();
    let (status, body, _) = h
        .req(
            "GET",
            &format!("{uri}?limit=2&beforeRevision=2"),
            Some("read"),
            None,
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let older: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(older["items"], json!([records[0]]));
    assert!(older["nextBeforeRevision"].is_null());
    let (_, body, _) = h
        .req(
            "GET",
            &format!("{uri}?beforeRevision=4"),
            Some("read"),
            None,
            Value::Null,
            None,
        )
        .await;
    let previous: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        previous["items"],
        json!([records[2], records[1], records[0]])
    );
    let (_, body, _) = h
        .req("GET", &uri, Some("read"), None, Value::Null, None)
        .await;
    let all: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(all["items"][0], new_record);
    for query in [
        "limit=0",
        "limit=101",
        "limit=-1",
        "limit=1&limit=2",
        "beforeRevision=0",
        "beforeRevision=01",
        "beforeRevision=9223372036854775808",
        "beforeRevision=+1",
        "unknown=1",
    ] {
        let (status, body, _) = h
            .req(
                "GET",
                &format!("{uri}?{query}"),
                Some("read"),
                None,
                Value::Null,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(err_code(&body), "invalid_content");
    }
    let (status, _, _) = h.req("GET", &uri, None, None, Value::Null, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = h
        .req("GET", &uri, Some("write-only"), None, Value::Null, None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let foreign = uri.replace(
        &format!("/workspaces/{}/", h.project),
        "/workspaces/foreign/",
    );
    let (status, _, _) = h
        .req("GET", &foreign, Some("read"), None, Value::Null, None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let missing = uri.replace("/channels/stable/", "/channels/missing/");
    let (status, _, _) = h
        .req("GET", &missing, Some("read"), None, Value::Null, None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn removed_project_routes_are_not_found_and_legacy_operation_paths_are_rejected() {
    let h = Harness::new().await;
    let bundle = h.bundle().await;
    let p = &h.project;
    let legacy = format!("/v1/projects/{p}/bundles/{bundle}");
    for (method, uri) in [
        ("GET", "/v1/projects".to_owned()),
        ("POST", format!("/v1/projects/{p}/bundles")),
        ("GET", format!("{legacy}/channels/stable")),
        ("POST", format!("{legacy}/channels/stable/promotions")),
        ("GET", format!("/v1/projects/{p}/evaluation-capabilities")),
        ("GET", format!("/v1/projects/{p}/integrations")),
        ("GET", format!("/v1/projects/{p}/operations/key")),
        // Only the canonical connection and release spellings exist under workspaces.
        ("GET", format!("/v1/workspaces/{p}/integrations")),
        (
            "POST",
            format!("/v1/workspaces/{p}/bundles/{bundle}/channels/stable/promotions"),
        ),
    ] {
        let (status, body, _) = h
            .req(method, &uri, Some("rw"), Some("k"), json!({}), None)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "not_found", "{method} {uri}");
    }
    for path in [
        format!("{legacy}/versions"),
        format!("/v1/workspaces/{p}/bundles/{bundle}/channels/stable/promotions"),
        "/v1/workspaces".to_owned(),
    ] {
        let uri = format!(
            "/v1/workspaces/{p}/operations/key?operationPath={}",
            path.replace('/', "%2F")
        );
        let (status, body, _) = h
            .req("GET", &uri, Some("rw"), None, Value::Null, None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "invalid_content");
        assert_eq!(body["error"]["message"], "Unsupported operation path");
    }
}
