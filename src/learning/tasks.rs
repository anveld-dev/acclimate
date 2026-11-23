use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Split {
    Evolve,
    HeldOut,
}
impl Split {
    pub(crate) fn of(group: &str) -> Self {
        if Sha256::digest(group.as_bytes())[0] < 128 {
            Self::HeldOut
        } else {
            Self::Evolve
        }
    }
    pub(super) fn table(self) -> &'static str {
        match self {
            Self::Evolve => "learning_tasks",
            Self::HeldOut => "learning_held_out_tasks",
        }
    }
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Evolve => "evolve",
            Self::HeldOut => "held-out",
        }
    }
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Task {
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag_reason: Option<String>,
    pub task_id: String,
    pub group: String,
    pub input: Value,
    pub grader: Value,
    pub source: String,
    pub author: Option<String>,
    pub source_file: Option<String>,
    pub source_row: Option<i64>,
    pub outcome_id: Option<Uuid>,
    pub version_id: Option<Uuid>,
    pub output: Option<Value>,
    pub confirmed_by: Option<String>,
    pub admission: String,
    pub admission_reason: Option<String>,
    pub added_revision: i64,
}
impl Task {
    pub(super) fn pending(
        input: Value,
        grader: Value,
        group: String,
        source: &str,
        author: &str,
    ) -> Self {
        Self {
            flag_reason: None,
            task_id: Uuid::new_v4().to_string(),
            group,
            input,
            grader,
            source: source.into(),
            author: Some(author.into()),
            source_file: None,
            source_row: None,
            outcome_id: None,
            version_id: None,
            output: None,
            confirmed_by: None,
            admission: "pending".into(),
            admission_reason: None,
            added_revision: 0,
        }
    }
}
pub(super) fn validate(t: &Task) -> ApiResult<()> {
    if !crate::executor::trials::valid_grader(&t.grader)
        || t.input.to_string().len() > 65536
        || t.grader
            .get("expected")
            .is_some_and(|x| x.to_string().len() > 65536)
    {
        return Err(invalid("Invalid task input or grader"));
    }
    Ok(())
}
pub(super) async fn revision(tx: &mut Tx<'_>, project: &str, bundle: Uuid) -> ApiResult<i64> {
    sqlx::query_scalar("UPDATE learning_loops SET task_revision=task_revision+1 WHERE (project_id,bundle_id)=($1,$2) RETURNING task_revision")
    .bind(project).bind(bundle).fetch_one(&mut **tx).await.map_err(db)
}
pub(super) async fn insert(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    split: Split,
    t: &Task,
    rev: i64,
) -> ApiResult<()> {
    validate(t)?;
    let q = format!(
        r#"INSERT INTO {}(project_id,bundle_id,task_id,"group",input,grader,source,author,source_file,source_row,outcome_id,version_id,output,confirmed_by,added_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)"#,
        split.table()
    );
    sqlx::query(&q)
        .bind(project)
        .bind(bundle)
        .bind(&t.task_id)
        .bind(&t.group)
        .bind(&t.input)
        .bind(&t.grader)
        .bind(&t.source)
        .bind(&t.author)
        .bind(&t.source_file)
        .bind(t.source_row)
        .bind(t.outcome_id)
        .bind(t.version_id)
        .bind(&t.output)
        .bind(&t.confirmed_by)
        .bind(rev)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct New {
    input: Value,
    grader: Value,
}
pub(super) async fn create(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let b = path(&b)?;
    let (mut tx, a) = actor_tx(&s, &h, &p, "write").await?;
    require_loop(&mut tx, &p, b, true).await?;
    let n: New = parse(&body(raw)?)?;
    let group = format!(
        "console:{}",
        hex::encode(Sha256::digest(n.input.to_string()))
    );
    let mut t = Task::pending(n.input, n.grader, group, "console", &a.principal);
    t.confirmed_by = a.user_id.as_ref().map(|_| a.principal.clone());
    let split = Split::of(&t.group);
    let rev = revision(&mut tx, &p, b).await?;
    insert(&mut tx, &p, b, split, &t, rev).await?;
    audit(&mut tx, &a, &p, b, "/tasks", None).await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(if split == Split::HeldOut && a.user_id.is_none() {
        json!({"heldOutCount":1})
    } else {
        json!({"taskId":t.task_id,"split":split.name(),"addedRevision":rev})
    }))
}

