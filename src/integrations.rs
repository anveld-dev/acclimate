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
            "/v1/workspaces/{project}/connection-observations",
            get(observations),
        )
        .route(
            "/v1/workspaces/{project}/connections",
            get(list).post(create),
        )
        .route(
            "/v1/workspaces/{project}/connections/{integration}/revoke",
            post(revoke),
        )
        .route(
            "/v1/workspaces/{project}/connections/{integration}/credentials",
            post(issue),
        )
        .route(
            "/v1/workspaces/{project}/connections/{integration}/credentials/{credential}/revoke",
            post(revoke_credential),
        )
        .route(
            "/v1/workspaces/{project}/connections/{integration}/receipts",
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
    json!({"id":r.get::<Uuid,_>("id"),"workspaceId":r.get::<String,_>("project_id"),"bundleId":r.get::<Uuid,_>("bundle_id"),"channel":r.get::<String,_>("channel"),"displayName":r.get::<String,_>("display_name"),"enabled":r.get::<bool,_>("enabled"),"createdAt":r.get::<DateTime<Utc>,_>("created_at"),"credentials":r.try_get::<Value,_>("credentials").unwrap_or_else(|_|json!([]))})
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
        || crate::connected_learning::internal_channel(&b.channel)
    {
        return Err(invalid());
    }
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    if a.user_id.is_none() {
        crate::auth::actor(&h, &s, &p, "promote")?;
    }
    // Operation key: the canonical route, see commands::operation_path.
    let route = format!("/v1/workspaces/{p}/connections");
    let mut command =
        match crate::commands::begin_admin_mutation(&s, &a, &p, &route, &h, &body).await? {
            crate::commands::MutationStart::Execute(command) => command,
            crate::commands::MutationStart::Replay(response) => return Ok(response),
        };
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
/// Safe discovery for project readers; credential administration stays separate.
async fn observations(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
    Query(q): Query<Page>,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let limit = q.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(invalid());
    }
    // The existing recent index supports each bounded lateral lookup. All latest
    // fields come from ONE server-receive-ordered receipt, including tied events.
    let rows = sqlx::query(
        "SELECT i.id,i.display_name,i.bundle_id,i.channel,i.enabled,r.body AS observation_body,r.received_at AS observation_received_at \
         FROM integrations i LEFT JOIN LATERAL ( \
           SELECT body,received_at FROM integration_receipts \
           WHERE project_id=i.project_id AND integration_id=i.id \
             AND received_at>=now()-interval '30 days' \
           ORDER BY received_at DESC,event_id DESC LIMIT 1 \
         ) r ON true \
         WHERE i.project_id=$1 AND ($2::uuid IS NULL OR i.id<$2) \
         ORDER BY i.id DESC LIMIT $3",
    )
    .bind(&p)
    .bind(q.cursor)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let next = (rows.len() > limit as usize).then(|| rows[limit as usize - 1].get::<Uuid, _>("id"));
    let items: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .map(|row| {
            let body: Option<Value> = row.get("observation_body");
            let received: Option<DateTime<Utc>> = row.get("observation_received_at");
            let latest = body.zip(received).map(|(body, received)| {
                json!({"eventId":body["eventId"],"stage":body["stage"],
                    "versionId":body["versionId"],"digest":body["digest"],
                    "occurredAt":body["occurredAt"],"receivedAt":received})
            });
            json!({"id":row.get::<Uuid,_>("id"),
                "displayName":row.get::<String,_>("display_name"),
                "bundleId":row.get::<Uuid,_>("bundle_id"),
                "channel":row.get::<String,_>("channel"),
                "enabled":row.get::<bool,_>("enabled"),"latestObservation":latest})
        })
        .collect();
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"items":items,"nextCursor":next})))
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
    Ok(content_scope(s, h, p, b, channel, version).await?.0)
}

