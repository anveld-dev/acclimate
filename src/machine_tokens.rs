//! Workspace-issued machine tokens for evaluators and other automation.
//!
//! Workspace administrators issue, list, rotate and revoke these through the API
//! without restarting the service. Only a SHA-256 digest of each secret is stored,
//! and the secret is returned once. Static `ACCLIMATE_AUTH` grants keep working.
use crate::{ApiResult, AppState, auth, db, err};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub(crate) const TRUSTED_HEADER: &str = "x-acclimate-trusted-machine";
const PREFIX: &str = "acm_";
const DEFAULT_DAYS: i64 = 90;
const MAX_DAYS: i64 = 365;
const MAX_OVERLAP_SECONDS: i64 = 7 * 86_400;
const MAX_ACTIVE_PER_WORKSPACE: i64 = 100;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/workspaces/{p}/machine-tokens", get(list).post(issue))
        .route(
            "/v1/workspaces/{p}/machine-tokens/{id}/revoke",
            post(revoke),
        )
        .route(
            "/v1/workspaces/{p}/machine-tokens/{id}/rotate",
            post(rotate),
        )
        .route("/v1/workspaces/{p}/machine-token-events", get(events))
}

pub(crate) fn is_machine_token(token: &str) -> bool {
    token.starts_with(PREFIX) && token.len() <= 256
}

/// Resolved by the session middleware after it strips any caller-supplied copy.
#[derive(Serialize, Deserialize)]
pub(crate) struct Trusted {
    pub(crate) id: Uuid,
    pub(crate) project_id: String,
    pub(crate) principal_id: String,
    pub(crate) rights: Vec<String>,
}

pub(crate) fn trusted(h: &HeaderMap) -> Option<Trusted> {
    serde_json::from_slice(h.get(TRUSTED_HEADER)?.as_bytes()).ok()
}

pub(crate) async fn resolve(s: &AppState, token: &str) -> ApiResult<Option<HeaderValue>> {
    let Some(row) = sqlx::query(
        "SELECT id,project_id,principal_id,rights,last_used_at>now()-interval '60 seconds' AS fresh
         FROM machine_tokens WHERE secret_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
    )
    .bind(crate::digest(token.as_bytes()))
    .fetch_optional(&s.db)
    .await
    .map_err(db)?
    else {
        return Ok(None);
    };
    let id: Uuid = row.get("id");
    if !row.get::<Option<bool>, _>("fresh").unwrap_or(false) {
        // Coarse last-use for the admin view; never part of an authorization decision.
        sqlx::query("UPDATE machine_tokens SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<=now()-interval '60 seconds')")
            .bind(id).execute(&s.db).await.map_err(db)?;
    }
    let trusted = Trusted {
        id,
        project_id: row.get("project_id"),
        principal_id: row.get("principal_id"),
        rights: row.get("rights"),
    };
    let value = serde_json::to_string(&trusted).map_err(db)?;
    Ok(Some(HeaderValue::from_str(&value).map_err(db)?))
}

fn invalid(message: &str) -> crate::ApiErr {
    err(StatusCode::BAD_REQUEST, "invalid_content", message)
}

/// Token administration is a browser workspace-admin action, never a machine one.
async fn admin<'a>(
    s: &'a AppState,
    h: &HeaderMap,
    project: &str,
) -> ApiResult<(sqlx::Transaction<'a, sqlx::Postgres>, auth::Actor)> {
    let a = auth::actor(h, s, project, "read")?;
    if a.user_id.is_none() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Workspace administrator required",
        ));
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, project, "admin").await?;
    Ok((tx, a))
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(b))
}

fn valid_rights(rights: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    !rights.is_empty()
        && rights
            .iter()
            .all(|right| auth::RIGHTS.contains(&right.as_str()) && seen.insert(right))
}

fn valid_reason(reason: &Option<String>) -> bool {
    reason
        .as_deref()
        .is_none_or(|r| !r.trim().is_empty() && r.len() <= 1024)
}

