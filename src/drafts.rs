use crate::{ApiResult, AppState, BundlePayload, PromoteRequest, VersionMetadata, db, err, path};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    id: String,
    channel: String,
    base_version_id: String,
    base_revision: String,
    snapshot_version: VersionMetadata,
    generation: i64,
    status: String,
    created_at: String,
    updated_at: String,
    promotion_id: Option<String>,
}
fn draft(r: &PgRow) -> Draft {
    Draft {
        id: r.get::<Uuid, _>("draft_id").to_string(),
        channel: r.get("channel"),
        base_version_id: r.get::<Uuid, _>("base_version_id").to_string(),
        base_revision: r.get::<i64, _>("base_revision").to_string(),
        snapshot_version: crate::store::meta(r),
        generation: r.get("generation"),
        status: r.get("status"),
        created_at: r.get::<DateTime<Utc>, _>("draft_created").to_rfc3339(),
        updated_at: r.get::<DateTime<Utc>, _>("updated_at").to_rfc3339(),
        promotion_id: r
            .get::<Option<Uuid>, _>("promotion_id")
            .map(|x| x.to_string()),
    }
}
const SELECT: &str = "SELECT d.id AS draft_id,d.channel,d.base_version_id,d.base_revision,d.generation,d.status,d.created_at AS draft_created,d.updated_at,d.promotion_id,v.id,v.bundle_id,v.parent_version_id,v.digest,v.created_at FROM drafts d JOIN versions v ON v.project_id=d.project_id AND v.bundle_id=d.bundle_id AND v.id=d.snapshot_version_id";
fn invalid() -> crate::ApiErr {
    err(
        StatusCode::BAD_REQUEST,
        "invalid_content",
        "Invalid content request",
    )
}
fn decode<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|_| invalid())
}
fn payload(p: &BundlePayload) -> ApiResult<Vec<u8>> {
    crate::bundles::validate_payload(p)
        .map_err(|e| err(StatusCode::BAD_REQUEST, "invalid_content", e))?;
    crate::encode_payload(p)
}
async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    p: &str,
    b: Uuid,
    parent: Option<Uuid>,
    bytes: Vec<u8>,
    actor: &str,
) -> ApiResult<VersionMetadata> {
    let r=sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,bundle_id,parent_version_id,digest,created_at").bind(Uuid::new_v4()).bind(p).bind(b).bind(parent).bind(crate::digest(&bytes)).bind(bytes).bind(actor).fetch_one(&mut **tx).await.map_err(db)?;
    Ok(crate::store::meta(&r))
}
async fn read(
    tx: &mut Transaction<'_, Postgres>,
    p: &str,
    b: Uuid,
    c: &str,
    id: Uuid,
) -> ApiResult<Draft> {
    let r = sqlx::query(&format!(
        "{SELECT} WHERE d.project_id=$1 AND d.bundle_id=$2 AND d.channel=$3 AND d.id=$4"
    ))
    .bind(p)
    .bind(b)
    .bind(c)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Draft not found"))?;
    Ok(draft(&r))
}
async fn associate(
    tx: &mut Transaction<'_, Postgres>,
    p: &str,
    b: Uuid,
    c: &str,
    id: Uuid,
    g: i64,
    v: &str,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO draft_snapshots(project_id,bundle_id,channel,draft_id,generation,version_id) VALUES($1,$2,$3,$4,$5,$6)").bind(p).bind(b).bind(c).bind(id).bind(g).bind(path(v)?).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/workspaces/{project}/bundle-setups", post(setup))
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}/drafts",
            get(list).post(create),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}/drafts/{draft}",
            get(get_draft),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}/drafts/{draft}/history",
            get(history),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}/drafts/{draft}/save",
            post(save),
        )
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels/{channel}/drafts/{draft}/discard",
            post(discard),
        )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    base_version_id: String,
    base_revision: String,
    payload: BundlePayload,
}
async fn create(
    State(s): State<AppState>,
    Path((p, b, c)): Path<(String, String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    if crate::connected_learning::internal_channel(&c) {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "Channel not found"));
    }
    let a = crate::auth::actor(&h, &s, &p, "evaluate")?;
    let req: Create = decode(&body)?;
    // Operation key: the canonical route, see commands::operation_path.
    let route = format!("/v1/workspaces/{p}/bundles/{b}/channels/{c}/drafts");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let b = path(&b)?;
    let base = path(&req.base_version_id)?;
    let bytes = payload(&req.payload)?;
    let current=sqlx::query("SELECT version_id,revision FROM channels WHERE project_id=$1 AND bundle_id=$2 AND name=$3 FOR UPDATE").bind(&p).bind(b).bind(&c).fetch_optional(&mut *cmd.tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Channel not found"))?;
    let rev = current.get::<i64, _>("revision");
    if current.get::<Uuid, _>("version_id") != base || rev.to_string() != req.base_revision {
        return Err(err(
            StatusCode::CONFLICT,
            "base_conflict",
            "Channel base changed",
        ));
    }
    let v = snapshot(&mut cmd.tx, &p, b, Some(base), bytes, &a.principal).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO drafts(id,project_id,bundle_id,channel,base_version_id,base_revision,snapshot_version_id,generation,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,1,'open',$8)").bind(id).bind(&p).bind(b).bind(&c).bind(base).bind(rev).bind(path(&v.id)?).bind(&a.principal).execute(&mut *cmd.tx).await.map_err(db)?;
    associate(&mut cmd.tx, &p, b, &c, id, 1, &v.id).await?;
    let out = read(&mut cmd.tx, &p, b, &c, id).await?;
    crate::commands::finish_mutation(cmd, StatusCode::CREATED, out).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    expected_generation: i64,
    payload: Option<BundlePayload>,
}
async fn save(
    s: State<AppState>,
    p: Path<(String, String, String, String)>,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    change(s, p, h, b, "save").await
}
async fn discard(
    s: State<AppState>,
    p: Path<(String, String, String, String)>,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    change(s, p, h, b, "discard").await
}
async fn change(
    State(s): State<AppState>,
    Path((p, b, c, d)): Path<(String, String, String, String)>,
    h: HeaderMap,
    body: Bytes,
    kind: &str,
) -> ApiResult<Response> {
    if crate::connected_learning::internal_channel(&c) {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "Channel not found"));
    }
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    let req: Change = decode(&body)?;
    if req.expected_generation < 1 || (kind == "discard" && req.payload.is_some()) {
        return Err(invalid());
    }
    // Operation key: the canonical route, see commands::operation_path.
    let route = format!("/v1/workspaces/{p}/bundles/{b}/channels/{c}/drafts/{d}/{kind}");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let b = path(&b)?;
    let id = path(&d)?;
    sqlx::query("SELECT id FROM drafts WHERE project_id=$1 AND bundle_id=$2 AND channel=$3 AND id=$4 FOR UPDATE").bind(&p).bind(b).bind(&c).bind(id).fetch_optional(&mut *cmd.tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Draft not found"))?;
    let mut out = read(&mut cmd.tx, &p, b, &c, id).await?;
    if out.generation != req.expected_generation {
        return Err(err(
            StatusCode::CONFLICT,
            "generation_conflict",
            "Draft generation changed",
        ));
    }
    if out.status != "open" {
        return Err(err(StatusCode::CONFLICT, "draft_closed", "Draft is closed"));
    }
    if kind == "save" {
        let bytes = payload(req.payload.as_ref().ok_or_else(invalid)?)?;
        let v = snapshot(
            &mut cmd.tx,
            &p,
            b,
            Some(path(&out.base_version_id)?),
            bytes,
            &a.principal,
        )
        .await?;
        out.generation = out.generation.checked_add(1).ok_or_else(invalid)?;
        associate(&mut cmd.tx, &p, b, &c, id, out.generation, &v.id).await?;
        out.snapshot_version = v;
    } else {
        out.status = "discarded".into();
    }
    sqlx::query("UPDATE drafts SET generation=$5,snapshot_version_id=$6,status=$7,promotion_id=$8,updated_at=now() WHERE project_id=$1 AND bundle_id=$2 AND channel=$3 AND id=$4").bind(&p).bind(b).bind(&c).bind(id).bind(out.generation).bind(path(&out.snapshot_version.id)?).bind(&out.status).bind(out.promotion_id.as_deref().map(path).transpose()?).execute(&mut *cmd.tx).await.map_err(db)?;
    let out = read(&mut cmd.tx, &p, b, &c, id).await?;
    crate::commands::finish_mutation(cmd, StatusCode::OK, out).await
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    status: Option<String>,
}
fn limit(q: &PageQuery) -> ApiResult<i64> {
    let n = q.limit.unwrap_or(20);
    if !(1..=100).contains(&n) {
        return Err(invalid());
    }
    Ok(n)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}
