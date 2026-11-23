use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// The caller pins the round runtime and creates the evaluation in this transaction.
pub async fn queue_evaluation(
    tx: &mut Transaction<'_, Postgres>,
    evaluation: Uuid,
) -> Result<u64, sqlx::Error> {
    let result= sqlx::query("INSERT INTO learning_rollouts(evaluation_id,task_id,rollout,input,grader)
        SELECT e.id,c.case_id,n,c.input,jsonb_build_object('type','exact','expected',c.expected)
        FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id JOIN learning_evolve_cases c USING(project_id,bundle_id)
        CROSS JOIN generate_series(1,5) n WHERE e.id=$1 AND e.split='evolve' AND r.runtime IS NOT NULL AND c.added_revision<=e.evolve_revision
        AND (c.retired_revision IS NULL OR c.retired_revision>e.evolve_revision)")
        .bind(evaluation)
        .execute(&mut **tx).await?;
    Ok(result.rows_affected())
}

/// Returns pending, failed, or a complete evaluation with one summary per task.
pub async fn assemble(pool: &PgPool, evaluation: Uuid) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar("WITH tasks AS (SELECT task_id,bool_or(status='failed') AS failed,
        count(*)=5 AND bool_and(status='scored') AS complete,avg(score) AS mean,count(*) FILTER(WHERE passed)>=3 AS passed
        FROM learning_rollouts WHERE evaluation_id=$1 GROUP BY task_id)
        SELECT CASE WHEN bool_or(failed) THEN jsonb_build_object('status','failed')
        WHEN bool_and(complete) THEN jsonb_build_object('status','scored','score',avg(mean),'tasks',jsonb_agg(jsonb_build_object('taskId',task_id,'score',mean,'passed',passed) ORDER BY task_id))
        ELSE jsonb_build_object('status','pending') END FROM tasks")
        .bind(evaluation)
        .fetch_one(pool).await
}
