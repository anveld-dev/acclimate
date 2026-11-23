use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Copy the admitted task versions while the loop lock still protects the round pins.
pub async fn queue_evaluation(
    tx: &mut Transaction<'_, Postgres>,
    evaluation: Uuid,
) -> Result<u64, sqlx::Error> {
    let split: String = sqlx::query_scalar("SELECT split FROM learning_evaluations WHERE id=$1")
        .bind(evaluation)
        .fetch_one(&mut **tx)
        .await?;
    let table = if split == "evolve" {
        "learning_tasks"
    } else {
        "learning_held_out_tasks"
    };
    let query = format!(
        "INSERT INTO learning_rollouts(evaluation_id,task_id,rollout,input,grader)
        SELECT e.id,t.task_id,n,t.input,t.grader FROM learning_evaluations e
        JOIN learning_rounds r ON r.id=e.round_id JOIN {table} t USING(project_id,bundle_id)
        CROSS JOIN generate_series(1,learning_rollouts_per_task()) n WHERE e.id=$1 AND t.admission='admitted'
          AND greatest(t.added_revision,t.admission_revision)<=r.task_revision
          AND (t.retired_revision IS NULL OR t.retired_revision>r.task_revision)"
    );
    let count = sqlx::query(&query)
        .bind(evaluation)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    if count == 0 {
        return Err(sqlx::Error::Protocol(
            "Evaluation has no admitted tasks at its pinned revision".into(),
        ));
    }
    sqlx::query("UPDATE learning_evaluations SET status='running',started_at=now() WHERE id=$1")
        .bind(evaluation)
        .execute(&mut **tx)
        .await?;
    Ok(count)
}

pub(crate) async fn settle_round(
    tx: &mut Transaction<'_, Postgres>,
    round: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE learning_evaluations e SET status='failed',error='rollout-failed'
        WHERE round_id=$1 AND status='running' AND EXISTS(SELECT FROM learning_rollouts WHERE evaluation_id=e.id AND status='failed')")
        .bind(round).execute(&mut **tx).await?;
    sqlx::query("UPDATE learning_rollouts l SET status='cancelled',lease_token_hash=NULL FROM learning_evaluations e
        WHERE e.round_id=$1 AND e.status='failed' AND e.id=l.evaluation_id AND l.status IN ('queued','running','grading')")
        .bind(round).execute(&mut **tx).await?;
    sqlx::query("WITH ready AS (
        SELECT id,split FROM learning_evaluations e WHERE round_id=$1 AND status='running'
        AND NOT EXISTS(SELECT FROM learning_rollouts WHERE evaluation_id=e.id AND status<>'scored')
    ), tasks AS (
        SELECT l.evaluation_id,l.task_id,avg(l.score) AS mean,
               jsonb_agg(jsonb_build_object('score',l.score,'passed',l.passed) ||
                   CASE WHEN e.split='evolve' THEN jsonb_strip_nulls(jsonb_build_object('gatewayLog',learning_feedback_log(l.gateway_log),'reasons',l.reasons))
                        ELSE '{}'::jsonb END ORDER BY l.rollout) AS rollouts
        FROM ready e JOIN learning_rollouts l ON l.evaluation_id=e.id GROUP BY l.evaluation_id,l.task_id
    ), reports AS (
        SELECT evaluation_id,avg(mean) score,jsonb_build_object('cases',jsonb_agg(jsonb_build_object('caseId',task_id,'rollouts',rollouts)
            ORDER BY task_id COLLATE \"C\")) AS report FROM tasks GROUP BY evaluation_id
    ) UPDATE learning_evaluations e SET status='scored',score=r.score,report=r.report FROM reports r WHERE e.id=r.evaluation_id")
        .bind(round).execute(&mut **tx).await?;
    Ok(())
}
