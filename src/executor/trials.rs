//! Trial work is queued in the caller's transaction, independently of evaluations.
use super::{Tx, Value, json};
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

pub struct TrialTarget<'a> {
    pub project: &'a str,
    pub bundle: Uuid,
    pub version: Uuid,
    pub runtime: &'a Value,
}
type Result<T> = std::result::Result<T, sqlx::Error>;

async fn create(
    tx: &mut Tx<'_>,
    target: &TrialTarget<'_>,
    kind: &str,
    needs_judge: bool,
) -> Result<Uuid> {
    let runtime = target.runtime;
    let task = runtime["taskModel"].as_str();
    let judge = runtime["judgeModel"].as_str();
    if task.is_none() || (needs_judge && judge.is_none()) || judge == task {
        return Err(sqlx::Error::Protocol("invalid trial models".into()));
    }
    sqlx::query_scalar("INSERT INTO learning_trials(project_id,bundle_id,version_id,runtime,kind) SELECT $1,$2,$3,$4,$5 FROM workspace_model_providers WHERE project_id=$1 AND base_url=$6 AND $7=ANY(allowed_models) AND ($8::text IS NULL OR $8=ANY(allowed_models)) RETURNING id")
        .bind(target.project).bind(target.bundle).bind(target.version).bind(runtime).bind(kind).bind(runtime["baseUrl"].as_str()).bind(task).bind(judge).fetch_one(&mut **tx).await
}
async fn job(tx: &mut Tx<'_>, id: Uuid, task: &str, input: &Value, grader: &Value) -> Result<()> {
    sqlx::query("INSERT INTO learning_rollouts(trial_id,task_id,rollout,input,grader) VALUES($1,$2,1,$3,$4)")
        .bind(id).bind(task).bind(input).bind(grader).execute(&mut **tx).await?;
    Ok(())
}

pub async fn start_try(
    tx: &mut Tx<'_>,
    target: &TrialTarget<'_>,
    task_id: &str,
    input: &Value,
    grader: &Value,
) -> Result<Uuid> {
    let id = create(tx, target, "try", grader["type"] == "criteria").await?;
    job(tx, id, task_id, input, grader).await?;
    Ok(id)
}

pub async fn run_admission(
    tx: &mut Tx<'_>,
    target: &TrialTarget<'_>,
    _input: &Value,
    grader: &Value,
) -> Result<Uuid> {
    let id = create(tx, target, "admission", grader["type"] == "criteria").await?;
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
    let id = create(tx, target, "conversion", true).await?;
    // Bound each lease independently so a large import never shares one model budget.
    for row in rows {
        let batch = json!({"format":material["format"],"rows":[row]});
        job(tx, id, &row["row"].to_string(), &batch, &Value::Null).await?;
    }
    Ok(id)
}
pub(super) fn valid_conversion(material: &Value, cards: &[Value], aside: &[Value]) -> bool {
    let Some(rows) = material["rows"].as_array() else {
        return false;
    };
    let mut pending: HashSet<_> = rows.iter().filter_map(|r| r["row"].as_u64()).collect();
    cards.iter().all(|c| {
        c["row"].as_u64().is_some_and(|n| pending.remove(&n))
            && c.get("input").is_some()
            && c["criteriaDrafted"].is_boolean()
            && matches!(c["grader"]["type"].as_str(), Some("criteria" | "exact"))
    }) && aside.iter().all(|s| {
        s["reason"] == "no-reference" && s["row"].as_u64().is_some_and(|n| pending.remove(&n))
    }) && pending.is_empty()
}

pub async fn read_trial(pool: &PgPool, project: &str, bundle: Uuid, id: Uuid) -> Result<Value> {
    let rows=sqlx::query("SELECT t.kind,l.task_id,l.status,l.output,l.passed,l.score,l.votes,l.reasons,l.gateway_log,l.conversion_result FROM learning_trials t JOIN learning_rollouts l ON l.trial_id=t.id WHERE t.project_id=$1 AND t.bundle_id=$2 AND t.id=$3 ORDER BY l.created_at,l.task_id").bind(project).bind(bundle).bind(id).fetch_all(pool).await?;
    let first = rows.first().ok_or(sqlx::Error::RowNotFound)?;
    let kind = first.get::<String, _>("kind");
    let mut doc = json!({"trialId":id,"kind":kind,"status":"pending"});
    let status = |r: &sqlx::postgres::PgRow| r.get::<String, _>("status");
    if rows
        .iter()
        .any(|r| matches!(status(r).as_str(), "failed" | "cancelled"))
    {
        if kind != "admission" {
            doc["status"] = json!("failed")
        }
        return Ok(doc);
    }
    if !rows
        .iter()
        .all(|r| matches!(status(r).as_str(), "scored" | "converted"))
    {
        return Ok(doc);
    }
    match kind.as_str() {
        "admission" => {
            let reference = rows
                .iter()
                .find(|r| r.get::<String, _>("task_id") == "reference");
            let empty = rows
                .iter()
                .find(|r| r.get::<String, _>("task_id") == "empty")
                .ok_or(sqlx::Error::RowNotFound)?;
            let votes = reference.unwrap_or(empty).get::<Option<Value>, _>("votes");
            let reason = if reference.is_some_and(|r| !r.get::<bool, _>("passed")) {
                Some("reference-failed")
            } else if empty.get::<bool, _>("passed") {
                Some("empty-passed")
            } else if votes
                .and_then(|v| v.as_array().map(|a| a.windows(2).any(|w| w[0] != w[1])))
                .unwrap_or(false)
            {
                Some("judge-unstable")
            } else {
                None
            };
            doc["status"] = json!(if reason.is_some() {
                "set-aside"
            } else {
                "admitted"
            });
            doc["reason"] = json!(reason);
        }
        "conversion" => {
            let mut cards = vec![];
            let mut aside = vec![];
            for r in rows {
                let result: Value = r.get("conversion_result");
                cards.extend(result["cards"].as_array().unwrap().iter().cloned());
                aside.extend(result["setAside"].as_array().unwrap().iter().cloned());
            }
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
