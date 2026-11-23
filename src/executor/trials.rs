//! Trial work is queued in the caller's transaction, independently of evaluations.
use super::{Tx, Value, json};
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

pub(crate) const CONVERSION_BYTES: usize = 64 * 1024;

pub struct TrialTarget<'a> {
    pub project: &'a str,
    pub bundle: Uuid,
    pub version: Uuid,
    pub runtime: &'a Value,
}
type Result<T> = std::result::Result<T, sqlx::Error>;

async fn create(tx: &mut Tx<'_>, target: &TrialTarget<'_>, kind: &str) -> Result<Uuid> {
    let runtime = target.runtime;
    let task = runtime["taskModel"].as_str();
    let judge = runtime["judgeModel"].as_str();
    if task.is_none() || judge.is_none() || judge == task {
        return Err(sqlx::Error::Protocol("invalid trial models".into()));
    }
    sqlx::query_scalar("INSERT INTO learning_trials(project_id,bundle_id,version_id,runtime,kind) SELECT $1,$2,$3,$4,$5 FROM workspace_model_providers WHERE project_id=$1 AND verification->>'status'='verified' AND base_url=$6 AND $7=ANY(allowed_models) AND ($8::text IS NULL OR $8=ANY(allowed_models)) FOR SHARE RETURNING id")
        .bind(target.project).bind(target.bundle).bind(target.version).bind(runtime).bind(kind).bind(runtime["baseUrl"].as_str()).bind(task).bind(judge).fetch_one(&mut **tx).await
}
async fn job(tx: &mut Tx<'_>, id: Uuid, task: &str, input: &Value, grader: &Value) -> Result<()> {
    sqlx::query("INSERT INTO learning_rollouts(trial_id,task_id,rollout,input,grader) VALUES($1,$2,1,$3,$4)")
        .bind(id).bind(task).bind(input).bind(grader).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) fn valid_grader(grader: &Value) -> bool {
    match grader["type"].as_str() {
        Some("exact") => grader.get("expected").is_some(),
        Some("criteria") => grader["criteria"].as_array().is_some_and(|cs| {
            (1..=10).contains(&cs.len())
                && cs
                    .iter()
                    .all(|c| c.as_str().is_some_and(|s| !s.trim().is_empty()))
        }),
        _ => false,
    }
}
fn validate_grader(grader: &Value) -> Result<()> {
    if valid_grader(grader) {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol("invalid task grader".into()))
    }
}

pub async fn start_try(
    tx: &mut Tx<'_>,
    target: &TrialTarget<'_>,
    task_id: &str,
    input: &Value,
    grader: &Value,
) -> Result<Uuid> {
    validate_grader(grader)?;
    let id = create(tx, target, "try").await?;
    job(tx, id, task_id, input, grader).await?;
    Ok(id)
}

pub async fn run_admission(
    tx: &mut Tx<'_>,
    target: &TrialTarget<'_>,
    grader: &Value,
) -> Result<Uuid> {
    validate_grader(grader)?;
    let id = create(tx, target, "admission").await?;
    if let Some(reference) = grader.get(if grader["type"] == "criteria" {
        "reference"
    } else {
        "expected"
    }) {
        job(tx, id, "reference", reference, grader).await?;
    }
    job(tx, id, "empty", &json!(""), grader).await?;
    Ok(id)
}

