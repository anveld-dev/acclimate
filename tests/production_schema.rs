mod common;
use sqlx::Connection;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn fresh_database_keeps_automatic_rollout_on_repeat_initialization() {
    let url = common::database_url();
    let schema = format!("baseline_{}", Uuid::new_v4().simple());
    let mut connection = sqlx::PgConnection::connect(&url).await.unwrap();
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET search_path TO {schema}"
    ))
    .execute(&mut connection)
    .await
    .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    migrator.run(&mut connection).await.unwrap();

    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    let integration = Uuid::new_v4();
    sqlx::raw_sql(&format!(
        r#"
        INSERT INTO projects(id, name) VALUES ('test', 'Baseline test');
        INSERT INTO bundles(project_id, id, name) VALUES ('test', '{bundle}', 'Bundle');
        INSERT INTO versions(project_id, bundle_id, id, digest, payload, created_by)
          VALUES ('test', '{bundle}', '{version}', 'test-digest', decode('7b7d', 'hex'), 'fixture-author');
        INSERT INTO channels(project_id, bundle_id, name, revision, version_id)
          VALUES ('test', '{bundle}', 'stable', 1, '{version}'),
                 ('test', '{bundle}', 'delivery', 1, '{version}');
        INSERT INTO integrations(project_id, bundle_id, id, channel, display_name)
          VALUES ('test', '{bundle}', '{integration}', 'stable', 'App');
        INSERT INTO connected_learning_enrollments(
          project_id, bundle_id, integration_id, source_channel, source_revision, delivery_channel,
          installation_id, permitted_paths, max_proposal_admissions, development, audits,
          automatic_rollout, outcome_principal, evaluator_principal, authorized_by)
          VALUES ('test', '{bundle}', '{integration}', 'stable', 1, 'delivery', 'install',
                  ARRAY['guide.md'], 2,
                  '{{"datasetRevision":"development","fixtureProtocol":"installed-v1"}}',
                  '[{{"datasetRevision":"audit","fixtureProtocol":"installed-v1"}}]',
                  true, 'outcome', 'evaluator', 'operator');
        "#
    ))
    .execute(&mut connection)
    .await
    .unwrap();

    migrator.run(&mut connection).await.unwrap();
    let rollout: bool = sqlx::query_scalar(
        "SELECT automatic_rollout FROM connected_learning_enrollments WHERE integration_id = $1",
    )
    .bind(integration)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert!(rollout);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&mut connection)
        .await
        .unwrap();
}
