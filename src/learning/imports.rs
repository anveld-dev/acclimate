use super::tasks::{self, Split, Task};
use super::*;
use calamine::{Reader, Xlsx};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Seek};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const LIMIT: usize = 64 * 1024 * 1024;
#[derive(Serialize)]
struct Row {
    row: i64,
    material: Value,
}
fn fields(headers: &[String], values: impl Iterator<Item = Value>) -> Value {
    Value::Object(headers.iter().cloned().zip(values).collect())
}
fn parse_rows(format: &str, mut file: impl Read + Seek) -> ApiResult<Vec<Row>> {
    const MAX_ROWS: usize = 10_000;
    let limit_error = || invalid("Import exceeds 10,000 rows");
    let mut rows = Vec::new();
    match format {
        "csv" => {
            let mut csv = csv::Reader::from_reader(file);
            let headers = csv
                .headers()
                .map_err(|_| invalid("Invalid CSV header"))?
                .iter()
                .map(String::from)
                .collect::<Vec<_>>();
            for record in csv.records() {
                if rows.len() >= MAX_ROWS {
                    return Err(limit_error());
                }
                let r = record.map_err(|e| {
                    invalid(format!(
                        "Invalid CSV on line {}",
                        e.position().map_or(1, |p| p.line())
                    ))
                })?;
                rows.push(Row {
                    row: r.position().unwrap().line() as i64,
                    material: fields(&headers, r.iter().map(|v| json!(v))),
                });
            }
        }
        "xlsx" => {
            // Bound expanded XML and use sparse cells so a distant cell cannot allocate a dense sheet.
            let mut archive = zip::ZipArchive::new(&mut file)
                .map_err(|_| invalid("Invalid spreadsheet archive"))?;
            let mut remaining = 256 * 1024 * 1024u64;
            for i in 0..archive.len() {
                let entry = archive
                    .by_index(i)
                    .map_err(|_| invalid("Invalid spreadsheet entry"))?;
                let count = std::io::copy(&mut entry.take(remaining + 1), &mut std::io::sink())
                    .map_err(|_| invalid("Invalid spreadsheet entry"))?;
                remaining = remaining
                    .checked_sub(count)
                    .ok_or_else(|| invalid("Spreadsheet exceeds expanded size limit"))?;
            }
            drop(archive);
            file.rewind()
                .map_err(|_| invalid("Unreadable spreadsheet"))?;
            let mut book: Xlsx<_> = Xlsx::new(file).map_err(|_| invalid("Invalid spreadsheet"))?;
            let names = book.sheet_names();
            for (index, name) in names.iter().enumerate() {
                let mut reader = book
                    .worksheet_cells_reader(name)
                    .map_err(|_| invalid("Invalid worksheet"))?;
                let mut headers = std::collections::HashMap::new();
                let mut header_row = None;
                let mut material =
                    std::collections::BTreeMap::<u32, serde_json::Map<String, Value>>::new();
                while let Some(cell) = reader
                    .next_cell()
                    .map_err(|_| invalid("Invalid spreadsheet cell"))?
                {
                    let (row, col) = cell.get_position();
                    let value = calamine::Data::from(cell.get_value().clone());
                    if row == *header_row.get_or_insert(row) {
                        headers.insert(col, value.to_string());
                    } else if let Some(key) = headers.get(&col) {
                        let v = match value {
                            calamine::Data::Int(v) => json!(v),
                            calamine::Data::Float(v) => json!(v),
                            calamine::Data::Bool(v) => json!(v),
                            calamine::Data::Empty => Value::Null,
                            v => json!(v.to_string()),
                        };
                        if !material.contains_key(&row) && rows.len() + material.len() >= MAX_ROWS {
                            return Err(limit_error());
                        }
                        material.entry(row).or_default().insert(key.clone(), v);
                    }
                }
                for (row, obj) in material {
                    // Excel worksheets have at most 1,048,576 rows.
                    rows.push(Row {
                        row: (index as i64) * 1_048_576 + i64::from(row) + 1,
                        material: Value::Object(obj),
                    });
                }
            }
        }
        "jsonl" => {
            for (i, line) in BufReader::new(file).lines().enumerate() {
                let line = line.map_err(|_| invalid("Expected UTF-8 JSONL"))?;
                if line.trim().is_empty() {
                    continue;
                }
                if rows.len() >= MAX_ROWS {
                    return Err(limit_error());
                }
                let line = if i == 0 {
                    line.trim_start_matches('\u{feff}')
                } else {
                    &line
                };
                rows.push(Row {
                    row: i as i64 + 1,
                    material: serde_json::from_str(line)
                        .map_err(|_| invalid(format!("Invalid JSON on line {}", i + 1)))?,
                });
            }
        }
        "text" => {
            let mut text = String::new();
            file.read_to_string(&mut text)
                .map_err(|_| invalid("Expected UTF-8 text"))?;
            let text = text.trim_start_matches('\u{feff}');
            if !text.trim().is_empty() {
                rows.push(Row {
                    row: 1,
                    material: json!(text),
                });
            }
        }
        _ => return Err(invalid("Unsupported import format")),
    }
    if rows.is_empty() {
        return Err(invalid("Import contains no rows"));
    }
    Ok(rows)
}
#[derive(Deserialize)]
pub(super) struct Upload {
    filename: Option<String>,
}
pub(super) async fn upload(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    Query(q): Query<Upload>,
    h: HeaderMap,
    body: axum::body::Body,
) -> Reply {
    let b = path(&b)?;
    let (mut tx, _) = actor_tx(&s, &h, &p, "write").await?;
    require_loop(&mut tx, &p, b, false).await?;
    let media = h
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    let source = q.filename.unwrap_or_else(|| "paste".into());
    let format = match media {
        "text/plain" => "text",
        "text/csv" => "csv",
        "application/x-ndjson" | "application/jsonl" => "jsonl",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        _ => source.rsplit_once('.').map_or("text", |(_, ext)| ext),
    }
    .to_ascii_lowercase();
    // Release the authorization transaction while the client streams its body.
    tx.commit().await.map_err(db)?;
    let mut file = tokio::fs::File::from_std(tempfile::tempfile().map_err(db)?);
    let mut stream = body.into_data_stream();
    let mut size = 0usize;
    let mut digest = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| invalid("Incomplete import body"))?;
        size = size.saturating_add(chunk.len());
        if size > LIMIT {
            return Err(err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "Import exceeds 64 MiB",
            ));
        }
        digest.update(&chunk);
        file.write_all(&chunk).await.map_err(db)?;
    }
    file.rewind().await.map_err(db)?;
    let file = file.into_std().await;
    let material_format = if format == "text" {
        "conversations"
    } else {
        "rows"
    };
    let rows = tokio::task::spawn_blocking(move || parse_rows(&format, file))
        .await
        .map_err(|_| invalid("Import parser failed"))??;
    let (mut tx, a) = actor_tx(&s, &h, &p, "write").await?;
    let id = Uuid::new_v4();
    let total = rows.len();
    let digest = hex::encode(digest.finalize());
    let inserted=sqlx::query("INSERT INTO learning_task_imports(id,project_id,bundle_id,author,source,format,row_count,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(project_id,bundle_id,digest) DO NOTHING")
        .bind(id)
        .bind(&p)
        .bind(b)
        .bind(&a.principal)
        .bind(&source)
        .bind(material_format)
        .bind(total as i64)
        .bind(&digest)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if inserted.rows_affected() == 0 {
        let receipt=sqlx::query_scalar("SELECT jsonb_build_object('importId',id,'rows',row_count,'converted',converted_rows,'setAsideCount',set_aside_rows,'pending',row_count-converted_rows-set_aside_rows) FROM learning_task_imports WHERE (project_id,bundle_id,digest)=($1,$2,$3)").bind(&p).bind(b).bind(digest).fetch_one(&mut *tx).await.map_err(db)?;
        return Ok(Json(receipt));
    }
    let mut cards = Vec::new();
    let mut set_aside = Vec::new();
    for r in rows.chunks(512) {
        sqlx::query("INSERT INTO learning_task_import_rows(import_id,row_number,material) SELECT $1,(r->>'row')::bigint,r->'material' FROM jsonb_array_elements($2) r")
        .bind(id)
        .bind(json!(r))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        for r in r {
            if let (Some(input), Some(expected)) =
                (r.material.get("input"), r.material.get("expected"))
            {
                cards.push(ConvertedCard {
                    row: r.row,
                    group: format!("row:{}", r.row),
                    input: input.clone(),
                    grader: json!({"type":"exact","expected":expected}),
                    criteria_drafted: false,
                });
            } else if json!({"row":r.row,"source":format!("row:{}",r.row),"material":r.material})
                .to_string()
                .len()
                > crate::executor::trials::CONVERSION_BYTES
            {
                set_aside.push(SetAside {
                    row: r.row,
                    reason: "too-large".into(),
                });
            }
        }
    }
    let aside_count = set_aside.len();
    let converted = cards.len();
    let created =
        write_conversion_output(&mut tx, id, ConversionOutput { cards, set_aside }).await?;
    audit(&mut tx, &a, &p, b, "/tasks/import", None).await?;
    tx.commit().await.map_err(db)?;
    let mut receipt = json!({"importId":id,"rows":total,"converted":converted,"setAsideCount":aside_count,"pending":total-converted-aside_count});
    if a.user_id.is_some() {
        receipt["cards"] = json!(created);
    }
    Ok(Json(receipt))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConvertedCard {
    row: i64,
    group: String,
    input: Value,
    grader: Value,
    criteria_drafted: bool,
}
#[derive(Deserialize, Serialize)]
pub(crate) struct SetAside {
    row: i64,
    reason: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionOutput {
    cards: Vec<ConvertedCard>,
    set_aside: Vec<SetAside>,
}
pub(crate) async fn rows_awaiting_conversion(tx: &mut Tx<'_>, id: Uuid) -> ApiResult<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('format',i.format,'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('row',r.row_number,'source','row:' || r.row_number,'material',r.material) ORDER BY r.row_number) FROM learning_task_import_rows r WHERE r.import_id=i.id AND r.status='pending'),'[]')) FROM learning_task_imports i WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or_else(||missing("Import not found"))
}
fn contains_reference(material: &Value, reference: &Value) -> bool {
    material == reference
        || match material {
            Value::Array(items) => items.iter().any(|v| contains_reference(v, reference)),
            Value::Object(fields) => fields.values().any(|v| contains_reference(v, reference)),
            Value::String(text) => reference
                .as_str()
                .is_some_and(|r| !r.is_empty() && text.contains(r)),
            _ => false,
        }
}