pub async fn queue_conversion(
    tx: &mut Tx<'_>,
    target: &TrialTarget<'_>,
    material: &Value,
) -> Result<Uuid> {
    let rows = material["rows"]
        .as_array()
        .ok_or_else(|| sqlx::Error::Protocol("missing material rows".into()))?;
    let mut ids = HashSet::new();
    if rows.is_empty()
        || !matches!(material["format"].as_str(), Some("rows" | "conversations"))
        || rows
            .iter()
            .any(|r| r["row"].as_u64().is_none_or(|n| !ids.insert(n)) || r["source"].is_null())
    {
        return Err(sqlx::Error::Protocol("invalid material".into()));
    }
    let id = create(tx, target, "conversion").await?;
    // Keep each batch small enough for its requests, replies and gateway log.
    // Import processing has already set aside rows above the batch limit.
    let mut start = 0;
    while start < rows.len() {
        let mut end = start;
        let mut bytes = 0;
        while end < rows.len() && end - start < 16 {
            let size = rows[end].to_string().len();
            if size > CONVERSION_BYTES {
                return Err(sqlx::Error::Protocol("oversized conversion row".into()));
            }
            if end > start && bytes + size > CONVERSION_BYTES {
                break;
            }
            bytes += size;
            end += 1;
        }
        let batch = json!({"format":material["format"],"rows":&rows[start..end]});
        job(
            tx,
            id,
            &rows[start]["row"].to_string(),
            &batch,
            &Value::Null,
        )
        .await?;
        start = end;
    }
    Ok(id)
}
pub(super) fn valid_conversion(material: &Value, cards: &[Value], aside: &[Value]) -> bool {
    let Some(rows) = material["rows"].as_array() else {
        return false;
    };
    let known: HashSet<_> = rows.iter().filter_map(|r| r["row"].as_u64()).collect();
    let mut covered = HashSet::new();
    for c in cards {
        let Some(n) = c["row"].as_u64() else {
            return false;
        };
        if !known.contains(&n)
            || c.get("input").is_none()
            || !c["criteriaDrafted"].is_boolean()
            || validate_grader(&c["grader"]).is_err()
            || !c["group"].is_string()
        {
            return false;
        }
        covered.insert(n);
    }
    aside.iter().all(|s| {
        s["reason"] == "no-reference"
            && s["row"]
                .as_u64()
                .is_some_and(|n| known.contains(&n) && covered.insert(n))
    }) && known == covered
}

pub async fn read_trial(pool: &PgPool, project: &str, bundle: Uuid, id: Uuid) -> Result<Value> {
    let rows=sqlx::query("SELECT t.kind,l.task_id,l.status,l.output,l.passed,l.score,l.votes,l.reasons,l.gateway_log,l.conversion_result FROM learning_trials t JOIN learning_rollouts l ON l.trial_id=t.id WHERE t.project_id=$1 AND t.bundle_id=$2 AND t.id=$3 ORDER BY l.created_at,l.task_id").bind(project).bind(bundle).bind(id).fetch_all(pool).await?;
    let first = rows.first().ok_or(sqlx::Error::RowNotFound)?;
    let kind = first.get::<String, _>("kind");
    let mut doc = json!({"trialId":id,"kind":kind,"status":"pending"});
    if kind == "admission" {
        let outcome = sqlx::query(
            "SELECT admission,admission_reason FROM learning_admission_results WHERE trial_id=$1",
        )
        .bind(id)
        .fetch_one(pool)
        .await?;
        doc["status"] = json!(outcome.get::<String, _>("admission"));
        doc["reason"] = json!(outcome.get::<Option<String>, _>("admission_reason"));
        return Ok(doc);
    }
    let status = |r: &sqlx::postgres::PgRow| r.get::<String, _>("status");
    if rows
        .iter()
        .any(|r| matches!(status(r).as_str(), "failed" | "cancelled"))
    {
        doc["status"] = json!("failed");
        return Ok(doc);
    }
    if !rows
        .iter()
        .all(|r| matches!(status(r).as_str(), "scored" | "converted"))
    {
        return Ok(doc);
    }
    match kind.as_str() {
        "conversion" => {
            let mut cards = vec![];
            let mut aside = vec![];
            for r in rows {
                let result: Value = r.get("conversion_result");
                cards.extend(result["cards"].as_array().unwrap().iter().cloned());
                aside.extend(result["setAside"].as_array().unwrap().iter().cloned());
            }
            cards.sort_by_key(|c| c["row"].as_u64());
            aside.sort_by_key(|s| s["row"].as_u64());
            doc["status"] = json!("completed");
            doc["cards"] = json!(cards);
            doc["setAside"] = json!(aside);
        }
        _ => {
            doc["status"] = json!("scored");
            doc["output"] = json!(first.get::<Option<String>, _>("output"));
            doc["gatewayLog"] = json!(first.get::<Option<Value>, _>("gateway_log"));
            doc["verdict"] = json!({"passed":first.get::<bool,_>("passed"),"score":first.get::<f64,_>("score"),"votes":first.get::<Option<Value>,_>("votes"),"reasons":first.get::<Option<Value>,_>("reasons")});
        }
    }
    Ok(doc)
}
