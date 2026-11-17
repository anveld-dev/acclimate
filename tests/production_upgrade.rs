mod common;
use serde_json::Value;
use sqlx::{Connection, Row};
use std::{borrow::Cow, collections::BTreeMap};
use uuid::Uuid;

async fn snapshot(connection: &mut sqlx::PgConnection, schema: &str) -> BTreeMap<String, Value> {
    let tables:Vec<String>=sqlx::query_scalar("SELECT table_name::text FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' AND table_name NOT IN ('browser_sessions','_sqlx_migrations','workspace_adoptions') ORDER BY table_name").bind(schema).fetch_all(&mut *connection).await.unwrap();
    let mut values = BTreeMap::new();
    for table in tables {
        let query = format!(
            "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM \"{table}\" t"
        );
        values.insert(
            table,
            sqlx::query_scalar(&query)
                .fetch_one(&mut *connection)
                .await
                .unwrap(),
        );
    }
    values
}

#[tokio::test]
async fn migration_0012_to_current_preserves_business_rows_and_revokes_sessions_once() {
    let Ok(url) = std::env::var("ACCLIMATE_TEST_DATABASE_URL") else {
        return;
    };
    // A unique schema keeps this upgrade independent of the already-upgraded fixture.
    let schema = format!("upgrade_{}", Uuid::new_v4().simple());
    let mut connection = sqlx::PgConnection::connect(&url).await.unwrap();
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET search_path TO {schema}"
    ))
    .execute(&mut connection)
    .await
    .unwrap();
    let full = sqlx::migrate!("./migrations");
    let old = sqlx::migrate::Migrator {
        migrations: Cow::Owned(full.iter().filter(|m| m.version <= 12).cloned().collect()),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    old.run(&mut connection).await.unwrap();
    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    let newer = Uuid::new_v4();
    let user = Uuid::new_v4();
    let session = Uuid::new_v4();
    let comparison = Uuid::new_v4();
    let promotion = Uuid::new_v4();
    let draft = Uuid::new_v4();
    let integration = Uuid::new_v4();
    let sql = format!(
        r#"
        INSERT INTO projects(id,name) VALUES('preserved-project','Original workspace');
        INSERT INTO users(id,issuer,subject) VALUES('{user}','https://legacy.example','same-original-subject');
        INSERT INTO project_memberships(project_id,user_id,role) VALUES('preserved-project','{user}','admin');
        INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES('{session}','original-session-hash','{user}',now()+interval '8 hours');
        INSERT INTO bundles(id,project_id,name,origin) VALUES('{bundle}','preserved-project','Preserved bundle','created');
        INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES('{version}','preserved-project','{bundle}','original-digest',decode('001122ff','hex'),'original-machine');
        INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES('{newer}','preserved-project','{bundle}','{version}','new-digest',decode('cafebabe','hex'),'original-machine');
        INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES('preserved-project','{bundle}','stable',2,'{newer}');
        INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter) VALUES('{comparison}','preserved-project','{bundle}','{{"evidence":"original artifact"}}',true,'original-evaluator');
        INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,previous_version_id,comparison_id,reviewer) VALUES('{promotion}','preserved-project','{bundle}','stable',2,'{newer}','{version}','{comparison}','original-reviewer');
        INSERT INTO drafts(id,project_id,bundle_id,channel,base_version_id,base_revision,snapshot_version_id,generation,status,created_by) VALUES('{draft}','preserved-project','{bundle}','stable','{newer}',2,'{newer}',1,'open','original-machine');
        INSERT INTO draft_snapshots(project_id,bundle_id,channel,draft_id,generation,version_id) VALUES('preserved-project','{bundle}','stable','{draft}',1,'{newer}');
        INSERT INTO proposals(id,project_id,bundle_id,parent_version_id,request,status,requested_by) VALUES('{proposal}','preserved-project','{bundle}','{newer}','{{"prepared":"unchanged"}}','queued','original-machine');
        INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status,evaluator_principal,attempt_id) VALUES('{evaluation}','preserved-project','{bundle}','{{"request":"original"}}','original-machine','running','original-evaluator','original-attempt');
        INSERT INTO integrations(id,project_id,bundle_id,channel,display_name) VALUES('{integration}','preserved-project','{bundle}','stable','Original app');
        INSERT INTO integration_credentials(id,project_id,integration_id,kind,secret_hash,issued_by,operation_key) VALUES('{credential}','preserved-project','{integration}','content-read','original-credential-hash','original-machine','original-issuance');
        INSERT INTO integration_receipts(integration_id,event_id,project_id,bundle_id,version_id,body,fingerprint) VALUES('{integration}','{receipt}','preserved-project','{bundle}','{newer}','{{"actor":"original-machine"}}','original-receipt-fingerprint');
        INSERT INTO command_results(principal_id,project_id,key,path,required_right,fingerprint,response_status,response_body) VALUES('original-machine','preserved-project','original-command','/original','write',decode('abcd','hex'),200,decode('eeff','hex'));
        INSERT INTO operation_records(principal_id,project_id,namespace,key,path,status,fingerprint,response_status,response_body) VALUES('original-machine','preserved-project','original-namespace','original-pending-metadata','/original','committed',decode('abcd','hex'),200,decode('eeff','hex'));
        INSERT INTO mutation_audit(project_id,actor_user_id,service_principal,principal_id,path,operation_key) VALUES('preserved-project','{user}','original-machine','original-machine','/original','original-audit');
        "#,
        proposal = Uuid::new_v4(),
        evaluation = Uuid::new_v4(),
        credential = Uuid::new_v4(),
        receipt = Uuid::new_v4()
    );
    sqlx::raw_sql(&sql).execute(&mut connection).await.unwrap();
    let before = snapshot(&mut connection, &schema).await;
    for table in [
        "versions",
        "drafts",
        "comparisons",
        "promotions",
        "integration_credentials",
        "project_memberships",
        "proposals",
        "operation_records",
    ] {
        assert!(
            !before[table].as_array().unwrap().is_empty(),
            "upgrade evidence must seed {table}"
        );
    }
    let checksums: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    full.run(&mut connection).await.unwrap();
    // Later profile/invitation migrations add fields and an empty table. Check
    // those defaults explicitly while preserving every original business value.
    let mut expected = before.clone();
    for user in expected.get_mut("users").unwrap().as_array_mut().unwrap() {
        user["display_name"] = Value::Null;
        user["email"] = Value::Null;
        user["email_verified"] = Value::Bool(false);
    }
    expected.insert("workspace_invitations".into(), serde_json::json!([]));
    // Progress adds only empty observations and initial ordering watermarks.
    // Keep comparing every pre-existing lifecycle/business field exactly.
    for request in expected
        .get_mut("evaluation_requests")
        .unwrap()
        .as_array_mut()
        .unwrap()
    {
        request["progress_sequence"] = serde_json::json!(0);
        request["progress_completed"] = serde_json::json!(0);
        request["progress_fingerprint"] = Value::Null;
    }
    expected.insert("evaluation_progress".into(), serde_json::json!([]));
    for table in [
        "connected_learning_cohorts",
        "connected_learning_enrollments",
        "connected_learning_field_verdicts",
        "connected_learning_outcomes",
        "connected_learning_renewals",
        "connected_learning_rounds",
    ] {
        expected.insert(table.into(), serde_json::json!([]));
    }
    assert_eq!(
        expected,
        snapshot(&mut connection, &schema).await,
        "upgrade must preserve exact business identities, payloads, ownership and timestamps"
    );
    let revoked = sqlx::query(
        "SELECT id,user_id,secret_hash,expires_at,revoked_at FROM browser_sessions WHERE id=$1",
    )
    .bind(session)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(revoked.get::<Uuid, _>("user_id"), user);
    assert_eq!(
        revoked.get::<String, _>("secret_hash"),
        "original-session-hash"
    );
    assert!(
        revoked
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at")
            .is_some()
    );
    let after_checksums: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT version,checksum FROM _sqlx_migrations WHERE version<=12 ORDER BY version",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    assert_eq!(
        checksums, after_checksums,
        "old migration checksums remain exact"
    );
    let fresh = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES($1,'post-cutover-session',$2,now()+interval '8 hours')").bind(fresh).bind(user).execute(&mut connection).await.unwrap();
    full.run(&mut connection).await.unwrap();
    let valid: bool =
        sqlx::query_scalar("SELECT revoked_at IS NULL FROM browser_sessions WHERE id=$1")
            .bind(fresh)
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert!(valid, "migration session revocation runs exactly once");
    assert_eq!(expected, snapshot(&mut connection, &schema).await);
    sqlx::raw_sql(&format!(
        "SET search_path TO public; DROP SCHEMA {schema} CASCADE"
    ))
    .execute(&mut connection)
    .await
    .unwrap();
}