fn new_secret() -> String {
    // Two v4 UUIDs supply 244 bits from the operating system's CSPRNG.
    format!(
        "{PREFIX}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn view(r: &sqlx::postgres::PgRow) -> Value {
    let expires_at: DateTime<Utc> = r.get("expires_at");
    let revoked_at: Option<DateTime<Utc>> = r.get("revoked_at");
    let status = if revoked_at.is_some() {
        "revoked"
    } else if expires_at <= Utc::now() {
        "expired"
    } else {
        "active"
    };
    json!({
        "id": r.get::<Uuid, _>("id"),
        "workspaceId": r.get::<String, _>("project_id"),
        "name": r.get::<String, _>("name"),
        "principalId": r.get::<String, _>("principal_id"),
        "rights": r.get::<Vec<String>, _>("rights"),
        "secretPrefix": r.get::<String, _>("secret_prefix"),
        "status": status,
        "createdBy": r.get::<String, _>("created_by"),
        "createdAt": r.get::<DateTime<Utc>, _>("created_at"),
        "expiresAt": expires_at,
        "lastUsedAt": r.get::<Option<DateTime<Utc>>, _>("last_used_at"),
        "revokedAt": revoked_at,
        "revokedBy": r.get::<Option<String>, _>("revoked_by"),
        "revokeReason": r.get::<Option<String>, _>("revoke_reason"),
        "rotatedFrom": r.get::<Option<Uuid>, _>("rotated_from"),
    })
}

fn private(value: Value, status: StatusCode) -> axum::response::Response {
    (
        status,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Issue {
    name: String,
    #[serde(default)]
    rights: Option<Vec<String>>,
    #[serde(default)]
    expires_in_days: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn insert(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    name: &str,
    rights: &[String],
    days: i64,
    actor: &str,
    rotated_from: Option<Uuid>,
) -> ApiResult<(sqlx::postgres::PgRow, String)> {
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM machine_tokens WHERE project_id=$1 AND revoked_at IS NULL AND expires_at>now()",
    )
    .bind(project)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)?;
    if active >= MAX_ACTIVE_PER_WORKSPACE {
        return Err(err(
            StatusCode::CONFLICT,
            "machine_token_limit",
            "Revoke unused machine tokens before issuing more",
        ));
    }
    let secret = new_secret();
    let row = sqlx::query(
        "INSERT INTO machine_tokens(id,project_id,principal_id,name,secret_hash,secret_prefix,rights,created_by,expires_at,rotated_from)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(days=>$9),$10) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(project)
    .bind(format!("machine:{name}"))
    .bind(name)
    .bind(crate::digest(secret.as_bytes()))
    .bind(&secret[..PREFIX.len() + 8])
    .bind(rights)
    .bind(actor)
    .bind(days as i32)
    .bind(rotated_from)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)?;
    Ok((row, secret))
}

async fn event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    token: Uuid,
    action: &str,
    actor: &auth::Actor,
    reason: Option<&str>,
    detail: Value,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO machine_token_events(project_id,token_id,action,actor_principal,reason,detail) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(project).bind(token).bind(action).bind(&actor.principal).bind(reason).bind(detail)
        .execute(&mut **tx).await.map_err(db)?;
    // Operation key: the canonical route, see commands::operation_path.
    let path = format!("/v1/workspaces/{project}/machine-tokens/{token}/{action}");
    crate::workspaces::audit(
        tx,
        project,
        actor.user_id.expect("admin is a browser user"),
        &actor.service_principal,
        &path,
    )
    .await
}

async fn issue(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<axum::response::Response> {
    let q: Issue = serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
    let rights = q.rights.unwrap_or_else(|| vec!["read".into()]);
    let days = q.expires_in_days.unwrap_or(DEFAULT_DAYS);
    if !valid_name(&q.name) {
        return Err(invalid(
            "Name must be 1-64 lowercase letters, digits, '.', '-' or '_'",
        ));
    }
    if !valid_rights(&rights) {
        return Err(invalid(
            "Rights must be distinct values from read, write and promote",
        ));
    }
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(invalid("expiresInDays must be between 1 and 365"));
    }
    if !valid_reason(&q.reason) {
        return Err(invalid("Reason must be nonempty and at most 1024 bytes"));
    }
    let (mut tx, a) = admin(&s, &h, &p).await?;
    let (row, secret) = insert(&mut tx, &p, &q.name, &rights, days, &a.principal, None).await?;
    let id: Uuid = row.get("id");
    event(
        &mut tx,
        &p,
        id,
        "issued",
        &a,
        q.reason.as_deref(),
        json!({"rights": rights, "expiresInDays": days}),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(private(
        json!({"token": view(&row), "secret": secret}),
        StatusCode::CREATED,
    ))
}

async fn list(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
) -> ApiResult<axum::response::Response> {
    let (mut tx, _) = admin(&s, &h, &p).await?;
    let rows = sqlx::query(
        "SELECT * FROM machine_tokens WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200",
    )
    .bind(&p)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(private(
        json!({"items": rows.iter().map(view).collect::<Vec<_>>()}),
        StatusCode::OK,
    ))
}

async fn events(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
) -> ApiResult<axum::response::Response> {
    let (mut tx, _) = admin(&s, &h, &p).await?;
    let rows = sqlx::query(
        "SELECT e.*,t.name FROM machine_token_events e JOIN machine_tokens t ON (t.project_id,t.id)=(e.project_id,e.token_id)
         WHERE e.project_id=$1 ORDER BY e.id DESC LIMIT 200",
    )
    .bind(&p)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "tokenId": r.get::<Uuid, _>("token_id"),
                "tokenName": r.get::<String, _>("name"),
                "action": r.get::<String, _>("action"),
                "actorPrincipal": r.get::<String, _>("actor_principal"),
                "reason": r.get::<Option<String>, _>("reason"),
                "detail": r.get::<Value, _>("detail"),
                "createdAt": r.get::<DateTime<Utc>, _>("created_at"),
            })
        })
        .collect();
    Ok(private(json!({ "items": items }), StatusCode::OK))
}