pub(crate) async fn content_scope<'a>(
    s: &'a AppState,
    h: &HeaderMap,
    p: &str,
    b: &str,
    channel: Option<&str>,
    version: Option<Uuid>,
) -> ApiResult<(sqlx::Transaction<'a, sqlx::Postgres>, Option<String>)> {
    let connection = h
        .get(crate::connected_learning::CONNECTION_HEADER)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(invalid)
        })
        .transpose()?;
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let integration_token = token.starts_with("aci_")
        && !s.grants.iter().any(|g| g.token == token)
        && s.access.console_token() != token;
    if !integration_token && connection.is_none() {
        let tx = crate::auth::read_transaction(s, h, p).await?;
        // Members inspect the source in the console. Jobs resolve an enrolled
        // connection, while evaluators can still read exact candidate versions.
        if channel.is_some() && crate::auth::actor(h, s, p, "read")?.user_id.is_none() {
            return Err(err(
                StatusCode::CONFLICT,
                "connected_learning_required",
                "Use an enrolled connection to resolve a delivery version",
            ));
        }
        return Ok((tx, None));
    }
    let mut tx = if integration_token {
        s.db.begin().await.map_err(db)?
    } else {
        crate::auth::read_transaction(s, h, p).await?
    };
    let bundle = path(b)?;
    let (id, source) = if integration_token {
        let r = sqlx::query("SELECT i.project_id,i.bundle_id,i.channel,i.id,c.kind FROM integration_credentials c JOIN integrations i ON (i.project_id,i.id)=(c.project_id,c.integration_id) WHERE c.secret_hash=$1 AND c.revoked_at IS NULL AND i.enabled FOR SHARE OF c,i")
            .bind(crate::digest(token.as_bytes())).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(denied)?;
        let id: Uuid = r.get("id");
        if r.get::<String, _>("project_id") != p
            || r.get::<Uuid, _>("bundle_id") != bundle
            || r.get::<String, _>("kind") != "content-read"
            || connection.is_some_and(|connection| connection != id)
        {
            return Err(denied());
        }
        (id, r.get::<String, _>("channel"))
    } else {
        let id = connection.ok_or_else(denied)?;
        let source: String = sqlx::query_scalar("SELECT channel FROM integrations WHERE project_id=$1 AND bundle_id=$2 AND id=$3 AND enabled FOR SHARE")
            .bind(p).bind(bundle).bind(id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(denied)?;
        (id, source)
    };
    if channel.is_some_and(|c| c != source) {
        return Err(denied());
    }
    let effective: String = sqlx::query_scalar("SELECT delivery_channel FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2")
        .bind(p).bind(id).fetch_optional(&mut *tx).await.map_err(db)?
        .ok_or_else(|| err(StatusCode::CONFLICT, "connected_learning_required", "Enroll this connection before starting a job"))?;
    if let Some(version) = version
        && !delivery_history(
            &mut tx,
            p,
            bundle,
            id,
            &source,
            DeliveryVersion {
                id: version,
                digest: None,
                revision: None,
            },
        )
        .await?
    {
        return Err(denied());
    }
    Ok((tx, Some(effective)))
}

struct DeliveryVersion<'a> {
    id: Uuid,
    digest: Option<&'a str>,
    revision: Option<i64>,
}

async fn delivery_history(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    bundle: Uuid,
    integration: Uuid,
    source: &str,
    version: DeliveryVersion<'_>,
) -> ApiResult<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM promotions p
           JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(p.project_id,p.bundle_id,p.version_id)
           JOIN connected_learning_enrollments e ON e.project_id=p.project_id AND e.bundle_id=p.bundle_id AND e.integration_id=$3
           WHERE p.project_id=$1 AND p.bundle_id=$2 AND p.version_id=$5
             AND ((p.channel=$4 AND p.revision <= e.source_revision) OR p.channel=e.delivery_channel)
             AND ($6::text IS NULL OR v.digest=$6) AND ($7::bigint IS NULL OR p.revision=$7))",
    ).bind(project).bind(bundle).bind(integration).bind(source).bind(version.id).bind(version.digest).bind(version.revision)
        .fetch_one(&mut **tx).await.map_err(db)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub event_id: Uuid,
    #[serde(rename = "connectionId")]
    pub integration_id: Uuid,
    #[serde(rename = "workspaceId")]
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
    if !delivery_history(
        &mut tx,
        &p,
        b.bundle_id,
        i,
        &channel,
        DeliveryVersion {
            id: b.version_id,
            digest: Some(&b.digest),
            revision,
        },
    )
    .await?
    {
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
