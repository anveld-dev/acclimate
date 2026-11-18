use super::{Connection, Tx, close, conflict};
use crate::{ApiResult, AppState, PromoteRequest, db, err};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

use crate::connected_learning::statistics::{FieldDecision, field_decision, field_log_likelihood};

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
pub(super) enum Verdict {
    Pass,
    Regression,
    Win,
    Loss,
    Tie,
}

impl Verdict {
    fn label(&self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Regression => "regression",
            Self::Win => "win",
            Self::Loss => "loss",
            Self::Tie => "tie",
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Loss => "regression",
            verdict => verdict.label(),
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
    let command = crate::commands::DurableCommand::new(
        &connection.project,
        integration,
        "field",
        &actor.principal,
        verdict.outcome_id,
        request,
    );
    if let Some(response) = command
        .replay(&mut tx, || {
            conflict("A field verdict already exists for this served job")
        })
        .await?
    {
        return Ok(Json(response));
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
    let current = connection.baseline(&mut tx).await? == (verdict.version_id, revision);
    let served = sqlx::query(
        "SELECT p.id AS promotion_id,r.id AS round_id,f.control_version_id,f.rollback_promotion_id
         FROM connected_learning_outcomes o
         JOIN promotions p ON (p.project_id,p.bundle_id,p.channel,p.version_id,p.revision)=(o.project_id,o.bundle_id,$5,o.version_id,o.observed_revision)
         JOIN connected_learning_field_releases f ON f.promotion_id=p.id
         LEFT JOIN connected_learning_rounds r ON r.promotion_id=p.id
         JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(o.project_id,o.bundle_id,o.field_parent_version_id)
         WHERE (o.outcome_id,o.project_id,o.bundle_id,o.integration_id)=($1,$2,$3,$4)
           AND (v.id,v.digest)=($8,$9)
           AND (o.version_id,o.observed_revision,o.digest,o.started_receipt_id,o.submitted_by)=($6,$7,$10,$11,$12)",
    )
    .bind(verdict.outcome_id).bind(&connection.project).bind(connection.bundle).bind(integration)
    .bind(&connection.channel).bind(verdict.version_id).bind(revision)
    .bind(verdict.parent_version_id).bind(&verdict.parent_digest).bind(&verdict.digest)
    .bind(verdict.started_receipt_id).bind(&connection.submitter)
    .fetch_optional(&mut *tx).await.map_err(db)?
    .ok_or_else(|| conflict("Field verdict does not match a served job and managed release"))?;
    let release: Uuid = served.get("promotion_id");
    let round: Option<Uuid> = served.get("round_id");
    let control: Option<Uuid> = served.get("control_version_id");
    let existing_rollback: Option<Uuid> = served.get("rollback_promotion_id");
    let sequence: Option<i64> = sqlx::query_scalar(
        "INSERT INTO connected_learning_field_verdicts
         (project_id,bundle_id,integration_id,round_id,outcome_id,started_receipt_id,verdict,evaluator_principal,control_version_id,promotion_id,grade)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING sequence",
    )
    .bind(&connection.project).bind(connection.bundle).bind(integration).bind(round)
    .bind(verdict.outcome_id).bind(verdict.started_receipt_id).bind(verdict.verdict.as_str())
    .bind(actor.principal).bind(verdict.parent_version_id).bind(release)
    .bind(verdict.verdict.label()).fetch_optional(&mut *tx).await.map_err(db)?;
    let Some(sequence) = sequence else {
        return Err(conflict(
            "A field verdict already exists for this served job",
        ));
    };
    let (evidence, regressions, wins, decision) =
        sequential_test(&mut tx, release, verdict.parent_version_id).await?;
    let window_size = evidence.len() as i64;
    let same_control = control == Some(verdict.parent_version_id);
    let withdraw = connection.automatic_rollback && decision == FieldDecision::Withdraw;
    // Quarantine the failing bytes before the promotion chooses a
    // comparison version for the restored release.
    sqlx::query("UPDATE connected_learning_field_releases
        SET validated=(validated OR $2) AND NOT (withdrawn OR $3),withdrawn=withdrawn OR $3 WHERE promotion_id=$1")
        .bind(release).bind(current && same_control && decision == FieldDecision::Validate)
        .bind(withdraw).execute(&mut *tx).await.map_err(db)?;
    // Once superseded, a served revision can still contribute evidence, but it
    // can never move traffic. Only a control still eligible for delivery may be restored.
    let mut restore = None;
    if current
        && same_control
        && withdraw
        && existing_rollback.is_none()
        && let Some(target) = control
        && super::field_requalification::eligible(&mut tx, &connection, target, revision).await?
    {
        restore = Some(target);
    }
    let attempted = if let Some(target) = restore {
        let reason = format!(
            "Automatic rollback after {regressions} losses and {wins} wins in {window_size} independently graded served jobs"
        );
        match crate::channels::promote_in_tx(
            &mut tx,
            &connection.project,
            connection.bundle,
            &connection.channel,
            super::WORKER,
            PromoteRequest {
                version_id: target.to_string(),
                expected_revision: verdict.revision,
                comparison_id: None,
                unevaluated_reason: Some(reason),
                policy_override: None,
            },
            Some(&connection.channel),
        )
        .await
        {
            Ok(promotion) => Some(promotion),
            // The served job's field verdict remains valid even when a newer
            // application policy blocks the proposed rollback target.
            Err(error) if error.1 == "policy_override_required" => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let promotion = if let Some(promotion) = attempted {
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
        let id = crate::path(&promotion.id)?;
        connection.record_automatic(&mut tx, id).await?;
        Some(id)
    } else {
        None
    };
    if let Some(rollback) = promotion {
        sqlx::query("UPDATE connected_learning_field_releases SET rollback_promotion_id=$2 WHERE promotion_id=$1")
            .bind(release).bind(rollback).execute(&mut *tx).await.map_err(db)?;
    }
    if withdraw && !current {
        // Late evidence can invalidate the control chosen for a successor.
        // Only future outcomes bind the replacement. Already issued samples
        // remain verifiable against the control they actually graded.
        sqlx::query("UPDATE connected_learning_field_releases f
            SET control_version_id=connected_field_checkpoint($1,$2,p.revision,p.version_id)
            FROM promotions p JOIN channels c ON (c.project_id,c.bundle_id,c.name,c.revision)=(p.project_id,p.bundle_id,p.channel,p.revision)
            JOIN versions bad ON bad.digest=$5 AND (bad.project_id,bad.bundle_id)=(p.project_id,p.bundle_id)
            WHERE f.promotion_id=p.id AND (p.project_id,p.bundle_id,p.channel)=($1,$3,$4)
              AND f.control_version_id=bad.id AND NOT connected_field_eligible($1,$2,bad.id,c.revision)")
            .bind(&connection.project).bind(integration).bind(connection.bundle).bind(&connection.channel)
            .bind(&verdict.digest).execute(&mut *tx).await.map_err(db)?;
    }
    for kind in [
        (current && same_control && decision == FieldDecision::Validate).then_some("validate"),
        withdraw.then_some("withdraw"),
        promotion.map(|_| "rollback"),
    ]
    .into_iter()
    .flatten()
    {
        sqlx::query("INSERT INTO connected_learning_field_decisions
            (promotion_id,kind,control_version_id,verdict_sequences,window_size,losses,wins,log_likelihood,triggering_sequence)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING")
            .bind(release).bind(kind).bind(verdict.parent_version_id).bind(&evidence)
            .bind(window_size).bind(regressions).bind(wins)
            .bind(field_log_likelihood(wins, regressions)).bind(sequence)
            .execute(&mut *tx).await.map_err(db)?;
    }
    let mut response = json!({"outcomeId":verdict.outcome_id,"accepted":true,"windowSize":window_size,"regressions":regressions,"wins":wins});
    if let Some(promotion) = promotion {
        response["rollbackPromotionId"] = json!(promotion);
    }
    command.finish(tx, response).await
}

async fn sequential_test(
    tx: &mut Tx<'_>,
    release: Uuid,
    control: Uuid,
) -> ApiResult<(Vec<i64>, i64, i64, FieldDecision)> {
    // Legacy pass combined wins and ties. Exclude both legacy labels from inference.
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT sequence, grade FROM connected_learning_field_verdicts
         WHERE promotion_id=$1 AND control_version_id=$2
           AND grade IN ('win','loss','tie')
         ORDER BY sequence",
    )
    .bind(release)
    .bind(control)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    let (mut wins, mut losses) = (0, 0);
    let mut evidence = Vec::new();
    for (sequence, verdict) in rows {
        evidence.push(sequence);
        wins += i64::from(verdict == "win");
        losses += i64::from(verdict == "loss");
        let decision = field_decision(wins, losses);
        if decision != FieldDecision::Pending {
            return Ok((evidence, losses, wins, decision));
        }
    }
    Ok((evidence, losses, wins, FieldDecision::Pending))
}