async fn locked(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    id: &str,
) -> ApiResult<sqlx::postgres::PgRow> {
    sqlx::query("SELECT * FROM machine_tokens WHERE project_id=$1 AND id=$2 FOR UPDATE")
        .bind(project)
        .bind(crate::path(id)?)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "not_found",
                "Machine token not found",
            )
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revoke {
    reason: String,
}

async fn revoke(
    State(s): State<AppState>,
    Path((p, id)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<axum::response::Response> {
    let q: Revoke = serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
    if !valid_reason(&Some(q.reason.clone())) {
        return Err(invalid(
            "Revocation reason must be nonempty and at most 1024 bytes",
        ));
    }
    let (mut tx, a) = admin(&s, &h, &p).await?;
    let row = locked(&mut tx, &p, &id).await?;
    // Revocation is idempotent; the first reason is retained.
    if row.get::<Option<DateTime<Utc>>, _>("revoked_at").is_some() {
        tx.commit().await.map_err(db)?;
        return Ok(private(json!({"token": view(&row)}), StatusCode::OK));
    }
    let row = sqlx::query("UPDATE machine_tokens SET revoked_at=now(),revoked_by=$3,revoke_reason=$4 WHERE project_id=$1 AND id=$2 RETURNING *")
        .bind(&p).bind(row.get::<Uuid, _>("id")).bind(&a.principal).bind(&q.reason)
        .fetch_one(&mut *tx).await.map_err(db)?;
    event(
        &mut tx,
        &p,
        row.get("id"),
        "revoked",
        &a,
        Some(&q.reason),
        json!({}),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(private(json!({"token": view(&row)}), StatusCode::OK))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rotate {
    #[serde(default)]
    overlap_seconds: Option<i64>,
    #[serde(default)]
    expires_in_days: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
}

/// Issue a successor with the same principal and rights. In-flight evaluations
/// stay owned by that principal, so a worker can switch tokens between requests.
async fn rotate(
    State(s): State<AppState>,
    Path((p, id)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<axum::response::Response> {
    let q: Rotate = if body.is_empty() {
        Rotate {
            overlap_seconds: None,
            expires_in_days: None,
            reason: None,
        }
    } else {
        serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?
    };
    let overlap = q.overlap_seconds.unwrap_or(0);
    let days = q.expires_in_days.unwrap_or(DEFAULT_DAYS);
    if !(0..=MAX_OVERLAP_SECONDS).contains(&overlap) {
        return Err(invalid("overlapSeconds must be between 0 and 604800"));
    }
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(invalid("expiresInDays must be between 1 and 365"));
    }
    if !valid_reason(&q.reason) {
        return Err(invalid("Reason must be nonempty and at most 1024 bytes"));
    }
    let (mut tx, a) = admin(&s, &h, &p).await?;
    let previous = locked(&mut tx, &p, &id).await?;
    let previous_id: Uuid = previous.get("id");
    let active: bool = sqlx::query_scalar(
        "SELECT revoked_at IS NULL AND expires_at>now() FROM machine_tokens WHERE id=$1",
    )
    .bind(previous_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if !active {
        return Err(err(
            StatusCode::CONFLICT,
            "machine_token_inactive",
            "Only an active token can be rotated; issue a new token instead",
        ));
    }
    let (row, secret) = insert(
        &mut tx,
        &p,
        &previous.get::<String, _>("name"),
        &previous.get::<Vec<String>, _>("rights"),
        days,
        &a.principal,
        Some(previous_id),
    )
    .await?;
    let previous = if overlap == 0 {
        sqlx::query("UPDATE machine_tokens SET revoked_at=now(),revoked_by=$2,revoke_reason='Rotated' WHERE id=$1 RETURNING *")
            .bind(previous_id).bind(&a.principal).fetch_one(&mut *tx).await.map_err(db)?
    } else {
        sqlx::query("UPDATE machine_tokens SET expires_at=LEAST(expires_at,now()+make_interval(secs=>$2)) WHERE id=$1 RETURNING *")
            .bind(previous_id).bind(overlap as f64).fetch_one(&mut *tx).await.map_err(db)?
    };
    let successor: Uuid = row.get("id");
    event(
        &mut tx,
        &p,
        previous_id,
        "rotated",
        &a,
        q.reason.as_deref(),
        json!({"successorId": successor, "overlapSeconds": overlap}),
    )
    .await?;
    event(
        &mut tx,
        &p,
        successor,
        "issued",
        &a,
        q.reason.as_deref(),
        json!({"rotatedFrom": previous_id, "expiresInDays": days}),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(private(
        json!({"token": view(&row), "secret": secret, "previous": view(&previous)}),
        StatusCode::CREATED,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_rights_and_secrets_are_bounded() {
        for name in ["ci", "ci-evaluator", "a.b_c-1", "9lives"] {
            assert!(valid_name(name), "{name}");
        }
        for name in [
            "",
            "CI",
            "-ci",
            "ci:x",
            "ci/x",
            &"a".repeat(65),
            "ci evaluator",
        ] {
            assert!(!valid_name(name), "{name}");
        }
        let rights = |r: &[&str]| r.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(!valid_rights(&rights(&["evaluate"])));
        assert!(valid_rights(&rights(&["read", "write", "promote"])));
        assert!(!valid_rights(&rights(&[])));
        assert!(!valid_rights(&rights(&["admin"])));
        assert!(!valid_rights(&rights(&["evaluate", "evaluate"])));
        let secret = new_secret();
        assert!(is_machine_token(&secret));
        assert_eq!(secret.len(), PREFIX.len() + 64);
        assert_ne!(secret, new_secret());
        assert!(!is_machine_token("aci_integration"));
    }

    #[test]
    fn trusted_header_round_trips() {
        let mut h = HeaderMap::new();
        let value = serde_json::to_string(&Trusted {
            id: Uuid::nil(),
            project_id: "p".into(),
            principal_id: "machine:ci".into(),
            rights: vec!["read".into()],
        })
        .unwrap();
        h.insert(TRUSTED_HEADER, HeaderValue::from_str(&value).unwrap());
        let parsed = trusted(&h).unwrap();
        assert_eq!(parsed.principal_id, "machine:ci");
        assert_eq!(parsed.rights, vec!["read".to_string()]);
    }
}