#[derive(Default, Deserialize)]
pub(super) struct Filter {
    split: Option<String>,
    source: Option<String>,
    admission: Option<String>,
    flagged: Option<bool>,
    after: Option<String>,
    limit: Option<i64>,
}
pub(super) async fn list(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    Query(f): Query<Filter>,
) -> Reply {
    read(s, p, path(&b)?, h, f, false).await
}
pub(super) async fn export(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
) -> Reply {
    read(
        s,
        p,
        path(&b)?,
        h,
        Filter {
            split: Some("held-out".into()),
            ..Default::default()
        },
        true,
    )
    .await
}
async fn read(s: AppState, p: String, b: Uuid, h: HeaderMap, f: Filter, export: bool) -> Reply {
    let (mut tx, a) = actor_tx(&s, &h, &p, "read").await?;
    if export && a.user_id.is_none() {
        return Err(denied());
    }
    require_loop(&mut tx, &p, b, false).await?;
    let limit = if export {
        i64::MAX - 1
    } else {
        f.limit.unwrap_or(20)
    };
    if (!export && !(1..=100).contains(&limit))
        || f.split
            .as_deref()
            .is_some_and(|v| !["evolve", "held-out"].contains(&v))
        || f.source
            .as_deref()
            .is_some_and(|v| !["console", "outcome", "import"].contains(&v))
        || f.admission
            .as_deref()
            .is_some_and(|v| !["pending", "admitted", "set-aside"].contains(&v))
    {
        return Err(invalid("Invalid task filters"));
    }
    let mut items = Vec::new();
    let mut held_out_count = 0i64;
    for split in [Split::Evolve, Split::HeldOut] {
        if f.split.as_deref().is_some_and(|v| v != split.name()) {
            continue;
        }
        let mut from = format!(
            "FROM {} WHERE (project_id,bundle_id)=($1,$2) AND retired_revision IS NULL AND ($3::text IS NULL OR source=$3) AND ($4::text IS NULL OR admission=$4)",
            split.table()
        );
        if let Some(flagged) = f.flagged {
            if split == Split::HeldOut && flagged {
                continue;
            }
            if split == Split::Evolve {
                let op = if flagged { "EXISTS" } else { "NOT EXISTS" };
                from.push_str(&format!(" AND {op} (SELECT 1 FROM learning_flagged_tasks flag WHERE (flag.project_id,flag.bundle_id,flag.task_id)=($1,$2,learning_tasks.task_id))"));
            }
        }
        if split == Split::HeldOut {
            held_out_count = sqlx::query_scalar(&format!("SELECT count(*) {from}"))
                .bind(&p)
                .bind(b)
                .bind(&f.source)
                .bind(&f.admission)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            if a.user_id.is_none() {
                continue;
            }
        }
        let flag = if split == Split::Evolve {
            "(SELECT reason FROM learning_flagged_tasks f WHERE (f.project_id,f.bundle_id,f.task_id)=($1,$2,learning_tasks.task_id))"
        } else {
            "NULL::text"
        };
        let rows: Vec<Task> = sqlx::query_as(&format!(
            "SELECT *,{flag} AS flag_reason {from} AND task_id COLLATE \"C\">$5 ORDER BY task_id COLLATE \"C\" LIMIT $6"
        ))
        .bind(&p)
        .bind(b)
        .bind(&f.source)
        .bind(&f.admission)
        .bind(f.after.as_deref().unwrap_or(""))
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        for row in rows {
            let mut card = json!(row);
            card["split"] = json!(split.name());
            items.push(card);
        }
    }
    items.sort_by(|a, b| a["taskId"].as_str().cmp(&b["taskId"].as_str()));
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = items.last().filter(|_| more).map(|c| &c["taskId"]);
    Ok(Json(
        json!({"items":items,"next":next,"heldOutCount":held_out_count}),
    ))
}
type TaskPath = Path<(String, String, String)>;
pub(super) async fn edit(
    State(s): State<AppState>,
    Path((p, b, id)): TaskPath,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let patch = body(raw)?;
    if !patch.as_object().is_some_and(|o| {
        !o.is_empty()
            && o.keys()
                .all(|k| ["input", "grader", "confirm"].contains(&k.as_str()))
    }) || patch.get("confirm").is_some_and(|v| v != true)
    {
        return Err(invalid("Invalid task edit"));
    }
    change(s, p, path(&b)?, id, h, Some(patch)).await
}
pub(super) async fn retire(
    State(s): State<AppState>,
    Path((p, b, id)): TaskPath,
    h: HeaderMap,
) -> Reply {
    change(s, p, path(&b)?, id, h, None).await
}
async fn change(
    s: AppState,
    p: String,
    b: Uuid,
    id: String,
    h: HeaderMap,
    patch: Option<Value>,
) -> Reply {
    let (mut tx, a) = actor_tx(&s, &h, &p, "write").await?;
    require_loop(&mut tx, &p, b, true).await?;
    let rev = revision(&mut tx, &p, b).await?;
    if patch.as_ref().is_some_and(|v| v.get("confirm").is_some()) && a.user_id.is_none() {
        return Err(denied());
    }
    for split in [Split::Evolve, Split::HeldOut] {
        if split == Split::HeldOut && a.user_id.is_none() {
            continue;
        }
        let table = split.table();
        let Some(mut t): Option<Task> = sqlx::query_as(&format!("UPDATE {table} SET retired_revision=$4 WHERE (project_id,bundle_id,task_id)=($1,$2,$3) AND retired_revision IS NULL RETURNING *"))
        .bind(&p)
        .bind(b)
        .bind(&id)
        .bind(rev)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)? else {continue;};
        if let Some(patch) = patch {
            if let Some(v) = patch.get("input") {
                t.input = v.clone();
            }
            if let Some(v) = patch.get("grader") {
                t.grader = v.clone();
            }
            t.confirmed_by = a.user_id.as_ref().map(|_| a.principal.clone());
            insert(&mut tx, &p, b, split, &t, rev).await?;
        }
        audit(&mut tx, &a, &p, b, &format!("/tasks/{id}"), None).await?;
        tx.commit().await.map_err(db)?;
        return Ok(Json(json!({"taskId":id,"revision":rev})));
    }
    Err(missing("Task not found"))
}
/// Compare the checked revision so a stale grade cannot admit edited material.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_admission(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    split: Split,
    id: &str,
    revision: i64,
    admission: &str,
    reason: Option<&str>,
) -> ApiResult<bool> {
    if !["pending", "admitted", "set-aside"].contains(&admission)
        || ((admission == "set-aside") != reason.is_some())
    {
        return Err(invalid("Invalid admission"));
    }
    let evidence = if split == Split::HeldOut {
        " AND ($5 <> 'admitted' OR confirmed_by IS NOT NULL)"
    } else {
        ""
    };
    require_loop(tx, project, bundle, true).await?;
    let previous: Option<String> = sqlx::query_scalar(&format!("SELECT admission FROM {} WHERE (project_id,bundle_id,task_id,added_revision)=($1,$2,$3,$4) AND retired_revision IS NULL AND $5::text IS NOT NULL{evidence} FOR UPDATE",split.table()))
        .bind(project).bind(bundle).bind(id).bind(revision).bind(admission)
        .fetch_optional(&mut **tx).await.map_err(db)?;
    let Some(previous) = previous else {
        return Ok(false);
    };
    let stamp = if previous != admission && (previous == "admitted" || admission == "admitted") {
        Some(self::revision(tx, project, bundle).await?)
    } else {
        None
    };
    sqlx::query(&format!("UPDATE {} SET admission=$5,admission_reason=$6,admission_revision=coalesce($7,admission_revision) WHERE (project_id,bundle_id,task_id,added_revision)=($1,$2,$3,$4)",split.table()))
        .bind(project).bind(bundle).bind(id).bind(revision).bind(admission).bind(reason).bind(stamp)
        .execute(&mut **tx).await.map_err(db)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn group_split_matches_sdk_vectors() {
        let vectors: std::collections::BTreeMap<String, String> = serde_json::from_str(
            include_str!("../../contracts/fixtures/learning-task-split.json"),
        )
        .unwrap();
        for (group, expected) in vectors {
            assert_eq!(Split::of(&group).name(), expected);
        }
    }

    #[test]
    fn optimizer_has_no_held_out_task_query() {
        fn inspect(path: &std::path::Path) {
            if path.extension().is_some_and(|s| s == "rs") {
                let source = std::fs::read_to_string(path).unwrap().to_lowercase();
                for table in ["learning_held_out_tasks", "learning_round_held_out_tasks"] {
                    assert!(
                        !source.contains(table),
                        "{} references {table}",
                        path.display()
                    );
                }
            }
        }
        fn walk(root: &std::path::Path, path: &std::path::Path) {
            if path.is_dir() {
                for entry in std::fs::read_dir(path).unwrap() {
                    walk(root, &entry.unwrap().path())
                }
            } else if !matches!(
                path.strip_prefix(root).unwrap().to_str(),
                Some(
                    "executor/queue.rs"
                        | "learning/controls.rs"
                        | "learning/tasks.rs"
                        | "learning/imports.rs"
                )
            ) {
                inspect(path)
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        walk(&root, &root);
    }
}
