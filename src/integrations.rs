//! Opt-in application observations; integration credentials never grant project access.
use crate::{ApiResult, AppState, db, err, path};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/{project}/integrations",
            get(list).post(create),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/revoke",
            post(revoke),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/credentials",
            post(issue),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/credentials/{credential}/revoke",
            post(revoke_credential),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/receipts",
            get(receipts).post(receive),
        )
}
fn invalid() -> crate::ApiErr {
    err(
        StatusCode::BAD_REQUEST,
        "invalid_content",
        "Invalid integration or receipt",
    )
}
fn denied() -> crate::ApiErr {
    err(
        StatusCode::FORBIDDEN,
        "denied",
        "Integration credential does not permit this operation",
    )
}
async fn admin(
    s: &AppState,
    h: &HeaderMap,
    p: &str,
    right: &str,
) -> ApiResult<sqlx::Transaction<'static, sqlx::Postgres>> {
    let a = crate::auth::actor(h, s, p, if right == "admin" { "write" } else { "read" })?;
    if right == "admin" && a.user_id.is_none() {
        crate::auth::actor(h, s, p, "promote")?;
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &a, p, right).await?;
    Ok(tx)
}
fn integration(r: &sqlx::postgres::PgRow) -> Value {
    json!({"id":r.get::<Uuid,_>("id"),"projectId":r.get::<String,_>("project_id"),"bundleId":r.get::<Uuid,_>("bundle_id"),"channel":r.get::<String,_>("channel"),"displayName":r.get::<String,_>("display_name"),"enabled":r.get::<bool,_>("enabled"),"createdAt":r.get::<DateTime<Utc>,_>("created_at"),"credentials":r.try_get::<Value,_>("credentials").unwrap_or_else(|_|json!([]))})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewIntegration {
    display_name: String,
    bundle_id: Uuid,
    channel: String,
}
async fn create(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let b: NewIntegration = serde_json::from_slice(&body).map_err(|_| invalid())?;
    if b.display_name.trim().is_empty()
        || b.display_name.len() > 120
        || !crate::channels::valid_channel(&b.channel)
    {
        return Err(invalid());
    }
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    if a.user_id.is_none() {
        crate::auth::actor(&h, &s, &p, "promote")?;
    }
    let route = format!("/v1/projects/{p}/integrations");
    let (mut command, replay) =
        crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await?;
    crate::auth::authorize_transaction(&mut command.tx, &a, &p, "admin").await?;
    if let Some(response) = replay {
        return Ok(response);
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM channels WHERE project_id=$1 AND bundle_id=$2 AND name=$3)",
    )
    .bind(&p)
    .bind(b.bundle_id)
    .bind(&b.channel)
    .fetch_one(&mut *command.tx)
    .await
    .map_err(db)?;
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "Channel not found"));
    }
    let r=sqlx::query("INSERT INTO integrations(id,project_id,bundle_id,channel,display_name) VALUES($1,$2,$3,$4,$5) RETURNING *").bind(Uuid::new_v4()).bind(&p).bind(b.bundle_id).bind(b.channel).bind(b.display_name.trim()).fetch_one(&mut *command.tx).await.map_err(db)?;
    crate::commands::finish_mutation(command, StatusCode::CREATED, integration(&r)).await
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    cursor: Option<Uuid>,
    limit: Option<i64>,
}
async fn list(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
    Query(q): Query<Page>,
) -> ApiResult<Json<Value>> {
    let mut tx = admin(&s, &h, &p, "admin").await?;
    let limit = q.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(invalid());
    }
    let rows=sqlx::query("SELECT i.*,(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'createdAt',c.created_at,'revokedAt',c.revoked_at) ORDER BY c.created_at DESC),'[]'::jsonb) FROM integration_credentials c WHERE c.project_id=i.project_id AND c.integration_id=i.id) AS credentials FROM integrations i WHERE project_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3").bind(p).bind(q.cursor).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?;
    let next = if rows.len() > limit as usize {
        Some(rows[limit as usize - 1].get::<Uuid, _>("id"))
    } else {
        None
    };
    let items: Vec<_> = rows.iter().take(limit as usize).map(integration).collect();
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"items":items,"nextCursor":next})))
}
async fn revoke(
    State(s): State<AppState>,
    Path((p, i)): Path<(String, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = admin(&s, &h, &p, "admin").await?;
    let r = sqlx::query(
        "UPDATE integrations SET enabled=false WHERE project_id=$1 AND id=$2 RETURNING *",
    )
    .bind(p)
    .bind(i)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Integration not found"))?;
    tx.commit().await.map_err(db)?;
    Ok(Json(integration(&r)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    kind: String,
}
async fn issue(
    State(s): State<AppState>,
    Path((p, i)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(b): Json<Credential>,
) -> ApiResult<Json<Value>> {
    if !matches!(b.kind.as_str(), "content-read" | "receipt-write") {
        return Err(invalid());
    }
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    let key = h
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| {
            !v.is_empty() && v.len() <= 128 && v.bytes().all(|b| (0x20..=0x7e).contains(&b))
        })
        .ok_or_else(invalid)?;
    let mut tx = admin(&s, &h, &p, "admin").await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("credential-issue:{p}:{i}:{}:{key}", a.principal))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if let Some(previous)=sqlx::query("SELECT id,kind,revoked_at FROM integration_credentials WHERE project_id=$1 AND integration_id=$2 AND issued_by=$3 AND operation_key=$4").bind(&p).bind(i).bind(&a.principal).bind(key).fetch_optional(&mut *tx).await.map_err(db)? {
        if previous.get::<String,_>("kind")!=b.kind{return Err(err(StatusCode::CONFLICT,"idempotency_conflict","Key was used with different input"))}
        return Err(err(StatusCode::CONFLICT,"credential_already_issued","The credential was already issued. Confirm its revocation before issuing a replacement.").with_details(json!({"credentialId":previous.get::<Uuid,_>("id"),"kind":previous.get::<String,_>("kind"),"revokedAt":previous.get::<Option<chrono::DateTime<chrono::Utc>>,_>("revoked_at")})));
    }
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM integrations WHERE project_id=$1 AND id=$2 AND enabled)",
    )
    .bind(&p)
    .bind(i)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if !valid {
        return Err(denied());
    }
    let secret = format!("aci_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO integration_credentials(id,project_id,integration_id,kind,secret_hash,issued_by,operation_key) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(&p).bind(i).bind(&b.kind).bind(crate::digest(secret.as_bytes())).bind(&a.principal).bind(key).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"id":id,"kind":b.kind,"secret":secret})))
}
async fn revoke_credential(
    State(s): State<AppState>,
    Path((p, i, c)): Path<(String, Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = admin(&s, &h, &p, "admin").await?;
    let n=sqlx::query("UPDATE integration_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE project_id=$1 AND integration_id=$2 AND id=$3").bind(p).bind(i).bind(c).execute(&mut *tx).await.map_err(db)?.rows_affected();
    if n == 0 {
        return Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            "Credential not found",
        ));
    }
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"revoked":true})))
}
async fn credential(s: &AppState, h: &HeaderMap) -> ApiResult<Option<sqlx::postgres::PgRow>> {
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if (s.grants.iter().any(|g| g.token == token) || s.access.console_token() == token)
        || !token.starts_with("aci_")
    {
        return Ok(None);
    }
    let row=sqlx::query("SELECT i.*,c.kind FROM integration_credentials c JOIN integrations i ON i.id=c.integration_id AND i.project_id=c.project_id WHERE c.secret_hash=$1 AND c.revoked_at IS NULL AND i.enabled").bind(crate::digest(token.as_bytes())).fetch_optional(&s.db).await.map_err(db)?.ok_or_else(denied)?;
    Ok(Some(row))
}
pub(crate) async fn content_transaction<'a>(
    s: &'a AppState,
    h: &HeaderMap,
    p: &str,
    b: &str,
    channel: Option<&str>,
    version: Option<Uuid>,
) -> ApiResult<sqlx::Transaction<'a, sqlx::Postgres>> {
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if (s.grants.iter().any(|g| g.token == token) || s.access.console_token() == token)
        || !token.starts_with("aci_")
    {
        return crate::auth::read_transaction(s, h, p).await;
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    let r=sqlx::query("SELECT i.*,c.kind FROM integration_credentials c JOIN integrations i ON i.id=c.integration_id AND i.project_id=c.project_id WHERE c.secret_hash=$1 AND c.revoked_at IS NULL AND i.enabled FOR SHARE OF c,i").bind(crate::digest(token.as_bytes())).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(denied)?;
    if r.get::<String, _>("project_id") != p
        || r.get::<Uuid, _>("bundle_id") != path(b)?
        || r.get::<String, _>("kind") != "content-read"
    {
        return Err(denied());
    }
    let allowed: String = r.get("channel");
    if channel.is_some_and(|c| c != allowed) {
        return Err(denied());
    }
    if let Some(v) = version {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM promotions WHERE project_id=$1 AND bundle_id=$2 AND channel=$3 AND version_id=$4)").bind(p).bind(path(b)?).bind(&allowed).bind(v).fetch_one(&mut *tx).await.map_err(db)?;
        if !valid {
            return Err(denied());
        }
    }
    Ok(tx)
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub event_id: Uuid,
    pub integration_id: Uuid,
    pub project_id: String,
    pub bundle_id: Uuid,
    pub channel: Option<String>,
    pub revision: Option<String>,
    pub version_id: Uuid,
    pub digest: String,
    pub stage: String,
    pub occurred_at: DateTime<Utc>,
    pub source: String,
    pub resolved_at: Option<DateTime<Utc>>,
    pub stale: Option<bool>,
}
fn validate(b: &Receipt, now: DateTime<Utc>) -> ApiResult<()> {
    if !matches!(
        b.stage.as_str(),
        "resolved" | "downloaded" | "verified" | "prepared" | "started"
    ) || !matches!(b.source.as_str(), "network" | "cache" | "offline")
        || b.stage == "downloaded" && b.source != "network"
        || b.channel.is_some() != b.revision.is_some()
        || b.channel.is_some() != b.resolved_at.is_some()
        || b.channel.is_some() != b.stale.is_some()
        || b.stage == "resolved" && b.channel.is_none()
        || b.occurred_at < now - Duration::hours(24)
        || b.occurred_at > now + Duration::minutes(5)
        || b.resolved_at
            .is_some_and(|t| t > b.occurred_at + Duration::minutes(5))
        || b.digest.len() != 71
    {
        return Err(invalid());
    }
    Ok(())
}
async fn receive(
    State(s): State<AppState>,
    Path((p, i)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(b): Json<Receipt>,
) -> ApiResult<Json<Value>> {
    let r = credential(&s, &h).await?.ok_or_else(denied)?;
    if r.get::<String, _>("kind") != "receipt-write"
        || r.get::<String, _>("project_id") != p
        || r.get::<Uuid, _>("id") != i
        || b.integration_id != i
        || b.project_id != p
        || b.bundle_id != r.get::<Uuid, _>("bundle_id")
    {
        return Err(denied());
    }
    validate(&b, Utc::now())?;
    let channel: String = r.get("channel");
    if b.channel.as_ref().is_some_and(|c| c != &channel) {
        return Err(denied());
    }
    let revision = b
        .revision
        .as_ref()
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| invalid())?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM versions v JOIN promotions pr ON pr.project_id=v.project_id AND pr.bundle_id=v.bundle_id AND pr.version_id=v.id WHERE v.project_id=$1 AND v.bundle_id=$2 AND v.id=$3 AND v.digest=$4 AND pr.channel=$5 AND ($6::bigint IS NULL OR pr.revision=$6))").bind(&p).bind(b.bundle_id).bind(b.version_id).bind(&b.digest).bind(channel).bind(revision).fetch_one(&s.db).await.map_err(db)?;
    if !valid {
        return Err(denied());
    }
    let body = serde_json::to_value(&b).map_err(db)?;
    let fingerprint = crate::digest(&serde_json::to_vec(&body).map_err(db)?);
    let mut tx = s.db.begin().await.map_err(db)?;
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let still_valid=sqlx::query("SELECT c.id FROM integration_credentials c JOIN integrations i ON i.id=c.integration_id AND i.project_id=c.project_id WHERE c.secret_hash=$1 AND c.revoked_at IS NULL AND i.enabled AND i.id=$2 AND i.project_id=$3 AND c.kind='receipt-write' FOR SHARE OF c,i")
        .bind(crate::digest(token.as_bytes())).bind(i).bind(&p).fetch_optional(&mut *tx).await.map_err(db)?;
    if still_valid.is_none() {
        return Err(denied());
    }
    // Cooperative retention is applied on each receipt operation, including dedup keys.
    sqlx::query("DELETE FROM integration_receipts WHERE received_at<now()-interval '30 days'")
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let row=sqlx::query("INSERT INTO integration_receipts(integration_id,event_id,project_id,bundle_id,version_id,body,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(integration_id,event_id) DO UPDATE SET event_id=integration_receipts.event_id RETURNING body,fingerprint,received_at").bind(i).bind(b.event_id).bind(p).bind(b.bundle_id).bind(b.version_id).bind(body).bind(&fingerprint).fetch_one(&mut *tx).await.map_err(db)?;
    if row.get::<String, _>("fingerprint") != fingerprint {
        return Err(err(
            StatusCode::CONFLICT,
            "idempotency_conflict",
            "Event ID was already used for different content",
        ));
    }
    let out = receipt_row(&row);
    tx.commit().await.map_err(db)?;
    Ok(Json(out))
}
fn receipt_row(r: &sqlx::postgres::PgRow) -> Value {
    let mut b: Value = r.get("body");
    let received: DateTime<Utc> = r.get("received_at");
    let occurred = b["occurredAt"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    b["receivedAt"] = json!(received);
    b["delayed"] =
        json!(occurred.is_some_and(|t| received.signed_duration_since(t) > Duration::minutes(5)));
    b
}
async fn receipts(
    State(s): State<AppState>,
    Path((p, i)): Path<(String, Uuid)>,
    h: HeaderMap,
    Query(q): Query<Page>,
) -> ApiResult<Json<Value>> {
    let mut tx = admin(&s, &h, &p, "read").await?;
    sqlx::query("DELETE FROM integration_receipts WHERE received_at<now()-interval '30 days'")
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let limit = q.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(invalid());
    }
    let rows=sqlx::query("SELECT body,received_at,event_id FROM integration_receipts WHERE project_id=$1 AND integration_id=$2 AND received_at>=now()-interval '30 days' AND ($3::uuid IS NULL OR (received_at,event_id)<(SELECT received_at,event_id FROM integration_receipts WHERE project_id=$1 AND integration_id=$2 AND event_id=$3)) ORDER BY received_at DESC,event_id DESC LIMIT $4").bind(p).bind(i).bind(q.cursor).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?;
    let next = if rows.len() > limit as usize {
        Some(rows[limit as usize - 1].get::<Uuid, _>("event_id"))
    } else {
        None
    };
    let items: Vec<_> = rows.iter().take(limit as usize).map(receipt_row).collect();
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"items":items,"nextCursor":next})))
}
