use super::{
    Tx,
    optimizer::{Pins, candidates, evolve_evaluation},
};
use serde_json::{Value, json};
use uuid::Uuid;

pub(super) async fn render_history(tx: &mut Tx<'_>, round: &Pins) -> Result<Value, sqlx::Error> {
    let rows: Vec<(Uuid, Option<String>, Value)> = sqlx::query_as(
        "SELECT id,optimizer_reasoning_effort,jsonb_build_object('round',number,'state',state,'decision',decision,'reason',reason,
            'parentVersionId',parent_version_id,'adoptedVersionId',adopted_version_id,
            'setting',setting,'evolveRevision',task_revision,'optimizerModel',optimizer_model,
            'selection',selection - ARRAY['versionId','digest','model','inputDigest','reasoningEffort'])
         FROM learning_rounds WHERE (project_id,bundle_id)=($1,$2) AND number<$3 AND setting=$4
         ORDER BY number")
        .bind(&round.project_id).bind(round.bundle_id).bind(round.number).bind(&round.setting)
        .fetch_all(&mut **tx).await?;
    let mut history = Vec::with_capacity(rows.len());
    for (id, effort, mut entry) in rows {
        if let Some(effort) = effort {
            entry["optimizerReasoningEffort"] = json!(effort);
        }
        entry["incumbent"] = json!(
            evolve_evaluation(tx, id, "incumbent", None)
                .await?
                .filter(|evaluation| evaluation.status == "scored")
                .map(|evaluation| evaluation.summary(false))
        );
        let mut entries = Vec::new();
        for candidate in candidates(tx, id).await? {
            let mut doc = json!({"sample": candidate.sample, "status": candidate.status, "dropReason": candidate.drop_reason});
            if candidate.drop_reason.as_deref() != Some("scanner-rejected") {
                doc["rationale"] = json!(candidate.rationale);
                doc["diagnosis"] = json!(candidate.diagnosis);
                doc["changes"] = json!(candidate.changes);
                doc["screen"] = json!(candidate.screen);
                let result = match candidate.evaluation_id {
                    Some(evaluation) => evolve_evaluation(tx, id, "candidate", Some(evaluation))
                        .await?
                        .filter(|evaluation| evaluation.status == "scored")
                        .map(|evaluation| evaluation.summary(false)),
                    None => None,
                };
                doc["evolve"] = json!(result);
            }
            entries.push(doc);
        }
        entry["candidates"] = json!(entries);
        history.push(entry);
    }
    Ok(json!(history))
}
