//! Email addresses select invitation recipients; issuer + subject still identify accounts.
use crate::{
    ApiResult, AppState, auth, db, err,
    workspaces::{audit, identity},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/workspaces/{project}/invitations",
            get(list).post(create),
        )
        .route(
            "/v1/workspaces/{project}/invitations/{invite}",
            axum::routing::delete(revoke),
        )
        .route(
            "/v1/workspaces/{project}/invitations/{invite}/resend",
            post(resend),
        )
        .route("/v1/invitations/{invite}", get(preview))
        .route("/v1/invitations/{invite}/accept", post(accept))
}

fn missing() -> crate::ApiErr {
    err(
        StatusCode::NOT_FOUND,
        "not_found",
        "Invitation not found for this account. Sign in with the email that received it.",
    )
}
fn unavailable() -> crate::ApiErr {
    err(
        StatusCode::SERVICE_UNAVAILABLE,
        "email_unavailable",
        "Email invitations are not configured",
    )
}
fn item(row: &PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"email":row.get::<String,_>("email"),"role":row.get::<String,_>("role"),"status":row.get::<String,_>("status"),"deliveryStatus":row.get::<String,_>("delivery_status"),"expiresAt":row.get::<chrono::DateTime<chrono::Utc>,_>("expires_at"),"sentAt":row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("sent_at")})
}
async fn admin(
    s: &AppState,
    h: &HeaderMap,
    project: &str,
) -> ApiResult<sqlx::Transaction<'static, sqlx::Postgres>> {
    let a = auth::actor(h, s, project, "read")?;
    if a.user_id.is_none() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Browser administrator required",
        ));
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    // Same lock order as ordinary membership changes and invitation acceptance.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("membership:{project}"))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, project, "admin").await?;
    Ok(tx)
}
async fn list(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(project): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = admin(&s, &h, &project).await?;
    let rows=sqlx::query("SELECT * FROM workspace_invitations WHERE project_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 200").bind(project).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"available":s.access.mail.is_some(),"items":rows.iter().map(item).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invite {
    email: String,
    role: String,
}
async fn create(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(project): Path<String>,
    Json(v): Json<Invite>,
) -> ApiResult<Json<Value>> {
    let email = crate::mail::normalize_email(&v.email).ok_or_else(|| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Enter a valid email address",
        )
    })?;
    if !matches!(v.role.as_str(), "viewer" | "editor" | "admin") {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid role",
        ));
    }
    let mut tx = admin(&s, &h, &project).await?;
    if s.access.mail.is_none() {
        return Err(unavailable());
    }
    let member:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM project_memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND u.email=$2 AND u.email_verified)").bind(&project).bind(&email).fetch_one(&mut *tx).await.map_err(db)?;
    if member {
        return Err(err(
            StatusCode::CONFLICT,
            "already_member",
            "That email already belongs to a workspace member",
        ));
    }
    if let Some(row) = sqlx::query(
        "SELECT * FROM workspace_invitations WHERE project_id=$1 AND email=$2 AND status='pending'",
    )
    .bind(&project)
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    {
        if row.get::<String, _>("role") != v.role {
            return Err(err(
                StatusCode::CONFLICT,
                "invitation_exists",
                "Revoke the existing invitation before changing its role",
            ));
        }
        return Ok(Json(item(&row))); // A repeated request never queues duplicate mail.
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_invitations WHERE project_id=$1 AND status='pending'",
    )
    .bind(&project)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if count >= 200 {
        return Err(err(
            StatusCode::CONFLICT,
            "invitation_limit",
            "Revoke old invitations before sending more",
        ));
    }
    let (user, _) = identity(&h)?;
    let row=sqlx::query("INSERT INTO workspace_invitations(id,project_id,email,role,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *").bind(Uuid::new_v4()).bind(&project).bind(email).bind(v.role).bind(user).fetch_one(&mut *tx).await.map_err(db)?;
    audit(&mut tx, &project, user, "console", "invitation:create").await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(item(&row)))
}
async fn revoke(
    State(s): State<AppState>,
    h: HeaderMap,
    Path((project, invite)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = admin(&s, &h, &project).await?;
    let result=sqlx::query("UPDATE workspace_invitations SET status='revoked' WHERE project_id=$1 AND id=$2 AND status='pending'").bind(&project).bind(crate::path(&invite)?).execute(&mut *tx).await.map_err(db)?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    audit(
        &mut tx,
        &project,
        identity(&h)?.0,
        "console",
        "invitation:revoke",
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn resend(
    State(s): State<AppState>,
    h: HeaderMap,
    Path((project, invite)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let mut tx = admin(&s, &h, &project).await?;
    if s.access.mail.is_none() {
        return Err(unavailable());
    }
    let row=sqlx::query("UPDATE workspace_invitations SET delivery_status='queued',attempts=0,next_attempt_at=now(),expires_at=now()+interval '7 days' WHERE project_id=$1 AND id=$2 AND status='pending' AND delivery_status IN ('sent','failed') AND next_attempt_at<=now() RETURNING *").bind(&project).bind(crate::path(&invite)?).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(|| err(StatusCode::CONFLICT,"resend_unavailable","Wait a minute before resending, and check the invitation is still pending"))?;
    audit(
        &mut tx,
        &project,
        identity(&h)?.0,
        "console",
        "invitation:resend",
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(item(&row)))
}
async fn recipient(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    issuer: &str,
) -> ApiResult<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT email FROM users WHERE id=$1 AND issuer=$2 AND email_verified AND email IS NOT NULL",
    )
    .bind(user)
    .bind(issuer)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?
    .ok_or_else(|| {
        err(
            StatusCode::FORBIDDEN,
            "email_not_verified",
            "Verify your email with your sign-in provider, then sign in again to join",
        )
    })
}
async fn preview(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(invite): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = auth::session_read_transaction(&s, &h).await?;
    let email = recipient(&mut tx, identity(&h)?.0, s.access.oidc_issuer()).await?;
    let row=sqlx::query("SELECT i.*,p.name AS project_name FROM workspace_invitations i JOIN projects p ON p.id=i.project_id WHERE i.id=$1 AND i.email=$2").bind(crate::path(&invite)?).bind(email).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(missing)?;
    let mut value = item(&row);
    value["workspaceId"] = json!(row.get::<String, _>("project_id"));
    value["workspaceName"] = json!(row.get::<String, _>("project_name"));
    Ok(Json(value))
}
async fn accept(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(invite): Path<String>,
) -> ApiResult<Json<Value>> {
    let invite = crate::path(&invite)?;
    let mut tx = auth::session_read_transaction(&s, &h).await?;
    let (user, _) = identity(&h)?;
    let email = recipient(&mut tx, user, s.access.oidc_issuer()).await?;
    let project: String =
        sqlx::query_scalar("SELECT project_id FROM workspace_invitations WHERE id=$1 AND email=$2")
            .bind(invite)
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or_else(missing)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("membership:{project}"))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let row = sqlx::query(
        "SELECT *,expires_at>now() AS unexpired FROM workspace_invitations WHERE id=$1 FOR UPDATE",
    )
    .bind(invite)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let status = row.get::<String, _>("status");
    if status == "accepted" && row.get::<Option<Uuid>, _>("accepted_by") == Some(user) {
        return Ok(Json(json!({"workspaceId":project})));
    }
    if status != "pending" || !row.get::<bool, _>("unexpired") {
        return Err(err(
            StatusCode::GONE,
            "invitation_closed",
            "This invitation has expired, was revoked, or has already been used",
        ));
    }
    // An old invitation cannot change an existing member's role.
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&project).bind(user).bind(row.get::<String,_>("role")).execute(&mut *tx).await.map_err(db)?;
    sqlx::query("UPDATE workspace_invitations SET status='accepted',accepted_by=$2 WHERE id=$1")
        .bind(invite)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    audit(&mut tx, &project, user, "console", "invitation:accept").await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"workspaceId":project})))
}

