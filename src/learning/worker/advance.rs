use super::{Kind, LoopRow, Pins, Tx, channel_head, fail_round, optimizer, queue};
use crate::{
    BundlePayload, PromoteRequest, channels, compatibility, encode_payload,
    proposal_edits::reconstruct,
};
use optimizer::{Candidate, Screen, Selection, Verdict, invariant, stored, version};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

pub(super) async fn step(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: &Pins,
    state: &str,
) -> Result<(), sqlx::Error> {
    match state {
        "proposing" => proposing(tx, row, round).await,
        "screening" => screening(tx, row, round).await,
        "evaluating" => evaluating(tx, row, round).await,
        "selecting" => selecting(tx, row, round).await,
        _ => Err(invariant("Unknown active state")),
    }
}

async fn set_state(tx: &mut Tx<'_>, round: &Pins, state: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE learning_rounds SET state=$2 WHERE id=$1")
        .bind(round.id)
        .bind(state)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(FromRow)]
struct Call {
    output: Option<Value>,
    error_code: Option<String>,
    input_digest: String,
}

async fn result(
    tx: &mut Tx<'_>,
    round: &Pins,
    kind: Kind,
    sample: i16,
) -> Result<Option<Call>, sqlx::Error> {
    sqlx::query_as(
        "SELECT output,error_code,input_digest FROM learning_optimizer_calls
        WHERE (round_id,kind,sample)=($1,$2,$3) AND status IN ('succeeded','failed')",
    )
    .bind(round.id)
    .bind(kind.name())
    .bind(sample)
    .fetch_optional(&mut **tx)
    .await
}

async fn rebuild(
    tx: &mut Tx<'_>,
    round: &Pins,
    changes: &Value,
) -> Result<(BundlePayload, Vec<u8>, String), sqlx::Error> {
    let (parent, parent_digest) = version(tx, round.parent_version_id).await?;
    let payload =
        reconstruct(&parent, &stored(changes)?, &round.target(tx).await?).map_err(invariant)?;
    let bytes = encode_payload(&payload).map_err(|error| invariant(error.2))?;
    Ok((payload, bytes, parent_digest))
}

