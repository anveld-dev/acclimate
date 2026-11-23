use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outcome {
    #[serde(default, deserialize_with = "present_json")]
    output: Option<Value>,
    outcome_id: Uuid,
    version_id: Uuid,
    digest: String,
    input: Value,
    expected: Value,
    #[serde(default)]
    grading: Option<Value>,
}

// Preserve an explicitly reported JSON null as a delivered output.
fn present_json<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
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

pub(super) async fn submit_outcome(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let bundle = path(&bundle)?;
    let (mut tx, actor) = actor_tx(&s, &h, &project, "write").await?;
    require_loop(&mut tx, &project, bundle, true).await?;
    let request = body(raw)?;
    let outcome: Outcome = parse(&request)?;
    validate_example(&outcome.input, &outcome.expected)?;
    let grading = imports::grading(outcome.grading.as_ref(), &outcome.expected).map_err(invalid)?;
    if let Some(output) = &outcome.output {
        let equal: bool = sqlx::query_scalar("SELECT $1::jsonb=$2::jsonb")
            .bind(output)
            .bind(&outcome.expected)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if equal {
            return Err(invalid("Expected answer must differ from reported output"));
        }
    }
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
    let group = outcome.outcome_id.to_string();
    let split = tasks::Split::of(&group);
    let rev = if grading == "criteria" {
        // The task is written once conversion drafts its criteria from the expected answer.
        let mut source = json!({"outcomeId":outcome.outcome_id,"versionId":outcome.version_id});
        if let Some(output) = outcome.output {
            source["output"] = output;
        }
        imports::queue_outcome(
            &mut tx,
            &project,
            bundle,
            &actor.principal,
            source,
            &outcome.input,
            &outcome.expected,
        )
        .await?;
        sqlx::query_scalar(
            "SELECT task_revision FROM learning_loops WHERE (project_id,bundle_id)=($1,$2)",
        )
        .bind(&project)
        .bind(bundle)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?
    } else {
        let mut task = tasks::Task::pending(
            outcome.input.clone(),
            json!({"type":"exact","expected":outcome.expected}),
            group,
            "outcome",
            &actor.principal,
        );
        task.task_id = case_id.clone();
        task.outcome_id = Some(outcome.outcome_id);
        task.version_id = Some(outcome.version_id);
        task.output = outcome.output;
        task.confirmed_by = Some(actor.principal.clone());
        let rev = tasks::revision(&mut tx, &project, bundle).await?;
        tasks::insert(&mut tx, &project, bundle, split, &task, rev).await?;
        rev
    };
    let receipt = if split == tasks::Split::Evolve {
        json!({"outcomeId":outcome.outcome_id,"taskId":case_id,"taskRevision":rev})
    } else {
        json!({"outcomeId":outcome.outcome_id,"taskRevision":rev,"heldOutCount":1})
    };
    audit(
        &mut tx,
        &actor,
        &project,
        bundle,
        "/outcomes",
        Some(&outcome.outcome_id.to_string()),
    )
    .await?;
    command.finish(tx, receipt).await
}