pub(crate) async fn write_conversion_output(
    tx: &mut Tx<'_>,
    id: Uuid,
    result: ConversionOutput,
) -> ApiResult<Vec<Value>> {
    // Isolate partial writes so the result handler can commit a terminal rejection.
    use sqlx::Acquire;
    let mut savepoint = tx.begin().await.map_err(db)?;
    let cards = apply_conversion(&mut savepoint, id, result).await?;
    savepoint.commit().await.map_err(db)?;
    Ok(cards)
}
fn input_alias(input: &Value) -> String {
    let normalized = input.as_str().map_or_else(
        || input.to_string(),
        |text| {
            json!(
                text.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
            )
            .to_string()
        },
    );
    format!("input:{}", hex::encode(Sha256::digest(normalized)))
}

/// A shared source or normalized input connects cards. Resolve the entire batch before
/// writing any cards so the result also handles chains of matches across several rows.
async fn import_groups(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    digest: &str,
    cards: &[ConvertedCard],
) -> ApiResult<std::collections::HashMap<String, String>> {
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    let mut edges = BTreeMap::<String, Vec<String>>::new();
    for c in cards {
        let source = format!("import:{digest}:{}", c.group);
        let input = input_alias(&c.input);
        edges.entry(source.clone()).or_default().push(input.clone());
        edges.entry(input).or_default().push(source);
    }
    let known: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT alias,"group" FROM learning_task_groups
        WHERE (project_id,bundle_id)=($1,$2) AND alias=ANY($3)"#,
    )
    .bind(project)
    .bind(bundle)
    .bind(edges.keys().cloned().collect::<Vec<_>>())
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    let known: HashMap<_, _> = known.into_iter().collect();
    let mut assignments = HashMap::new();
    while let Some((root, _)) = edges.first_key_value() {
        let root = root.clone();
        let mut stack = vec![root.clone()];
        let mut members = Vec::new();
        let mut assigned = BTreeSet::new();
        while let Some(alias) = stack.pop() {
            if let Some(neighbors) = edges.remove(&alias) {
                stack.extend(neighbors);
                if let Some(group) = known.get(&alias) {
                    assigned.insert(group);
                }
                members.push(alias);
            }
        }
        if assigned.len() > 1 {
            return Err(conflict("Import joins previously assigned task groups"));
        }
        let group = assigned.first().copied().unwrap_or(&root);
        for alias in members {
            assignments.insert(alias, group.clone());
        }
    }
    sqlx::query(r#"INSERT INTO learning_task_groups(project_id,bundle_id,alias,"group") SELECT $1,$2,key,value FROM jsonb_each_text($3) ON CONFLICT DO NOTHING"#)
        .bind(project).bind(bundle).bind(json!(assignments)).execute(&mut **tx).await.map_err(db)?;
    Ok(assignments)
}

