use super::{Connection, Tx, close, conflict};
use crate::{ApiResult, AppState, PromoteRequest, db, err};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

const WINDOW_CAPACITY: i64 = 10;
const REGRESSION_THRESHOLD: i64 = 3;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FieldVerdict {
    outcome_id: Uuid,
    started_receipt_id: Uuid,
    version_id: Uuid,
    digest: String,
    revision: String,
    parent_version_id: Uuid,
    parent_digest: String,
    verdict: Verdict,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Verdict {
    Pass,
    Regression,
}

impl Verdict {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Regression => "regression",
        }
    }
}

pub(super) async fn submit(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    headers: HeaderMap,
    Json(verdict): Json<FieldVerdict>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&headers, &s, &project, "write")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "write").await?;
    let connection = Connection::lock(&mut tx, &s, project, integration)
        .await?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "not_found",
                "Learning enrollment not found",
            )
        })?;
    if connection.evaluator != actor.principal || connection.submitter == actor.principal {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Independent field evaluator required",
        ));
    }
    let request = serde_json::to_value(&verdict).map_err(db)?;
    let prior: Option<(Value, Value)> = sqlx::query_as(
        "SELECT request,response FROM connected_learning_field_verdicts
         WHERE (project_id,bundle_id,integration_id,outcome_id)=($1,$2,$3,$4)",
    )
    .bind(&connection.project)
    .bind(connection.bundle)
    .bind(integration)
    .bind(verdict.outcome_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    if let Some((stored, response)) = prior {
        return if stored == request {
            Ok(Json(response))
        } else {
            Err(conflict(
                "A field verdict already exists for this served job",
            ))
        };
    }
    if !connection.active {
        return Err(conflict("Field auditing authority is inactive"));
    }
    let revision = verdict
        .revision
        .parse::<i64>()
        .ok()
        .filter(|revision| *revision > 0 && revision.to_string() == verdict.revision)
        .ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Invalid delivery revision",
            )
        })?;
    if connection.baseline(&mut tx).await? != (verdict.version_id, revision) {
        return Err(conflict(
            "Field verdict does not match the current delivery revision",
        ));
    }
    let round: Option<Uuid> = sqlx::query_scalar(
        "SELECT r.id FROM connected_learning_rounds r
         JOIN promotions p ON (p.project_id,p.bundle_id,p.id)=(r.project_id,r.bundle_id,r.promotion_id)
         JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(p.project_id,p.bundle_id,p.previous_version_id)
         JOIN connected_learning_outcomes o ON (o.project_id,o.bundle_id,o.integration_id,o.outcome_id)=(r.project_id,r.bundle_id,r.integration_id,$1)
         WHERE (r.project_id,r.bundle_id,r.integration_id)=($2,$3,$4)
           AND (p.channel,p.version_id,p.revision)=($5,$6,$7)
           AND (v.id,v.digest)=($8,$9)
           AND (o.version_id,o.digest,o.started_receipt_id,o.delivery_revision,o.submitted_by,o.field_parent_version_id)=($6,$10,$11,$7,$12,$8)
           AND r.state='promoted' AND r.rollback_promotion_id IS NULL
           AND (r.parent_version_id,r.candidate_version_id,r.parent_revision+1)=(p.previous_version_id,p.version_id,p.revision)",
    )
    .bind(verdict.outcome_id).bind(&connection.project).bind(connection.bundle).bind(integration)
    .bind(&connection.channel).bind(verdict.version_id).bind(revision)
    .bind(verdict.parent_version_id).bind(&verdict.parent_digest).bind(&verdict.digest)
    .bind(verdict.started_receipt_id).bind(&connection.submitter)
    .fetch_optional(&mut *tx).await.map_err(db)?;
    let Some(round) = round else {
        return Err(conflict(
            "Field verdict does not match a served job and managed release",
        ));
    };
    let sequence: Option<i64> = sqlx::query_scalar(
        "INSERT INTO connected_learning_field_verdicts
         (project_id,bundle_id,integration_id,round_id,outcome_id,started_receipt_id,verdict,evaluator_principal,request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING sequence",
    )
    .bind(&connection.project).bind(connection.bundle).bind(integration).bind(round)
    .bind(verdict.outcome_id).bind(verdict.started_receipt_id).bind(verdict.verdict.as_str())
    .bind(actor.principal).bind(request).fetch_optional(&mut *tx).await.map_err(db)?;
    let Some(sequence) = sequence else {
        return Err(conflict(
            "A field verdict already exists for this served job",
        ));
    };
    let (window_size, regressions) = window(&mut tx, round).await?;
    let promotion = if connection.automatic_rollback && regressions >= REGRESSION_THRESHOLD {
        let reason = format!(
            "Automatic rollback after {regressions} regressions in {window_size} independently graded served jobs"
        );
        let promotion = crate::channels::promote_in_tx(
            &mut tx,
            &connection.project,
            connection.bundle,
            &connection.channel,
            &connection.authorizer,
            PromoteRequest {
                version_id: verdict.parent_version_id.to_string(),
                expected_revision: verdict.revision,
                comparison_id: None,
                unevaluated_reason: Some(reason),
            },
        )
        .await?;
        let stale_rounds = sqlx::query(
            "SELECT * FROM connected_learning_rounds
             WHERE (project_id,bundle_id,integration_id,parent_version_id,parent_revision)=($1,$2,$3,$4,$5)
                 AND state IN ('proposing','development','audit','awaiting_review')",
        )
        .bind(&connection.project).bind(connection.bundle).bind(integration).bind(verdict.version_id).bind(revision)
        .fetch_all(&mut *tx).await.map_err(db)?;
        for stale in stale_rounds {
            close(
                &mut tx,
                &stale,
                "Parent delivery was withdrawn by automatic rollback",
            )
            .await?;
        }
        Some(crate::path(&promotion.id)?)
    } else {
        None
    };
    sqlx::query("UPDATE connected_learning_rounds SET field_audit_window_size=$2,field_audit_regressions=$3,rollback_promotion_id=$4,updated_at=now() WHERE id=$1")
        .bind(round).bind(window_size as i32).bind(regressions as i32).bind(promotion).execute(&mut *tx).await.map_err(db)?;
    let mut response = json!({"outcomeId":verdict.outcome_id,"accepted":true,"windowSize":window_size,"regressions":regressions});
    if let Some(promotion) = promotion {
        response["rollbackPromotionId"] = json!(promotion);
    }
    sqlx::query("UPDATE connected_learning_field_verdicts SET response=$2 WHERE sequence=$1")
        .bind(sequence)
        .bind(&response)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(response))
}