async fn proposing(tx: &mut Tx<'_>, row: &LoopRow, round: &Pins) -> Result<(), sqlx::Error> {
    let sample: i16 = sqlx::query_scalar(
        "SELECT sample FROM learning_candidates WHERE round_id=$1 AND status='generating'",
    )
    .bind(round.id)
    .fetch_one(&mut **tx)
    .await?;
    let Some(call) = result(tx, round, Kind::Propose, sample).await? else {
        return Ok(());
    };
    let output = call.output.unwrap_or(Value::Null);
    let (mut reason, mut scan, mut diagnosis, mut changes, mut rationale) =
        (call.error_code.as_deref(), None, None, None, None);
    match reason {
        Some("optimizer-context-too-large") => {
            return fail_round(tx, row, round.id, "optimizer-context-too-large").await;
        }
        Some("scanner-rejected") => {
            scan = Some(&output["scan"]);
            diagnosis = output.get("diagnosis").filter(|value| !value.is_null());
        }
        Some(_) => {}
        None => {
            let patch = json!({"edits":output["edits"],"files":output["files"]});
            let (_, bytes, parent_digest) = rebuild(tx, round, &patch).await?;
            if crate::digest(&bytes) == parent_digest {
                reason = Some("no-change");
            }
            changes = Some(patch);
            rationale = output["rationale"].as_str();
            diagnosis = Some(&output["diagnosis"]);
            scan = Some(&CLEAN_SCAN);
        }
    }
    sqlx::query("UPDATE learning_candidates SET status=$3,drop_reason=$4,rationale=$5,changes=$6,diagnosis=$7,scan=$8
        WHERE (round_id,sample)=($1,$2)")
        .bind(round.id).bind(sample).bind(if reason.is_some() {"dropped"} else {"generated"}).bind(reason)
        .bind(rationale).bind(changes).bind(diagnosis).bind(scan).execute(&mut **tx).await?;
    if sample < 5 {
        optimizer::enqueue(tx, round, Kind::Propose, sample + 1).await
    } else {
        let (generated, provider_failed): (i64, i64) = sqlx::query_as("SELECT
            count(*) FILTER (WHERE status='generated'),count(*) FILTER (WHERE drop_reason='provider-failed')
            FROM learning_candidates WHERE round_id=$1").bind(round.id).fetch_one(&mut **tx).await?;
        if generated > 0 {
            optimizer::enqueue(tx, round, Kind::Screen, 0).await?;
            set_state(tx, round, "screening").await
        } else if provider_failed == 5 {
            fail_round(tx, row, round.id, "optimizer-unavailable").await
        } else {
            keep(tx, row, round, "no-candidates", None).await
        }
    }
}

static CLEAN_SCAN: std::sync::LazyLock<Value> =
    std::sync::LazyLock::new(|| json!({"clean": true, "findings": []}));

async fn selector_result(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: &Pins,
    kind: Kind,
) -> Result<Option<(Value, String)>, sqlx::Error> {
    let Some(call) = result(tx, round, kind, 0).await? else {
        return Ok(None);
    };
    if let Some(code) = call.error_code {
        let reason = if code == "optimizer-context-too-large" {
            "optimizer-context-too-large"
        } else {
            "selector-unavailable"
        };
        fail_round(tx, row, round.id, reason).await?;
        return Ok(None);
    }
    Ok(Some((
        call.output
            .ok_or_else(|| invariant("Missing selector output"))?,
        call.input_digest,
    )))
}

async fn screening(tx: &mut Tx<'_>, row: &LoopRow, round: &Pins) -> Result<(), sqlx::Error> {
    let Some((output, _)) = selector_result(tx, row, round, Kind::Screen).await? else {
        return Ok(());
    };
    let screen: Screen = stored(&output)?;
    for sample in screen.samples {
        let status = if sample.verdict == Verdict::Skip {
            "screened_out"
        } else {
            "generated"
        };
        sqlx::query(
            "UPDATE learning_candidates SET status=$3,screen=$4 WHERE (round_id,sample)=($1,$2)",
        )
        .bind(round.id)
        .bind(sample.sample)
        .bind(status)
        .bind(json!({"verdict": sample.verdict, "reason": sample.reason}))
        .execute(&mut **tx)
        .await?;
    }
    if queue_survivor(tx, round).await? {
        set_state(tx, round, "evaluating").await
    } else {
        keep(tx, row, round, "no-survivors", None).await
    }
}

async fn queue_survivor(tx: &mut Tx<'_>, round: &Pins) -> Result<bool, sqlx::Error> {
    let survivor: Option<Candidate> = sqlx::query_as("SELECT * FROM learning_candidates
        WHERE round_id=$1 AND status='generated' AND screen->>'verdict'='evaluate' ORDER BY sample LIMIT 1")
        .bind(round.id).fetch_optional(&mut **tx).await?;
    let Some(survivor) = survivor else {
        return Ok(false);
    };
    let changes = survivor
        .changes
        .as_ref()
        .ok_or_else(|| invariant("Missing survivor changes"))?;
    let (payload, bytes, _) = rebuild(tx, round, changes).await?;
    compatibility::validate_in_tx(tx, &round.project_id, round.bundle_id, &payload)
        .await
        .map_err(|error| invariant(error.2))?;
    let digest = crate::digest(&bytes);
    let version = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'service:learning-loop')",
    )
    .bind(version)
    .bind(&round.project_id)
    .bind(round.bundle_id)
    .bind(round.parent_version_id)
    .bind(&digest)
    .bind(bytes)
    .execute(&mut **tx)
    .await?;
    let evaluation = queue(
        tx,
        round.id,
        version,
        &digest,
        Some((round.evolve_revision, Some(survivor.sample))),
    )
    .await?;
    sqlx::query("UPDATE learning_candidates SET status='evaluating',version_id=$3,evaluation_id=$4 WHERE (round_id,sample)=($1,$2)")
        .bind(round.id).bind(survivor.sample).bind(version).bind(evaluation).execute(&mut **tx).await?;
    Ok(true)
}

async fn evaluating(tx: &mut Tx<'_>, row: &LoopRow, round: &Pins) -> Result<(), sqlx::Error> {
    let (sample, status, score): (i16, String, Option<f64>) = sqlx::query_as(
        "SELECT c.sample,e.status,e.score FROM learning_candidates c JOIN learning_evaluations e ON e.id=c.evaluation_id
         WHERE c.round_id=$1 AND c.status='evaluating' AND e.role='candidate' AND e.split='evolve'")
        .bind(round.id).fetch_one(&mut **tx).await?;
    let status = match status.as_str() {
        "scored" => "evaluated",
        "failed" | "cancelled" => "evaluation_failed",
        _ => return Ok(()),
    };
    sqlx::query(
        "UPDATE learning_candidates SET status=$3,evolve_score=$4 WHERE (round_id,sample)=($1,$2)",
    )
    .bind(round.id)
    .bind(sample)
    .bind(status)
    .bind(score)
    .execute(&mut **tx)
    .await?;
    if queue_survivor(tx, round).await? {
        return Ok(());
    }
    let evaluated: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM learning_candidates WHERE round_id=$1 AND status='evaluated')",
    )
    .bind(round.id)
    .fetch_one(&mut **tx)
    .await?;
    if evaluated {
        optimizer::enqueue(tx, round, Kind::Select, 0).await?;
        set_state(tx, round, "selecting").await
    } else {
        keep(tx, row, round, "no-evaluated-candidates", None).await
    }
}