async fn apply_conversion(
    tx: &mut Tx<'_>,
    id: Uuid,
    result: ConversionOutput,
) -> ApiResult<Vec<Value>> {
    let (p,b,source,author,digest):(String,Uuid,String,String,String)=sqlx::query_as("SELECT project_id,bundle_id,source,author,digest FROM learning_task_imports WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or_else(||missing("Import not found"))?;
    let mut states = std::collections::BTreeMap::new();
    for c in &result.cards {
        if c.group.trim().is_empty() || c.group.len() > 1024 {
            return Err(invalid("Invalid conversion group"));
        }
        states.insert(c.row, None);
    }
    for aside in &result.set_aside {
        if aside.reason.trim().is_empty() || states.insert(aside.row, Some(&aside.reason)).is_some()
        {
            return Err(invalid("Conflicting conversion result"));
        }
    }
    let available: Vec<(i64,Value)>=sqlx::query_as("SELECT row_number,material FROM learning_task_import_rows WHERE import_id=$1 AND status='pending' AND row_number=ANY($2)")
        .bind(id)
        .bind(states.keys().copied().collect::<Vec<_>>())
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?;
    if available.len() != states.len() {
        return Err(invalid(
            "Conversion refers to a row outside pending material",
        ));
    }
    let material: std::collections::HashMap<_, _> = available.into_iter().collect();
    let mut cards = Vec::new();
    // The loop revision lock serializes alias assignments across concurrent imports.
    let revision = if result.cards.is_empty() {
        0
    } else {
        tasks::revision(tx, &p, b).await?
    };
    let assignments = import_groups(tx, &p, b, &digest, &result.cards).await?;
    for c in result.cards {
        let group = assignments[&format!("import:{digest}:{}", c.group)].clone();
        let mut task = Task::pending(c.input, c.grader, group, "import", &author);
        task.source_file = Some(source.clone());
        task.source_row = Some(c.row);
        if !c.criteria_drafted
            && task
                .grader
                .get("expected")
                .or_else(|| task.grader.get("reference"))
                .is_some_and(|r| contains_reference(&material[&c.row], r))
        {
            task.confirmed_by = Some(author.clone());
        }
        let split = Split::of(&task.group);
        task.added_revision = revision;
        tasks::validate(&task)?;
        let mut card = json!(task);
        card["split"] = json!(split.name());
        cards.push(card);
    }
    for split in [Split::Evolve, Split::HeldOut] {
        let batch: Vec<_> = cards
            .iter()
            .filter(|c| c["split"] == split.name())
            .collect();
        if !batch.is_empty() {
            sqlx::query(&format!(r#"INSERT INTO {}(project_id,bundle_id,task_id,"group",input,grader,source,author,source_file,source_row,confirmed_by,added_revision)
                SELECT $1,$2,c->>'taskId',c->>'group',c->'input',c->'grader','import',c->>'author',c->>'sourceFile',(c->>'sourceRow')::bigint,c->>'confirmedBy',$3 FROM jsonb_array_elements($4) c"#,split.table()))
                .bind(&p).bind(b).bind(revision).bind(json!(batch)).execute(&mut **tx).await.map_err(db)?;
        }
    }
    let set_aside_count = result.set_aside.len() as i64;
    sqlx::query("UPDATE learning_task_imports SET converted_rows=converted_rows+$2,set_aside_rows=set_aside_rows+$3 WHERE id=$1")
        .bind(id).bind(states.len() as i64-set_aside_count).bind(set_aside_count).execute(&mut **tx).await.map_err(db)?;
    let updates: Vec<_> = states
        .into_iter()
        .map(|(row, reason)| json!({"row":row,"reason":reason}))
        .collect();
    sqlx::query("UPDATE learning_task_import_rows r SET status=CASE WHEN u.reason IS NULL THEN 'converted' ELSE 'set-aside' END,reason=u.reason FROM jsonb_to_recordset($2) AS u(row bigint,reason text) WHERE import_id=$1 AND row_number=u.row")
        .bind(id).bind(json!(updates)).execute(&mut **tx).await.map_err(db)?;
    Ok(cards)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_csv_jsonl_and_paste() {
        let csv = parse_rows(
            "csv",
            Cursor::new(b"input,expected\n\"multi\nline\",answer\nnext,ok\n"),
        )
        .unwrap();
        assert_eq!(csv[0].row, 2);
        assert_eq!(csv[1].row, 4);
        assert_eq!(csv[0].material["input"], "multi\nline");
        let rows = parse_rows(
            "jsonl",
            Cursor::new(b"\n{\"input\":null,\"expected\":false}\n"),
        )
        .unwrap();
        assert_eq!(rows[0].row, 2);
        assert_eq!(rows[0].material["expected"], false);
        assert_eq!(
            parse_rows("text", Cursor::new(b"two\nturns")).unwrap()[0].material,
            "two\nturns"
        );
    }
    #[test]
    fn parse_limits_and_bom() {
        assert!(parse_rows("jsonl", Cursor::new("0\n".repeat(10001))).is_err());
        assert_eq!(
            parse_rows("jsonl", Cursor::new("\u{feff}42")).unwrap()[0].material,
            42
        );
        let err = parse_rows("csv", Cursor::new("one,two\n1,2\n3\n"))
            .err()
            .unwrap();
        assert!(err.2.contains("line 3"));
    }

    #[test]
    fn spreadsheet_preserves_cell_types_and_source_rows() {
        let rows = parse_rows(
            "xlsx",
            Cursor::new(include_bytes!(
                "../../contracts/fixtures/learning-task-import.xlsx"
            )),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].row, 5);
        assert_eq!(rows[0].material["input"].as_f64(), Some(42.0));
        assert_eq!(rows[0].material["expected"], true);
    }
    use std::io::Cursor;

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn conversion_material_and_revision_checked_admission(pool: sqlx::PgPool) {
        let mut tx = pool.begin().await.unwrap();
        let b = Uuid::new_v4();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO projects(id,name) VALUES('p','p')")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO bundles(id,project_id,name) VALUES($1,'p','b')")
            .bind(b)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES($1,'p',$2,$3,$4,'test')")
            .bind(id).bind(b).bind(format!("sha256:{}","a".repeat(64))).bind(&include_bytes!("../../contracts/fixtures/bundle-v1.json")[..]).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES('p',$1,'stable',1,$2)")
        .bind(b)
        .bind(id)
        .execute(&mut *tx)
        .await.unwrap();
        sqlx::query("INSERT INTO learning_loops(project_id,bundle_id,channel,setting,enrolled_by) VALUES('p',$1,'stable','{}','test')")
        .bind(b)
        .execute(&mut *tx)
        .await.unwrap();
        sqlx::query("INSERT INTO learning_task_imports(id,project_id,bundle_id,source,digest,author,format,row_count) VALUES($1,'p',$2,'tickets.csv','digest','author','rows',2)")
        .bind(id)
        .bind(b)
        .execute(&mut *tx)
        .await.unwrap();
        sqlx::query("INSERT INTO learning_task_import_rows(import_id,row_number,material) VALUES($1,1,'{}'),($1,2,'{}')")
        .bind(id)
        .execute(&mut *tx)
        .await.unwrap();
        let material = rows_awaiting_conversion(&mut tx, id).await.unwrap();
        assert_eq!(material["rows"][1]["source"], "row:2");
        assert_eq!(material["rows"][1]["row"], 2);
        let group = (1..)
            .map(|i| i.to_string())
            .find(|g| Split::of(&format!("import:digest:{g}")) == Split::HeldOut)
            .unwrap();
        let result = |row| {
            serde_json::from_value(json!({"cards":[{"row":row,"input":"a","group":group,"criteriaDrafted":true,"grader":{"type":"criteria","criteria":["a"]}}],"setAside":[{"row":2,"reason":"no-reference"}]})).unwrap()
        };
        assert!(
            write_conversion_output(&mut tx, id, result(3))
                .await
                .is_err()
        );
        let cards = write_conversion_output(&mut tx, id, result(1))
            .await
            .unwrap();
        assert_eq!(cards[0]["split"], "held-out");
        assert_eq!(
            rows_awaiting_conversion(&mut tx, id).await.unwrap()["rows"],
            json!([])
        );
        let task = cards[0]["taskId"].as_str().unwrap();
        assert!(
            !tasks::set_admission(&mut tx, "p", b, Split::HeldOut, task, 1, "admitted", None)
                .await
                .unwrap()
        );
        sqlx::query("UPDATE learning_held_out_tasks SET confirmed_by='user'")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert!(
            !tasks::set_admission(&mut tx, "p", b, Split::HeldOut, task, 2, "admitted", None)
                .await
                .unwrap()
        );
        assert!(
            tasks::set_admission(&mut tx, "p", b, Split::HeldOut, task, 1, "admitted", None)
                .await
                .unwrap()
        );
        let stamp:(i64,i64)=sqlx::query_as("SELECT t.admission_revision,l.task_revision FROM learning_round_held_out_tasks t JOIN learning_loops l USING(project_id,bundle_id)").fetch_one(&mut *tx).await.unwrap();
        assert_eq!(stamp, (2, 2));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM learning_round_held_out_tasks")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
