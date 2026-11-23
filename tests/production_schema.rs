mod common;

use acclimate_service::{AppState, Grant, router};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use sqlx::{Connection, migrate::Migrate, postgres::PgConnectOptions};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn upgrade_removes_old_workflows_and_preserves_delivery() {
    let schema = format!("pre_loop_{}", Uuid::new_v4().simple());
    let url = common::database_url();
    let options: PgConnectOptions = url
        .parse::<PgConnectOptions>()
        .unwrap()
        .options([("search_path", &schema)]);
    let mut connection = sqlx::PgConnection::connect_with(&options).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&mut connection)
        .await
        .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    connection.ensure_migrations_table().await.unwrap();
    for migration in migrator.iter().take_while(|m| m.version <= 15) {
        connection.apply(migration).await.unwrap();
    }
    sqlx::raw_sql(include_str!("conformance/pre-loop-upgrade.sql"))
        .execute(&mut connection)
        .await
        .unwrap();

    // Exercise the upgrade from main with existing connected-learning data.
    let automatic_delivery = migrator.iter().find(|m| m.version == 16).unwrap();
    connection.apply(automatic_delivery).await.unwrap();

    migrator.run(&mut connection).await.unwrap();

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables
         WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name <> '_sqlx_migrations'
         ORDER BY table_name",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    assert_eq!(
        tables,
        [
            "browser_sessions",
            "bundles",
            "channels",
            "durable_commands",
            "executor_credentials",
            "idempotency",
            "integration_credentials",
            "integration_receipts",
            "integrations",
            "learning_candidates",
            "learning_evaluations",
            "learning_evolve_cases",
            "learning_loops",
            "learning_memory_attempts",
            "learning_memory_problems",
            "learning_optimizer_calls",
            "learning_rollouts",
            "learning_rounds",
            "learning_trials",
            "machine_token_events",
            "machine_tokens",
            "mutation_audit",
            "operation_records",
            "project_memberships",
            "projects",
            "promotions",
            "users",
            "versions",
            "workspace_adoptions",
            "workspace_invitations",
            "workspace_model_providers",
        ]
    );
    let effort_column: (String, String) = sqlx::query_as(
        "SELECT data_type,is_nullable FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='learning_rounds'
         AND column_name='optimizer_reasoning_effort'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(effort_column, ("text".into(), "YES".into()));

    let views: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.views WHERE table_schema=current_schema() ORDER BY table_name",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    assert_eq!(views, ["learning_admission_results"]);
    let functions: Vec<String> = sqlx::query_scalar(
        "SELECT routine_name FROM information_schema.routines WHERE routine_schema=current_schema() ORDER BY routine_name",
    ).fetch_all(&mut connection).await.unwrap();
    assert_eq!(
        functions,
        [
            "learning_memory_append_only",
            "machine_token_events_append_only"
        ]
    );
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='promotions' ORDER BY ordinal_position",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    assert_eq!(
        columns,
        [
            "id",
            "project_id",
            "bundle_id",
            "channel",
            "revision",
            "version_id",
            "previous_version_id",
            "unevaluated_reason",
            "reviewer",
            "created_at",
        ]
    );
    let scopes: Vec<String> = sqlx::query_scalar("SELECT scope FROM durable_commands")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    assert_eq!(scopes, ["retained/example"]);
    for table in ["operation_records", "idempotency"] {
        let paths: Vec<String> = sqlx::query_scalar(&format!("SELECT path FROM {table}"))
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            paths,
            ["/v1/workspaces/test/bundles/00000000-0000-0000-0000-000000000001/versions"]
        );
    }
    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM mutation_audit")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(audit_count, 3);

    let tokens: Vec<(String, Vec<String>, bool)> = sqlx::query_as(
        "SELECT name,rights,revoked_at IS NOT NULL FROM machine_tokens ORDER BY name",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    assert_eq!(
        tokens,
        [
            ("Old".into(), vec!["read".into()], true),
            ("Reader".into(), vec!["read".into()], false),
        ]
    );
    let events: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT t.name,e.action,e.actor_principal FROM machine_token_events e JOIN machine_tokens t ON t.id=e.token_id",
    ).fetch_all(&mut connection).await.unwrap();
    assert_eq!(
        events,
        [("Old".into(), "revoked".into(), "service:migration".into())]
    );

    let db = sqlx::postgres::PgPoolOptions::new()
        .connect_with(options)
        .await
        .unwrap();
    let app = router(AppState {
        db: db.clone(),
        access: common::access(),
        runtime: Arc::default(),
        optimizer: None,
        grants: Arc::new(vec![Grant {
            token: "upgrade-reader".into(),
            principal_id: "upgrade-reader".into(),
            project_id: "test".into(),
            rights: vec!["read".into()],
        }]),
    });
    let bundle = "/v1/workspaces/test/bundles/00000000-0000-0000-0000-000000000001";
    let learned = "learn-00000000-0000-0000-0000-000000000004";
    for (channel, connection, version) in [
        (learned, None, "00000000-0000-0000-0000-000000000003"),
        (
            "stable",
            Some("00000000-0000-0000-0000-000000000004"),
            "00000000-0000-0000-0000-000000000002",
        ),
    ] {
        let mut request = Request::builder()
            .uri(format!("{bundle}/channels/{channel}"))
            .header("authorization", "Bearer upgrade-reader")
            .header("if-none-match", "\"1\"");
        if let Some(id) = connection {
            request = request.header("x-acclimate-connection-id", id);
        }
        let resolution = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resolution.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(resolution.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["version"]["id"], version);
    }

    let history = app
        .oneshot(
            Request::builder()
                .uri(format!("{bundle}/channels/{learned}/releases"))
                .header("authorization", "Bearer upgrade-reader")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(history.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(history.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(
        body["items"][0]["id"],
        "00000000-0000-0000-0000-000000000009"
    );
    assert!(body["items"][0]["unevaluatedReason"].is_null());
    assert!(body["items"][0].get("comparisonId").is_none());

    db.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&mut connection)
        .await
        .unwrap();
}
