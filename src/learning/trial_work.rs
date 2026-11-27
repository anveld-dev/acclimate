//! Dispatch pending source rows when an executor presents its runtime identity.
use super::*;
use crate::executor::trials::{self, TrialTarget};
use tasks::Split;

type AdmissionSource = (String, Uuid, Uuid, Value, String, Value, i64);
fn trial_error(error: sqlx::Error) -> crate::ApiErr {
    match error {
        sqlx::Error::Protocol(message) => invalid(message),
        sqlx::Error::RowNotFound => conflict("Workspace provider changed"),
        other => db(other),
    }
}

type AdmissionResult = (String, Uuid, String, i64, String, Option<String>);

const TARGET: &str = "JOIN learning_loops l USING(project_id,bundle_id)
 JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(l.project_id,l.bundle_id,l.channel)
 JOIN workspace_model_providers p ON p.project_id=l.project_id";
const READY: &str = "p.verification->>'status'='verified' AND l.task_model=ANY(p.allowed_models) AND l.judge_model=ANY(p.allowed_models) AND l.task_model<>l.judge_model";
const RUNTIME: &str =
    "jsonb_build_object('taskModel',l.task_model,'judgeModel',l.judge_model,'baseUrl',p.base_url)";

pub(crate) async fn dispatch(tx: &mut Tx<'_>, executor: &Value) -> ApiResult<()> {
    // Rebind untouched trials. A partially executed trial cannot mix runtimes.
    sqlx::query("UPDATE learning_rollouts r SET status='cancelled' FROM learning_trials t JOIN workspace_model_providers p USING(project_id)
        WHERE r.trial_id=t.id AND r.status='queued' AND (t.runtime->>'baseUrl'<>p.base_url OR NOT (t.runtime->>'taskModel'=ANY(p.allowed_models) AND t.runtime->>'judgeModel'=ANY(p.allowed_models)) OR
        (t.runtime->'executor'<>$1 AND NOT EXISTS(SELECT FROM present_executors c WHERE c.runtime=t.runtime->'executor')
        AND EXISTS(SELECT FROM learning_rollouts sibling WHERE sibling.trial_id=t.id AND sibling.attempts>0)))").bind(executor).execute(&mut **tx).await.map_err(db)?;
    sqlx::query("UPDATE learning_trials t SET runtime=runtime||jsonb_build_object('executor',$1::jsonb)
        WHERE runtime->'executor' IS DISTINCT FROM $1 AND EXISTS(SELECT FROM learning_rollouts r WHERE r.trial_id=t.id AND r.status='queued')
        AND NOT EXISTS(SELECT FROM learning_rollouts r WHERE r.trial_id=t.id AND r.attempts>0)
        AND NOT EXISTS(SELECT FROM present_executors c WHERE c.runtime=t.runtime->'executor')").bind(executor).execute(&mut **tx).await.map_err(db)?;
    for split in [Split::Evolve, Split::HeldOut] {
        let table = split.table();
        let confirmed = if split == Split::HeldOut {
            "AND s.confirmed_by IS NOT NULL"
        } else {
            ""
        };
        sqlx::query(&format!("UPDATE {table} s SET admission='set-aside',admission_reason='check-failed' WHERE s.retired_revision IS NULL AND s.admission='pending' AND EXISTS(SELECT FROM learning_rollouts r WHERE r.trial_id=s.admission_trial AND r.status IN ('failed','cancelled'))")).execute(&mut **tx).await.map_err(db)?;
        let query = format!(
            "SELECT s.project_id,s.bundle_id,c.version_id,{RUNTIME},
                    s.task_id,s.grader,s.added_revision
             FROM {table} s {TARGET}
             WHERE {READY} AND s.admission='pending' AND s.retired_revision IS NULL
               AND s.admission_trial IS NULL {confirmed}
             ORDER BY s.added_revision,s.task_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED"
        );
        let row: Option<AdmissionSource> = sqlx::query_as(&query)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?;
        if let Some((project, bundle, version, mut runtime, id, grader, revision)) = row {
            runtime["executor"] = executor.clone();
            let trial = trials::run_admission(
                tx,
                &TrialTarget {
                    project: &project,
                    bundle,
                    version,
                    runtime: &runtime,
                },
                &grader,
            )
            .await
            .map_err(trial_error)?;
            sqlx::query(&format!("UPDATE {table} SET admission_trial=$5 WHERE (project_id,bundle_id,task_id,added_revision)=($1,$2,$3,$4)")).bind(project).bind(bundle).bind(id).bind(revision).bind(trial).execute(&mut **tx).await.map_err(db)?;
        }
    }
    sqlx::query("UPDATE learning_task_imports i SET failure='Conversion failed' WHERE failure IS NULL AND EXISTS(SELECT FROM learning_rollouts r WHERE r.trial_id=i.conversion_trial AND r.status IN ('failed','cancelled'))")
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    let q = format!(
        "SELECT s.id,s.project_id,s.bundle_id,c.version_id,{RUNTIME} FROM learning_task_imports s {TARGET}
         WHERE {READY} AND s.outcome IS NULL AND s.converted_rows+s.set_aside_rows<s.row_count
           AND s.conversion_trial IS NULL AND s.failure IS NULL
         LIMIT 1 FOR UPDATE OF s SKIP LOCKED"
    );
    let row: Option<(Uuid, String, Uuid, Uuid, Value)> = sqlx::query_as(&q)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
    if let Some((id, project, bundle, version, mut runtime)) = row {
        runtime["executor"] = executor.clone();
        let material = imports::rows_awaiting_conversion(tx, id).await?;
        let trial = trials::queue_conversion(
            tx,
            &TrialTarget {
                project: &project,
                bundle,
                version,
                runtime: &runtime,
            },
            &material,
        )
        .await
        .map_err(trial_error)?;
        sqlx::query("UPDATE learning_task_imports SET conversion_trial=$2 WHERE id=$1")
            .bind(id)
            .bind(trial)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
    }
    Ok(())
}

pub(crate) async fn apply(tx: &mut Tx<'_>, trial: Uuid) -> ApiResult<()> {
    for split in [Split::Evolve, Split::HeldOut] {
        let q = format!(
            "SELECT s.project_id,s.bundle_id,s.task_id,s.added_revision,r.admission,r.admission_reason FROM {} s JOIN learning_admission_results r ON r.trial_id=s.admission_trial WHERE r.trial_id=$1 AND r.admission<>'pending' AND s.retired_revision IS NULL",
            split.table()
        );
        let row: Option<AdmissionResult> = sqlx::query_as(&q)
            .bind(trial)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?;
        if let Some((p, b, id, rev, status, reason)) = row {
            tasks::set_admission(tx, &p, b, split, &id, rev, &status, reason.as_deref()).await?;
        }
    }
    Ok(())
}

pub(crate) async fn convert(
    tx: &mut Tx<'_>,
    trial: Uuid,
    cards: &[Value],
    aside: &[Value],
) -> ApiResult<()> {
    if let Some(id) =
        sqlx::query_scalar("SELECT id FROM learning_task_imports WHERE conversion_trial=$1")
            .bind(trial)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?
    {
        imports::write_conversion_output(tx, id, parse(&json!({"cards":cards,"setAside":aside}))?)
            .await?;
    }
    Ok(())
}

type RoutePath = Path<(String, String, String)>;
pub(super) async fn try_task(
    State(s): State<AppState>,
    Path((p, b, id)): RoutePath,
    h: HeaderMap,
) -> Reply {
    let b = path(&b)?;
    let (mut tx, a) = actor_tx(&s, &h, &p, "write").await?;
    for split in [Split::Evolve, Split::HeldOut] {
        if split == Split::HeldOut && a.user_id.is_none() {
            continue;
        }
        let q = format!(
            "SELECT input,grader FROM {} WHERE (project_id,bundle_id,task_id)=($1,$2,$3) AND retired_revision IS NULL",
            split.table()
        );
        let row: Option<(Value, Value)> = sqlx::query_as(&q)
            .bind(&p)
            .bind(b)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if let Some((input, grader)) = row {
            let q = format!(
                "SELECT c.version_id,{RUNTIME} FROM channels c JOIN learning_loops l ON (c.project_id,c.bundle_id,c.name)=(l.project_id,l.bundle_id,l.channel) JOIN workspace_model_providers p ON p.project_id=l.project_id WHERE (l.project_id,l.bundle_id)=($1,$2) AND {READY}"
            );
            let (version, runtime) = sqlx::query_as(&q)
                .bind(&p)
                .bind(b)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or_else(|| {
                    conflict("Configure the task and judge models and workspace provider first")
                })?;
            let trial = trials::start_try(
                &mut tx,
                &TrialTarget {
                    project: &p,
                    bundle: b,
                    version,
                    runtime: &runtime,
                },
                &id,
                &input,
                &grader,
            )
            .await
            .map_err(trial_error)?;
            sqlx::query("UPDATE learning_trials SET held_out=$2 WHERE id=$1")
                .bind(trial)
                .bind(split == Split::HeldOut)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            audit(&mut tx, &a, &p, b, &format!("/tasks/{id}/try"), None).await?;
            tx.commit().await.map_err(db)?;
            return Ok(Json(json!({"trialId":trial})));
        }
    }
    Err(missing("Task not found"))
}
pub(super) async fn read(
    State(s): State<AppState>,
    Path((p, b, id)): RoutePath,
    h: HeaderMap,
) -> Reply {
    let (b, id) = (path(&b)?, path(&id)?);
    let (mut tx, a) = actor_tx(&s, &h, &p, "read").await?;
    let visible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT FROM learning_trials WHERE (project_id,bundle_id,id)=($1,$2,$3) AND kind='try' AND (NOT held_out OR $4))").bind(&p).bind(b).bind(id).bind(a.user_id.is_some()).fetch_one(&mut *tx).await.map_err(db)?;
    if !visible {
        return Err(missing("Trial not found"));
    }
    tx.commit().await.map_err(db)?;
    let mut doc = trials::read_trial(&s.db, &p, b, id).await.map_err(db)?;
    if doc["status"] == "failed" {
        // A cancelled rollout has no error code: the executor or provider changed under it.
        let code: Option<String> = sqlx::query_scalar("SELECT coalesce(error_code,'cancelled') FROM learning_rollouts WHERE trial_id=$1 AND status IN ('failed','cancelled') ORDER BY status='cancelled',created_at LIMIT 1")
            .bind(id).fetch_optional(&s.db).await.map_err(db)?;
        doc["error"] = json!({ "code": code });
    }
    Ok(Json(doc))
}
pub(super) async fn import_status(
    State(s): State<AppState>,
    Path((p, b, id)): RoutePath,
    h: HeaderMap,
) -> Reply {
    let (mut tx, actor) = actor_tx(&s, &h, &p, "read").await?;
    let doc=sqlx::query_scalar("SELECT jsonb_build_object('importId',id,'rows',row_count,'converted',converted_rows,'setAsideCount',set_aside_rows,'setAside',CASE WHEN $4 THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('row',row_number,'source',i.source,'reason',reason) ORDER BY row_number),'[]') FROM learning_task_import_rows WHERE import_id=i.id AND status='set-aside') ELSE '[]'::jsonb END,'message',failure,'pending',row_count-converted_rows-set_aside_rows,'status',CASE WHEN failure IS NOT NULL THEN 'failed' WHEN row_count=converted_rows+set_aside_rows THEN 'completed' ELSE 'pending' END) FROM learning_task_imports i WHERE (project_id,bundle_id,id)=($1,$2,$3)").bind(p).bind(path(&b)?).bind(path(&id)?).bind(actor.user_id.is_some()).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||missing("Import not found"))?;
    Ok(Json(doc))
}