async fn get_draft(
    State(s): State<AppState>,
    Path((p, b, c, d)): Path<(String, String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<Draft>> {
    let a = crate::auth::actor(&h, &s, &p, "read")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &a, &p, "read").await?;
    Ok(Json(read(&mut tx, &p, path(&b)?, &c, path(&d)?).await?))
}
async fn list(
    State(s): State<AppState>,
    Path((p, b, c)): Path<(String, String, String)>,
    h: HeaderMap,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Page<Draft>>> {
    let a = crate::auth::actor(&h, &s, &p, "read")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &a, &p, "read").await?;
    let n = limit(&q)?;
    let cursor = q.cursor.as_deref().map(path).transpose()?;
    let status = q.status.as_deref().unwrap_or("open");
    if !matches!(status, "open" | "published" | "discarded" | "all") {
        return Err(invalid());
    }
    let rows=sqlx::query(&format!("{SELECT} WHERE d.project_id=$1 AND d.bundle_id=$2 AND d.channel=$3 AND ($4::uuid IS NULL OR d.id<$4) AND ($5='all' OR d.status=$5) ORDER BY d.id DESC LIMIT $6")).bind(&p).bind(path(&b)?).bind(&c).bind(cursor).bind(status).bind(n+1).fetch_all(&mut *tx).await.map_err(db)?;
    let more = rows.len() > n as usize;
    let items: Vec<_> = rows.iter().take(n as usize).map(draft).collect();
    let next_cursor = if more {
        items.last().map(|x| x.id.clone())
    } else {
        None
    };
    Ok(Json(Page { items, next_cursor }))
}
#[derive(Serialize)]
struct Snapshot {
    generation: i64,
    version: VersionMetadata,
}
async fn history(
    State(s): State<AppState>,
    Path((p, b, c, d)): Path<(String, String, String, String)>,
    h: HeaderMap,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Page<Snapshot>>> {
    let a = crate::auth::actor(&h, &s, &p, "read")?;
    let n = limit(&q)?;
    let cursor = q
        .cursor
        .as_deref()
        .map(|x| x.parse::<i64>().map_err(|_| invalid()))
        .transpose()?;
    if cursor.is_some_and(|x| x < 1) {
        return Err(invalid());
    }
    let b = path(&b)?;
    let id = path(&d)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &a, &p, "read").await?;
    read(&mut tx, &p, b, &c, id).await?;
    let rows=sqlx::query("SELECT s.generation,v.id,v.bundle_id,v.parent_version_id,v.digest,v.created_at FROM draft_snapshots s JOIN versions v ON v.project_id=s.project_id AND v.bundle_id=s.bundle_id AND v.id=s.version_id WHERE s.project_id=$1 AND s.bundle_id=$2 AND s.channel=$3 AND s.draft_id=$4 AND ($5::bigint IS NULL OR s.generation<$5) ORDER BY s.generation DESC LIMIT $6").bind(&p).bind(b).bind(&c).bind(id).bind(cursor).bind(n+1).fetch_all(&mut *tx).await.map_err(db)?;
    let more = rows.len() > n as usize;
    let items: Vec<_> = rows
        .iter()
        .take(n as usize)
        .map(|r| Snapshot {
            generation: r.get("generation"),
            version: crate::store::meta(r),
        })
        .collect();
    let next_cursor = if more {
        items.last().map(|x| x.generation.to_string())
    } else {
        None
    };
    Ok(Json(Page { items, next_cursor }))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Setup {
    name: String,
    #[serde(default = "crate::compatibility::default_target")]
    compatibility_target: String,
    origin: String,
    source_label: Option<String>,
    channel: String,
    payload: BundlePayload,
    reason: String,
}
fn source_label(s: Option<String>) -> ApiResult<Option<String>> {
    s.map(|s| {
        let s = s.trim();
        if s.is_empty()
            || s.len() > 480
            || s.chars().count() > 120
            || s.chars().any(char::is_control)
            || s.starts_with('/')
            || s.starts_with('\\')
            || s.contains(':')
            || s.as_bytes().get(1) == Some(&b':')
        {
            return Err(invalid());
        }
        Ok(s.to_string())
    })
    .transpose()
}
async fn setup(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    crate::auth::actor(&h, &s, &p, "promote")?;
    let req: Setup = decode(&body)?;
    // Operation key: the canonical route, see commands::operation_path.
    let route = format!("/v1/workspaces/{p}/bundle-setups");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    if !crate::compatibility::valid_target(&req.compatibility_target)
        || req.name.trim().is_empty()
        || req.name.len() > 240
        || !matches!(req.origin.as_str(), "created" | "example" | "imported")
        || !crate::channels::valid_channel(&req.channel)
        || crate::connected_learning::internal_channel(&req.channel)
    {
        return Err(invalid());
    }
    let source = source_label(req.source_label)?;
    let bytes = payload(&req.payload)?;
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1) ON CONFLICT(id) DO NOTHING")
        .bind(&p)
        .execute(&mut *cmd.tx)
        .await
        .map_err(db)?;
    let b = Uuid::new_v4();
    let row=sqlx::query("INSERT INTO bundles(id,project_id,name,origin,source_label,compatibility_target) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at").bind(b).bind(&p).bind(req.name.trim()).bind(&req.origin).bind(&source).bind(&req.compatibility_target).fetch_one(&mut *cmd.tx).await.map_err(db)?;
    let v = snapshot(&mut cmd.tx, &p, b, None, bytes, &a.principal).await?;
    let promotion = crate::channels::promote_in_tx(
        &mut cmd.tx,
        &p,
        b,
        &req.channel,
        &a.principal,
        PromoteRequest {
            version_id: v.id.clone(),
            expected_revision: "0".into(),
            comparison_id: None,
            unevaluated_reason: Some(req.reason),
        },
        crate::channels::Publication::Seed,
    )
    .await?;
    let out = serde_json::json!({"bundle":{"id":b.to_string(),"workspaceId":p,"name":req.name.trim(),"origin":req.origin,"sourceLabel":source,"compatibilityTarget":req.compatibility_target,"createdAt":row.get::<DateTime<Utc>,_>("created_at").to_rfc3339()},"version":v,"resolution":{"channel":req.channel,"revision":"1","version":v},"promotion":promotion});
    crate::commands::finish_mutation(cmd, StatusCode::CREATED, out).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_reject_paths_urls_controls_and_excess_bytes() {
        for s in [
            "/private/data",
            "C:\\data",
            "https://host/path",
            "bad\nlabel",
        ] {
            assert!(source_label(Some(s.into())).is_err());
        }
        assert!(source_label(Some("a".repeat(121))).is_err());
        assert_eq!(
            source_label(Some("  Selected files  ".into())).unwrap(),
            Some("Selected files".into())
        );
    }
    #[test]
    fn generation_is_a_json_number() {
        assert!(decode::<Change>(br#"{"expectedGeneration":"1"}"#).is_err());
        assert_eq!(
            decode::<Change>(br#"{"expectedGeneration":1}"#)
                .unwrap()
                .expected_generation,
            1
        );
    }
}
