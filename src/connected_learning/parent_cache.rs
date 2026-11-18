use super::{HashMap, Uuid, Value, invalid, json};
use crate::{ApiResult, ComparisonRequest, db, path};
use sqlx::{Postgres, Transaction};

use crate::evaluations::CreateEvaluationRequest;

type Tx<'a> = Transaction<'a, Postgres>;

fn limit(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

pub(crate) async fn assign(
    tx: &mut Tx<'_>,
    id: Uuid,
    (project, integration, bundle, epoch): (&str, Uuid, Uuid, i64),
    evaluator: &str,
    request: &CreateEvaluationRequest,
) -> ApiResult<()> {
    let age = f64::from(limit("ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS", 86_400));
    let uses = i64::from(limit("ACCLIMATE_LEARNING_PARENT_MAX_REUSES", 3));
    if age == 0.0 || uses == 0 {
        return Ok(());
    }
    let source: Option<(Uuid, String)> = sqlx::query_as(include_str!("parent_cache.sql"))
        .bind(project)
        .bind(integration)
        .bind(bundle)
        .bind(epoch)
        .bind(&request.parent_digest)
        .bind(evaluator)
        .bind(&request.dataset_revision)
        .bind(&request.grader_revision)
        .bind(json!(request.runtime))
        .bind(json!(request.expected_cases))
        .bind(age)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
    if let Some((source, arm)) = source {
        sqlx::query(
            "UPDATE evaluation_requests SET parent_source_comparison_id=c.id,parent_source_arm=$3,
                parent_source_expires_at=c.created_at+make_interval(secs => $4)
             FROM comparisons c WHERE evaluation_requests.id=$1 AND c.id=$2 AND
                (SELECT count(*) FROM comparisons reused WHERE reused.parent_source_comparison_id=c.id
                    AND reused.body->>'parentDigest'=$6)<$5",
        )
        .bind(id).bind(source).bind(arm).bind(age).bind(uses).bind(&request.parent_digest)
        .execute(&mut **tx).await.map_err(db)?;
    }
    Ok(())
}

pub(crate) async fn verify(tx: &mut Tx<'_>, report: &ComparisonRequest) -> ApiResult<()> {
    let Some(source) = report.parent_source_comparison_id else {
        return Ok(());
    };
    let invalid_source = || invalid("Cached parent results do not match the assigned source");
    let binding = report.evaluation.as_ref().ok_or_else(invalid_source)?;
    let (body, arm): (Value, String) = sqlx::query_as(
        "SELECT c.body,e.parent_source_arm FROM evaluation_requests e
         JOIN comparisons c ON c.id=e.parent_source_comparison_id
         WHERE e.id=$1 AND c.id=$2 AND e.started_at<e.parent_source_expires_at",
    )
    .bind(path(&binding.request_id)?)
    .bind(source)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?
    .ok_or_else(invalid_source)?;
    let source_report: ComparisonRequest = serde_json::from_value(body).map_err(db)?;
    let cached: HashMap<_, _> = source_report
        .results
        .into_iter()
        .map(|pair| {
            let result = if arm == "candidate" {
                pair.candidate
            } else {
                pair.parent
            };
            (pair.key, json!(result))
        })
        .collect();
    if report.results.len() != cached.len()
        || report.results.iter().any(|pair| {
            super::statistics::scored_reward(&pair.parent).is_none()
                || cached.get(&pair.key) != Some(&json!(pair.parent))
        })
    {
        return Err(invalid_source());
    }
    Ok(())
}