async fn window(tx: &mut Tx<'_>, round: Uuid) -> ApiResult<(i64, i64)> {
    sqlx::query_as(
        "SELECT count(*),count(*) FILTER (WHERE verdict='regression')
         FROM (SELECT verdict FROM connected_learning_field_verdicts WHERE round_id=$1
               ORDER BY sequence DESC LIMIT $2) recent",
    )
    .bind(round)
    .bind(WINDOW_CAPACITY)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rollback_window_expires_old_verdicts_and_partitions_releases() {
        let Ok(url) = std::env::var("ACCLIMATE_TEST_DATABASE_URL") else {
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(
            "CREATE TEMP TABLE connected_learning_field_verdicts (
                sequence bigint GENERATED ALWAYS AS IDENTITY, round_id uuid NOT NULL, verdict text NOT NULL
            ) ON COMMIT DROP",
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let target = Uuid::new_v4();
        let another = Uuid::new_v4();
        let insert = "INSERT INTO connected_learning_field_verdicts (round_id, verdict)
                      SELECT $1, verdict FROM unnest($2::text[]) AS verdict";
        sqlx::query(insert)
            .bind(target)
            .bind(["regression"; 3].as_slice())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(insert)
            .bind(another)
            .bind(["regression"; 4].as_slice())
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(window(&mut tx, target).await.unwrap(), (3, 3));
        sqlx::query(insert)
            .bind(target)
            .bind(["pass"; 8].as_slice())
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(window(&mut tx, target).await.unwrap(), (10, 2));
        assert_eq!(window(&mut tx, another).await.unwrap(), (4, 4));
    }
}