async fn selecting(tx: &mut Tx<'_>, row: &LoopRow, round: &Pins) -> Result<(), sqlx::Error> {
    let Some((output, input_digest)) = selector_result(tx, row, round, Kind::Select).await? else {
        return Ok(());
    };
    match stored(&output)? {
        Selection::Keep { reason } => {
            let selection = json!({"decision":"keep","sample":null,"versionId":null,"digest":null,
                "reason":reason,"model":round.optimizer_model,"inputDigest":input_digest});
            keep(tx, row, round, "selector-kept", Some(selection)).await
        }
        Selection::Adopt { sample, reason } => {
            let (version_id, digest): (Uuid, String) = sqlx::query_as(
                "SELECT v.id,v.digest FROM learning_candidates c JOIN versions v ON v.id=c.version_id
                 WHERE (c.round_id,c.sample)=($1,$2) AND c.status='evaluated'")
                .bind(round.id).bind(sample).fetch_one(&mut **tx).await?;
            let selection = json!({"decision":"adopt","sample":sample,"versionId":version_id,"digest":digest,
                "reason":reason,"model":round.optimizer_model,"inputDigest":input_digest});
            adopt(tx, row, round, selection).await
        }
    }
}

async fn adopt(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: &Pins,
    selection: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "promotion:{}:{}:{}",
            row.project_id, row.bundle_id, round.channel
        ))
        .execute(&mut **tx)
        .await?;
    let revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM channels WHERE (project_id,bundle_id,name)=($1,$2,$3) FOR UPDATE",
    )
    .bind(&row.project_id)
    .bind(row.bundle_id)
    .bind(&round.channel)
    .fetch_one(&mut **tx)
    .await?;
    if revision != round.channel_revision {
        return keep(tx, row, round, "channel-moved", Some(selection)).await;
    }
    let version_id: Uuid = stored(&selection["versionId"])?;
    let sample: i16 = stored(&selection["sample"])?;
    let digest = selection["digest"]
        .as_str()
        .ok_or_else(|| invariant("Missing adoption digest"))?;
    channels::promote_in_tx(
        tx,
        &row.project_id,
        row.bundle_id,
        &round.channel,
        "service:learning-loop",
        PromoteRequest {
            version_id: version_id.to_string(),
            expected_revision: revision.to_string(),
            unevaluated_reason: format!(
                "Adopted in learning round {}, sample {sample}",
                round.number
            ),
        },
    )
    .await
    .map_err(|error| invariant(format!("Round {} promotion failed: {}", round.id, error.2)))?;
    sqlx::query("UPDATE learning_rounds SET decision='adopted',adopted_sample=$2,adopted_version_id=$3,
        selection=$4,state='scoring_held_out' WHERE id=$1 AND state='selecting' AND selection IS NULL")
        .bind(round.id).bind(sample).bind(version_id).bind(&selection).execute(&mut **tx).await?;
    super::super::memory::write_back(tx, round).await?;
    queue(tx, round.id, version_id, digest, None).await?;
    Ok(())
}

async fn keep(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: &Pins,
    reason: &str,
    selection: Option<Value>,
) -> Result<(), sqlx::Error> {
    let (version, _, digest) = channel_head(tx, row, &round.channel).await?;
    sqlx::query("UPDATE learning_rounds SET state='scoring_held_out',decision='kept',reason=$2,selection=$3 WHERE id=$1")
        .bind(round.id).bind(reason).bind(selection).execute(&mut **tx).await?;
    queue(tx, round.id, version, &digest, None).await?;
    Ok(())
}
