use super::*;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Deserialize, Serialize, FromRow)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EvolveCase {
    pub(super) case_id: String,
    input: Value,
    expected: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CasesRequest {
    #[serde(default)]
    cases: Vec<EvolveCase>,
    #[serde(default)]
    retire: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outcome {
    outcome_id: Uuid,
    version_id: Uuid,
    digest: String,
    input: Value,
    expected: Value,
}

pub(super) fn valid_case_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn validate_example(input: &Value, expected: &Value) -> ApiResult<()> {
    if [input, expected]
        .into_iter()
        .any(|v| v.to_string().len() > 64 * 1024)
    {
        return Err(invalid("Input and expected must each fit in 64 KiB"));
    }
    Ok(())
}

pub(super) async fn cases_at(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    revision: i64,
) -> Result<Vec<EvolveCase>, sqlx::Error> {
    sqlx::query_as("SELECT case_id,input,expected FROM learning_evolve_cases WHERE (project_id,bundle_id)=($1,$2)
                    AND added_revision<=$3 AND (retired_revision IS NULL OR retired_revision>$3) ORDER BY case_id COLLATE \"C\"")
        .bind(project).bind(bundle).bind(revision).fetch_all(&mut **tx).await
}

pub(super) async fn live_count(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    revision: i64,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM learning_evolve_cases WHERE (project_id,bundle_id)=($1,$2)
                         AND added_revision<=$3 AND (retired_revision IS NULL OR retired_revision>$3)")
        .bind(project).bind(bundle).bind(revision).fetch_one(&mut **tx).await
}

async fn bump(tx: &mut Tx<'_>, row: &LoopRow) -> ApiResult<()> {
    sqlx::query("UPDATE learning_loops SET evolve_revision=evolve_revision+1,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

async fn add_case(tx: &mut Tx<'_>, row: &LoopRow, case: &EvolveCase) -> ApiResult<bool> {
    let prior: Option<bool> = sqlx::query_scalar(
        "SELECT retired_revision IS NULL AND input=$4 AND expected=$5 FROM learning_evolve_cases WHERE (project_id,bundle_id,case_id)=($1,$2,$3)")
        .bind(&row.project_id).bind(row.bundle_id).bind(&case.case_id).bind(&case.input).bind(&case.expected)
        .fetch_optional(&mut **tx).await.map_err(db)?;
    if let Some(identical) = prior {
        return if identical {
            Ok(false)
        } else {
            Err(conflict("Evolve case IDs are immutable"))
        };
    }
    sqlx::query("INSERT INTO learning_evolve_cases(project_id,bundle_id,case_id,input,expected,source,added_revision)
                 VALUES($1,$2,$3,$4,$5,'setup',$6)")
        .bind(&row.project_id).bind(row.bundle_id).bind(&case.case_id).bind(&case.input).bind(&case.expected)
        .bind(row.evolve_revision+1).execute(&mut **tx).await.map_err(db)?;
    Ok(true)
}

async fn retire_case(tx: &mut Tx<'_>, row: &LoopRow, id: &str) -> ApiResult<bool> {
    let retired: Option<bool> = sqlx::query_scalar("SELECT retired_revision IS NOT NULL FROM learning_evolve_cases WHERE (project_id,bundle_id,case_id)=($1,$2,$3)")
        .bind(&row.project_id).bind(row.bundle_id).bind(id).fetch_optional(&mut **tx).await.map_err(db)?;
    match retired {
        None => Err(invalid("Cannot retire an unknown case")),
        Some(true) => Ok(false),
        Some(false) => {
            sqlx::query("UPDATE learning_evolve_cases SET retired_revision=$4 WHERE (project_id,bundle_id,case_id)=($1,$2,$3)")
                .bind(&row.project_id).bind(row.bundle_id).bind(id).bind(row.evolve_revision+1)
                .execute(&mut **tx).await.map_err(db)?;
            Ok(true)
        }
    }
}

pub(super) async fn submit_cases(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let bundle = path(&bundle)?;
    let (mut tx, actor) = actor_tx(&s, &h, &project, "evaluate").await?;
    let row = require_loop(&mut tx, &project, bundle, true).await?;
    require_app(&actor, &row.app_principal)?;
    let request = body(raw)?;
    let input: CasesRequest = parse(&request)?;
    if (input.cases.is_empty() && input.retire.is_empty())
        || input.cases.len() > 100
        || input.retire.len() > 100
    {
        return Err(invalid("Send one to 100 additions or retirements per list"));
    }
    let mut ids = HashSet::new();
    for id in input.cases.iter().map(|c| &c.case_id).chain(&input.retire) {
        if !valid_case_id(id) || !ids.insert(id) {
            return Err(invalid("Invalid or duplicate evolve case ID"));
        }
    }
    for case in &input.cases {
        if case.case_id.starts_with("outcome:") {
            return Err(invalid("Outcome case IDs are reserved"));
        }
        validate_example(&case.input, &case.expected)?;
    }
    let command = DurableCommand::optional(
        &h,
        &project,
        bundle,
        "evolve-cases",
        &actor.principal,
        request,
    )?;
    if let Some(command) = &command
        && let Some(receipt) = command
            .replay(&mut tx, || conflict("Idempotency key already used"))
            .await?
    {
        return Ok(Json(receipt));
    }
    let mut added = 0;
    let mut retired = 0;
    for case in &input.cases {
        added += usize::from(add_case(&mut tx, &row, case).await?);
    }
    for id in &input.retire {
        retired += usize::from(retire_case(&mut tx, &row, id).await?);
    }
    let mut revision = row.evolve_revision;
    if added + retired > 0 {
        bump(&mut tx, &row).await?;
        revision += 1;
    }
    let live = live_count(&mut tx, &project, bundle, revision)
        .await
        .map_err(db)?;
    audit(
        &mut tx,
        &actor,
        &project,
        bundle,
        "/evolve-cases",
        h.get("idempotency-key").and_then(|v| v.to_str().ok()),
    )
    .await?;
    DurableCommand::finish_optional(
        command,
        tx,
        json!({"evolveRevision":revision,"added":added,"retired":retired,"liveCases":live}),
    )
    .await
}

pub(super) async fn submit_outcome(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let bundle = path(&bundle)?;
    let (mut tx, actor) = actor_tx(&s, &h, &project, "evaluate").await?;
    let row = require_loop(&mut tx, &project, bundle, true).await?;
    require_app(&actor, &row.app_principal)?;
    let request = body(raw)?;
    let outcome: Outcome = parse(&request)?;
    validate_example(&outcome.input, &outcome.expected)?;
    let command = DurableCommand::new(
        &project,
        bundle,
        "outcome",
        &actor.principal,
        outcome.outcome_id,
        request,
    );
    if let Some(receipt) = command
        .replay(&mut tx, || conflict("Outcome ID already used"))
        .await?
    {
        return Ok(Json(receipt));
    }
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM versions WHERE (project_id,bundle_id,id,digest)=($1,$2,$3,$4))")
        .bind(&project).bind(bundle).bind(outcome.version_id).bind(&outcome.digest)
        .fetch_one(&mut *tx).await.map_err(db)?;
    if !valid {
        return Err(invalid(
            "Outcome version or digest does not match this bundle",
        ));
    }
    let case_id = format!("outcome:{}", outcome.outcome_id);
    let revision = row.evolve_revision + 1;
    sqlx::query("INSERT INTO learning_evolve_cases(project_id,bundle_id,case_id,input,expected,source,outcome_id,version_id,added_revision)
                 VALUES($1,$2,$3,$4,$5,'outcome',$6,$7,$8)")
        .bind(&project).bind(bundle).bind(&case_id).bind(&outcome.input).bind(&outcome.expected)
        .bind(outcome.outcome_id).bind(outcome.version_id).bind(revision)
        .execute(&mut *tx).await.map_err(db)?;
    bump(&mut tx, &row).await?;
    audit(
        &mut tx,
        &actor,
        &project,
        bundle,
        "/outcomes",
        Some(&outcome.outcome_id.to_string()),
    )
    .await?;
    command
        .finish(
            tx,
            json!({"outcomeId":outcome.outcome_id,"caseId":case_id,"evolveRevision":revision}),
        )
        .await
}
