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

    for migration in migrator.iter().filter(|m| (17..=21).contains(&m.version)) {
        connection.apply(migration).await.unwrap();
    }
    sqlx::raw_sql("INSERT INTO learning_loops(project_id,bundle_id,channel,app_principal,setting,held_out,enrolled_by,evolve_revision)
        SELECT project_id,id,'stable','machine:app','{}','{}','fixture',1 FROM bundles;
        INSERT INTO learning_evolve_cases(project_id,bundle_id,case_id,input,expected,source,added_revision)
        SELECT project_id,id,'old-task','1','2','setup',1 FROM bundles;")
        .execute(&mut connection).await.unwrap();
    sqlx::raw_sql("UPDATE machine_tokens SET rights=CASE name WHEN 'Reader' THEN ARRAY['evaluate','read','promote'] ELSE ARRAY['evaluate'] END;
        INSERT INTO machine_tokens(id,project_id,principal_id,name,secret_hash,secret_prefix,rights,created_by,expires_at)
        VALUES(gen_random_uuid(),'test','machine:writer','Writer','test-key-hash','test',ARRAY['evaluate','write'],'fixture',now()+interval '1 day');
        INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,channel_revision,evolve_revision,memory_revision,setting,held_out)
        SELECT gen_random_uuid(),project_id,bundle_id,1,'scoring_incumbent',version_id,name,revision,1,0,'{}','{}'
          FROM channels WHERE name='stable';
        INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,evolve_revision,deadline_at)
        SELECT gen_random_uuid(),r.id,'incumbent','evolve',v.id,v.digest,1,now()+interval '1 day' FROM learning_rounds r JOIN versions v ON v.id=r.parent_version_id;
        UPDATE learning_loops SET evolve_revision=2;
        INSERT INTO learning_evolve_cases(project_id,bundle_id,case_id,input,expected,source,added_revision,retired_revision)
        SELECT project_id,id,'retired','1','2','setup',1,2 FROM bundles;
        WITH outcome AS (SELECT gen_random_uuid() AS id)
        INSERT INTO learning_evolve_cases(project_id,bundle_id,case_id,input,expected,source,outcome_id,version_id,added_revision)
        SELECT c.project_id,c.bundle_id,'outcome:'||o.id,'1','2','outcome',o.id,c.version_id,2 FROM channels c CROSS JOIN outcome o WHERE c.name='stable';")
        .execute(&mut connection).await.unwrap();
    connection
        .apply(migrator.iter().find(|m| m.version == 22).unwrap())
        .await
        .unwrap();
    sqlx::query("INSERT INTO learning_rollouts(evaluation_id,task_id,rollout,input,grader) SELECT id,'old-task',1,'1','{}' FROM learning_evaluations;").execute(&mut connection).await.unwrap();
    migrator.run(&mut connection).await.unwrap();
    let cutover:(String,i64,i64)=sqlx::query_as("SELECT pause_reason,task_revision,(SELECT count(*) FROM learning_tasks) FROM learning_loops")
        .fetch_one(&mut connection).await.unwrap();
    assert_eq!(cutover, ("tasks-required".into(), 2, 3));

    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT retired_revision FROM learning_tasks WHERE task_id='retired'"
        )
        .fetch_one(&mut connection)
        .await
        .unwrap(),
        2
    );
    let cancelled:(String,String,String)=sqlx::query_as("SELECT r.state,e.status,l.status FROM learning_rounds r JOIN learning_evaluations e ON e.round_id=r.id JOIN learning_rollouts l ON l.evaluation_id=e.id")
        .fetch_one(&mut connection).await.unwrap();
    assert_eq!(
        cancelled,
        ("stopped".into(), "cancelled".into(), "cancelled".into())
    );

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
            "learning_alert_deliveries",
            "learning_blocked_versions",
            "learning_candidates",
            "learning_evaluations",
            "learning_held_out_tasks",
            "learning_loops",
            "learning_memory_attempts",
            "learning_memory_problems",
            "learning_optimizer_calls",
            "learning_rollouts",
            "learning_rounds",
            "learning_task_groups",
            "learning_task_import_rows",
            "learning_task_imports",
            "learning_tasks",
            "learning_trials",
            "learning_usage",
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
    let indexed: bool =
        sqlx::query_scalar("SELECT to_regclass('learning_rollouts_trial') IS NOT NULL")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert!(indexed);
    for view in ["learning_round_tasks", "learning_round_held_out_tasks"] {
        let n:i64=sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name IN ('admission_revision','admission_trial')").bind(view).fetch_one(&mut connection).await.unwrap();
        assert_eq!(n, 2);
    }
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
    assert_eq!(
        views,
        [
            "learning_admission_results",
            "learning_round_held_out_tasks",
            "learning_round_tasks",
            "present_executors"
        ]
    );
    let functions: Vec<String> = sqlx::query_scalar(
        "SELECT routine_name FROM information_schema.routines WHERE routine_schema=current_schema() ORDER BY routine_name",
    ).fetch_all(&mut connection).await.unwrap();
    assert_eq!(
        functions,
        [
            "learning_feedback_log",
            "learning_flagged_tasks",
            "learning_memory_append_only",
            "learning_record_rollout_usage",
            "learning_rollouts_per_task",
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
            (
                "Reader".into(),
                vec!["read".into(), "promote".into()],
                false
            ),
            ("Writer".into(), vec!["read".into(), "write".into()], false),
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
