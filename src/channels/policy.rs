use crate::{ApiResult, PolicyOverride, PolicyReceiptReference, db, err};
use axum::http::StatusCode;
use sqlx::{Postgres, Row, Transaction, types::Json};
use uuid::Uuid;

pub(super) async fn approve(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    bundle: Uuid,
    candidate: Uuid,
    reviewed: Option<PolicyOverride>,
    restore_from: Option<&str>,
) -> ApiResult<(Option<Json<PolicyOverride>>, Option<Uuid>)> {
    // Receipt insertion takes the same lock. A receipt that commits before this
    // release is included even if it belongs to a different comparison of the version.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("policy-receipt:{project}:{bundle}:{candidate}"))
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    let rows = sqlx::query(
        "SELECT comparison_id,policy_digest FROM evaluation_policy_receipts
         WHERE (project_id,bundle_id,candidate_version_id)=($1,$2,$3)
           AND body->>'verdict' IN ('fail','indeterminate')
         ORDER BY comparison_id,policy_digest",
    )
    .bind(project)
    .bind(bundle)
    .bind(candidate)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    let blockers: Vec<_> = rows
        .iter()
        .map(|row| PolicyReceiptReference {
            comparison_id: row.get("comparison_id"),
            policy_digest: row.get("policy_digest"),
        })
        .collect();
    let blocked = || {
        err(
            StatusCode::CONFLICT,
            "policy_override_required",
            "Review the candidate's current blocking policy receipts and acknowledge each with a reason.",
        )
    };
    if let Some(mut decision) = reviewed {
        decision.reason = decision.reason.trim().to_owned();
        if decision.reason.is_empty()
            || decision.reason.len() > 1024
            || decision.reason.chars().any(char::is_control)
        {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Provide a policy override reason of 1 to 1024 bytes.",
            ));
        }
        decision.receipts.sort();
        if blockers.is_empty() || decision.receipts != blockers {
            return Err(blocked());
        }
        return Ok((Some(Json(decision)), None));
    }
    if blockers.is_empty() {
        return Ok((None, None));
    }
    // A restoration of an already reviewed release carries forward its original
    // decision only while the complete set of blocking receipts is identical.
    if let Some(channel) = restore_from {
        let approval: Option<(Json<PolicyOverride>, Uuid)> = sqlx::query_as(
            "SELECT policy_override,COALESCE(policy_approval_promotion_id,id)
             FROM promotions WHERE (project_id,bundle_id,channel,version_id)=($1,$2,$3,$4)
               AND policy_override->'receipts'=$5 ORDER BY revision DESC LIMIT 1",
        )
        .bind(project)
        .bind(bundle)
        .bind(channel)
        .bind(candidate)
        .bind(Json(&blockers))
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
        if let Some((decision, id)) = approval {
            return Ok((Some(decision), Some(id)));
        }
    }
    Err(blocked())
}
