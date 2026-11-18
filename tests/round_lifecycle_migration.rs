use std::borrow::Cow;

use sqlx::{PgPool, migrate::Migrator};

#[sqlx::test(migrations = false)]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn migration_restarts_only_unresolved_replay_clocks(db: PgPool) {
    let current = sqlx::migrate!("./migrations");
    let previous = Migrator {
        migrations: Cow::Owned(
            current
                .iter()
                .filter(|migration| migration.version < 11)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    previous.run(&db).await.unwrap();

    let mut seed = db.begin().await.unwrap();
    // These obligations need no parent records to exercise the timestamp and view migration.
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(&mut *seed)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO connected_learning_replay_obligations
            (project_id,integration_id,bundle_id,version_id,baseline_revision,round_id,
             incident_outcome_id,created_at,verdict,evaluator)
         SELECT 'migration-fixture',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,
                gen_random_uuid(),gen_random_uuid(),now()-interval '30 days',verdict,evaluator
         FROM (VALUES (NULL::text,NULL::text),('pass','fixture')) cases(verdict,evaluator)",
    )
    .execute(&mut *seed)
    .await
    .unwrap();
    seed.commit().await.unwrap();

    current.run(&db).await.unwrap();
    let results: Vec<(Option<String>, bool)> = sqlx::query_as(
        "SELECT r.verdict, o.created_at > now()-interval '1 minute'
         FROM connected_learning_replay_obligations o
         JOIN connected_learning_replay_results r USING (id) ORDER BY o.id",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(results, vec![(None, true), (Some("pass".into()), false)]);
}