/// Startup runs while the service owns its existing singleton queue lock.
pub async fn recover_invitation_mail(s: &AppState) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE workspace_invitations SET delivery_status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END WHERE delivery_status='sending'").execute(&s.db).await?;
    Ok(())
}
/// At-least-once SMTP: a crash after acceptance can duplicate the same harmless link.
pub async fn invitation_worker(s: AppState) -> Result<(), sqlx::Error> {
    let _worker = s.runtime.worker_started();
    let Some(mail) = &s.access.mail else {
        s.runtime.wait_for_drain().await;
        return Ok(());
    };
    loop {
        if s.runtime.is_draining() {
            return Ok(());
        }
        let Some(permit) = s.runtime.claim_permit().await else {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            continue;
        };
        let row=sqlx::query("UPDATE workspace_invitations SET delivery_status='sending',attempts=attempts+1 WHERE id=(SELECT id FROM workspace_invitations WHERE status='pending' AND expires_at>now() AND delivery_status='queued' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *").fetch_optional(&s.db).await?;
        drop(permit);
        if let Some(row) = row {
            let id = row.get::<Uuid, _>("id");
            let workspace: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1")
                .bind(row.get::<String, _>("project_id"))
                .fetch_one(&s.db)
                .await?;
            let sent = mail
                .invite(
                    &row.get::<String, _>("email"),
                    &workspace,
                    &row.get::<String, _>("role"),
                    id,
                )
                .await
                .is_ok();
            sqlx::query("UPDATE workspace_invitations SET delivery_status=CASE WHEN $2 THEN 'sent' WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,sent_at=CASE WHEN $2 THEN now() ELSE sent_at END,next_attempt_at=now()+interval '1 minute' WHERE id=$1").bind(id).bind(sent).execute(&s.db).await?;
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }
}
