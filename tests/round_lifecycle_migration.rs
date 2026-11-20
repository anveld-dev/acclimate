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

#[sqlx::test(migrations = false)]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn automatic_delivery_upgrade_preserves_targets_and_retires_pending_review(db: PgPool) {
    use uuid::Uuid;
    let current = sqlx::migrate!("./migrations");
    Migrator {
        migrations: Cow::Owned(current.iter().filter(|m| m.version < 16).cloned().collect()),
        ..Migrator::DEFAULT
    }
    .run(&db)
    .await
    .unwrap();

    let mut seed = db.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(&mut *seed)
        .await
        .unwrap();
    let manual = Uuid::new_v4();
    let automatic = Uuid::new_v4();
    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    for (id, active) in [(manual, false), (automatic, true)] {
        let channel = format!("learn-{id}");
        sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES('upgrade',$1,$2,7,$3)")
            .bind(bundle).bind(&channel).bind(version).execute(&mut *seed).await.unwrap();
        sqlx::query("INSERT INTO connected_learning_enrollments(project_id,integration_id,bundle_id,source_channel,source_revision,delivery_channel,installation_id,permitted_paths,max_proposal_admissions,development,audits,automatic_rollout,outcome_principal,evaluator_principal,authorized_by)
            VALUES('upgrade',$1,$2,'stable',1,$3,'fixture',ARRAY['guide.md'],2,'{\"fixtureProtocol\":\"installed-v1\"}','[{\"fixtureProtocol\":\"installed-v1\"}]',$4,'app','evaluator','admin')")
            .bind(id).bind(bundle).bind(channel).bind(active).execute(&mut *seed).await.unwrap();
    }
    let comparison = Uuid::new_v4();
    sqlx::query("INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter) VALUES($1,'upgrade',$2,'{}',true,'evaluator')")
        .bind(comparison).bind(bundle).execute(&mut *seed).await.unwrap();
    sqlx::query("INSERT INTO connected_learning_rounds(project_id,integration_id,bundle_id,id,outcome_id,parent_version_id,parent_revision,proposal_id,candidate_version_id,development_request_id,development_comparison_id,audit_index,audit_request_id,audit_comparison_id,state,correction_id,attempt)
        VALUES('upgrade',$1,$2,gen_random_uuid(),gen_random_uuid(),$3,7,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),0,gen_random_uuid(),$4,'awaiting_review',gen_random_uuid(),1)")
        .bind(manual).bind(bundle).bind(version).bind(comparison).execute(&mut *seed).await.unwrap();
    seed.commit().await.unwrap();
    current.run(&db).await.unwrap();
    for (id, active) in [(manual, false), (automatic, true)] {
        let target: (bool, Uuid, i64) = sqlx::query_as("SELECT e.rollout_authorized,c.version_id,c.revision FROM connected_learning_enrollments e JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel) WHERE e.integration_id=$1")
            .bind(id).fetch_one(&db).await.unwrap();
        assert_eq!(target, (active, version, 7));
    }
    let terminal: (String,Uuid,bool) = sqlx::query_as("SELECT state,audit_comparison_id,audit_released FROM connected_learning_rounds WHERE integration_id=$1")
        .bind(manual).fetch_one(&db).await.unwrap();
    assert_eq!(terminal, ("rejected".into(), comparison, false));
}
