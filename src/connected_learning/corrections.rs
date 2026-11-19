use super::*;

pub(super) fn revision(value: &str) -> ApiResult<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == value)
        .ok_or_else(|| invalid("A canonical delivery revision is required"))
}

pub(super) fn validate_teaching(
    row: &PgRow,
    lesson: Option<&Lesson>,
    feedback: Option<&Feedback>,
) -> ApiResult<()> {
    if let Some(lesson) = lesson
        && (!bounded(&lesson.instruction, 4096)
            || !row
                .get::<Vec<String>, _>("permitted_paths")
                .contains(&lesson.path))
    {
        return Err(invalid(
            "Lesson must supply a bounded instruction for a permitted path",
        ));
    }
    if let Some(feedback) = feedback
        && (!bounded(&feedback.expected, 2048)
            || !bounded(&feedback.observed, 2048)
            || feedback.expected.trim() == feedback.observed.trim())
    {
        return Err(invalid(
            "Feedback must describe a bounded expected and observed discrepancy",
        ));
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Correction {
    correction_id: Uuid,
    outcome_id: Uuid,
    lesson: Option<Lesson>,
    feedback: Option<Feedback>,
    #[serde(default)]
    require_incident_replay: bool,
}

impl From<TaskOutcome> for Correction {
    fn from(outcome: TaskOutcome) -> Self {
        Self {
            correction_id: outcome.outcome_id,
            outcome_id: outcome.outcome_id,
            lesson: outcome.lesson,
            feedback: outcome.feedback,
            require_incident_replay: outcome.require_incident_replay,
        }
    }
}

pub(super) async fn locked(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<PgRow> {
    enrollment(tx, project, integration, true).await?;
    sqlx::query("SELECT e.*, i.enabled FROM connected_learning_enrollments e JOIN integrations i ON (i.project_id,i.id)=(e.project_id,e.integration_id)
                 WHERE e.project_id=$1 AND e.integration_id=$2 FOR UPDATE OF e")
        .bind(project).bind(integration).fetch_one(&mut **tx).await.map_err(db)
}

fn active(row: &PgRow) -> bool {
    row.get::<bool, _>("enabled")
        && row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("stopped_at")
            .is_none()
}

pub(super) async fn append(
    tx: &mut Transaction<'_, Postgres>,
    row: &PgRow,
    correction: &Correction,
    principal: &str,
) -> ApiResult<()> {
    let project: String = row.get("project_id");
    let bundle: Uuid = row.get("bundle_id");
    let integration: Uuid = row.get("integration_id");
    let lesson = correction
        .lesson
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(db)?;
    let feedback = correction
        .feedback
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(db)?;
    let command = crate::commands::DurableCommand::new(
        &project,
        integration,
        "correction",
        principal,
        correction.correction_id,
        serde_json::to_value(correction).map_err(db)?,
    );
    if command
        .replay(tx, || {
            conflict("Correction ID already binds different teaching")
        })
        .await?
        .is_some()
    {
        return Ok(());
    }
    validate_teaching(
        row,
        correction.lesson.as_ref(),
        correction.feedback.as_ref(),
    )?;
    if !active(row) {
        return Err(conflict("Learning admission is closed"));
    }
    let inserted = sqlx::query("INSERT INTO connected_learning_corrections
        (project_id,bundle_id,integration_id,correction_id,outcome_id,lesson,feedback,submitted_by,require_incident_replay)
        SELECT project_id,bundle_id,integration_id,$5,outcome_id,$6,$7,$8,$9 FROM connected_learning_outcomes
        WHERE (project_id,bundle_id,integration_id,outcome_id)=($1,$2,$3,$4)")
        .bind(&project).bind(bundle).bind(integration).bind(correction.outcome_id).bind(correction.correction_id).bind(lesson).bind(feedback).bind(principal).bind(correction.require_incident_replay)
        .execute(&mut **tx).await.map_err(db)?;
    if inserted.rows_affected() != 1 {
        return Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            "Outcome not found on this connection",
        ));
    }
    command.record(tx, &correction_response(correction)).await
}

fn correction_response(c: &Correction) -> Value {
    json!({"correctionId":c.correction_id,"outcomeId":c.outcome_id,"accepted":true})
}

pub(super) async fn submit(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(c): Json<Correction>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&h, &s, &project, "write")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "write").await?;
    let row = locked(&mut tx, &project, integration).await?;
    if actor.principal != row.get::<String, _>("outcome_principal") {
        return Err(denied());
    }
    if c.correction_id.is_nil() || (c.lesson.is_none() && c.feedback.is_none()) {
        return Err(invalid("A correction ID and teaching are required"));
    }
    append(&mut tx, &row, &c, &actor.principal).await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(correction_response(&c)))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Recheck {
    correction_id: Uuid,
    version_id: Uuid,
    digest: String,
    revision: String,
    verdict: String,
}

pub(super) async fn recheck(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(q): Json<Recheck>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&h, &s, &project, "write")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "write").await?;
    let enabled = crate::connected_learning_worker::evaluator_active(
        &mut tx,
        &s,
        &project,
        integration,
        &actor.principal,
    )
    .await?;
    if !matches!(
        q.verdict.as_str(),
        "reproduced" | "resolved" | "unavailable"
    ) {
        return Err(invalid("Invalid recheck verdict"));
    }
    let revision = revision(&q.revision)?;
    let response = Json(
        json!({"correctionId":q.correction_id,"revision":q.revision,"verdict":q.verdict,"accepted":true}),
    );
    let command = crate::commands::DurableCommand::new(
        &project,
        integration,
        "recheck",
        &actor.principal,
        format!("{}:{revision}", q.correction_id),
        serde_json::to_value(&q).map_err(db)?,
    );
    if let Some(response) = command
        .replay(&mut tx, || {
            conflict("A different recheck was recorded at this revision")
        })
        .await?
    {
        return Ok(Json(response));
    }
    if !enabled {
        return Err(conflict("Learning admission is closed"));
    }
    let accepted = sqlx::query("INSERT INTO connected_learning_replay_obligations
        (project_id,integration_id,bundle_id,correction_id,version_id,baseline_revision,verdict,evaluator)
        SELECT project_id,integration_id,bundle_id,correction_id,version_id,revision,
            CASE $7 WHEN 'reproduced' THEN 'pass' WHEN 'resolved' THEN 'regression' ELSE $7 END,$8 FROM connected_learning_correction_work
        WHERE (project_id,integration_id,correction_id,version_id,revision,digest)=($1,$2,$3,$4,$5,$6) AND action='recheck'
        ON CONFLICT(project_id,integration_id,correction_id,baseline_revision)
        DO UPDATE SET verdict=EXCLUDED.verdict,evaluator=EXCLUDED.evaluator
        WHERE connected_learning_replay_obligations.verdict IS NULL")
        .bind(&project).bind(integration).bind(q.correction_id).bind(q.version_id).bind(revision).bind(q.digest)
        .bind(&q.verdict).bind(&actor.principal).execute(&mut *tx).await.map_err(db)?;
    if accepted.rows_affected() != 1 {
        return Err(conflict(
            "Recheck does not match pending teaching on the current delivery",
        ));
    }
    if q.verdict == "resolved" {
        sqlx::query("UPDATE connected_learning_corrections SET pending=false WHERE (project_id,integration_id,correction_id)=($1,$2,$3)")
            .bind(&project).bind(integration).bind(q.correction_id).execute(&mut *tx).await.map_err(db)?;
    }
    command.finish(tx, response.0).await
}