#[tokio::test]
async fn upgrade_reserves_legacy_audits_and_quarantines_overlapping_slots() {
    let Ok(url) = std::env::var("ACCLIMATE_TEST_DATABASE_URL") else {
        return;
    };
    let schema = format!("legacy_cohort_{}", Uuid::new_v4().simple());
    let mut connection = sqlx::PgConnection::connect(&url).await.unwrap();
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET search_path TO {schema}"
    ))
    .execute(&mut connection)
    .await
    .unwrap();
    let full = sqlx::migrate!("./migrations");
    let legacy = sqlx::migrate::Migrator {
        migrations: Cow::Owned(full.iter().filter(|m| m.version <= 17).cloned().collect()),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    legacy.run(&mut connection).await.unwrap();
    let bundle = Uuid::new_v4();
    let version = Uuid::new_v4();
    sqlx::raw_sql(&format!(
        "INSERT INTO projects(id,name) VALUES('upgrade-cohorts','Upgrade fixtures');
         INSERT INTO bundles(project_id,id,name) VALUES('upgrade-cohorts','{bundle}','Fixture');
         INSERT INTO versions(project_id,bundle_id,id,digest,payload)
           VALUES('upgrade-cohorts','{bundle}','{version}','fixture-digest',decode('7b7d','hex'));
         INSERT INTO channels(project_id,bundle_id,name,revision,version_id)
           VALUES('upgrade-cohorts','{bundle}','stable',1,'{version}');"
    ))
    .execute(&mut connection)
    .await
    .unwrap();

    let enrollments = [Uuid::new_v4(), Uuid::new_v4()];
    for integration in enrollments {
        let delivery = format!("learn-{integration}");
        sqlx::raw_sql(&format!(
            "INSERT INTO integrations(project_id,bundle_id,id,channel,display_name)
               VALUES('upgrade-cohorts','{bundle}','{integration}','stable','Fixture');
             INSERT INTO channels(project_id,bundle_id,name,revision,version_id)
               VALUES('upgrade-cohorts','{bundle}','{delivery}',1,'{version}');"
        ))
        .execute(&mut connection)
        .await
        .unwrap();
        let development = serde_json::json!({
            "datasetRevision":"development","expectedCases":[{"caseId":"dev","repetition":0}]
        });
        let audits = serde_json::json!([
            {"datasetRevision":format!("first-{integration}"),"expectedCases":[{"caseId":"overlap","repetition":0}]},
            {"datasetRevision":format!("second-{integration}"),"expectedCases":[{"caseId":format!("fresh-{integration}"),"repetition":0}]}
        ]);
        sqlx::query(
            "INSERT INTO connected_learning_enrollments(project_id,bundle_id,integration_id,source_channel,source_revision,delivery_channel,installation_id,permitted_paths,max_proposal_admissions,proposal_admissions,development,audits,automatic_rollout,outcome_principal,evaluator_principal,authorized_by)
             VALUES('upgrade-cohorts',$1,$2,'stable',1,$3,'test',ARRAY['guide.md'],2,2,$4,$5,true,'outcome','evaluator','admin')",
        )
        .bind(bundle)
        .bind(integration)
        .bind(delivery)
        .bind(development)
        .bind(audits)
        .execute(&mut connection)
        .await
        .unwrap();
    }

    full.run(&mut connection).await.unwrap();
    let registrations: Vec<(i32, i64, bool, bool, bool)> = sqlx::query_as(
        "SELECT proposal_admissions,renewal_revision,automatic_rollback,
                connected_learning_audit_registered(project_id,bundle_id,integration_id,0,audits->0),
                connected_learning_audit_registered(project_id,bundle_id,integration_id,1,audits->1)
         FROM connected_learning_enrollments",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    assert_eq!(registrations, vec![(2, 0, true, false, true); 2]);
    sqlx::raw_sql(&format!(
        "SET search_path TO public; DROP SCHEMA {schema} CASCADE"
    ))
    .execute(&mut connection)
    .await
    .unwrap();
}
