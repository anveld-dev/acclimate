use crate::{ApiResult, AppState, auth, db, err};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/workspaces/{project}/users/{user}", get(verified_user))
        .route("/v1/workspaces/{project}/memberships", get(memberships))
        .route("/v1/workspaces", get(projects).post(create_project))
        .route("/v1/workspaces/{project}/bundles", get(bundles))
        .route(
            "/v1/workspaces/{project}/bundles/{bundle}/channels",
            get(channels),
        )
        .route("/v1/auth/sessions", post(login))
        .route("/v1/auth/workspace-adoptions", post(adopt_workspace))
        .route("/v1/auth/session", get(session).delete(logout))
        .route(
            "/v1/workspaces/{project}/memberships/{user}",
            put(membership).delete(remove_membership),
        )
}
pub async fn backfill_projects(s: &AppState) -> Result<(), sqlx::Error> {
    for g in s.grants.iter() {
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING")
            .bind(&g.project_id)
            .execute(&s.db)
            .await?;
    }
    Ok(())
}
fn invalid() -> crate::ApiErr {
    err(
        StatusCode::BAD_REQUEST,
        "invalid_content",
        "Invalid workspace request",
    )
}
fn id(v: &str) -> ApiResult<()> {
    if v.is_empty()
        || matches!(v, "." | "..")
        || v.len() > 128
        || !v
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(invalid());
    }
    Ok(())
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Page {
    cursor: Option<String>,
    limit: Option<i64>,
}
impl Page {
    fn bounds(&self) -> ApiResult<(String, i64)> {
        let cursor = self.cursor.as_deref().unwrap_or("");
        let raw = if cursor.is_empty() {
            String::new()
        } else {
            String::from_utf8(hex::decode(cursor).map_err(|_| invalid())?).map_err(|_| invalid())?
        };
        if raw.len() > 256 {
            return Err(invalid());
        }
        Ok((raw, self.limit.unwrap_or(50).clamp(1, 100)))
    }
}
fn page(mut items: Vec<Value>, limit: i64, key: &str) -> Json<Value> {
    let next = if items.len() > limit as usize {
        items.truncate(limit as usize);
        items
            .last()
            .and_then(|v| v[key].as_str())
            .map(|v| hex::encode(v.as_bytes()))
    } else {
        None
    };
    Json(json!({"items":items,"nextCursor":next}))
}
pub(crate) fn identity(h: &HeaderMap) -> ApiResult<(Uuid, Uuid)> {
    let parse = |k| {
        h.get(k)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| Uuid::parse_str(v).ok())
    };
    Ok((
        parse("x-acclimate-trusted-user").ok_or_else(|| {
            err(
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Browser session required",
            )
        })?,
        parse("x-acclimate-trusted-session").ok_or_else(|| {
            err(
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Browser session required",
            )
        })?,
    ))
}
fn machine(h: &HeaderMap, s: &AppState) -> ApiResult<()> {
    let token = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if token == Some(s.access.console_token()) {
        identity(h)?;
        return Ok(());
    }
    if h.contains_key("x-acclimate-session") {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "invalid_console_transport",
            "Dedicated console transport required",
        ));
    }
    if !s.grants.iter().any(|g| Some(g.token.as_str()) == token)
        && crate::machine_tokens::trusted(h).is_none()
    {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Service credential required",
        ));
    }
    Ok(())
}
async fn projects(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    machine(&h, &s)?;
    let (cursor, limit) = p.bounds()?;
    let mut tx = auth::session_read_transaction(&s, &h).await?;
    let rows = if h.contains_key("x-acclimate-session") {
        let (user, _) = identity(&h)?;
        sqlx::query("SELECT p.id,p.name,m.role FROM projects p JOIN project_memberships m ON m.project_id=p.id WHERE m.user_id=$1 AND p.id>$2 ORDER BY p.id LIMIT $3 FOR SHARE OF m").bind(user).bind(cursor).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?
    } else {
        let token = h
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .trim_start_matches("Bearer ");
        let machine = crate::machine_tokens::trusted(&h)
            .filter(|m| auth::rights_allow(&m.rights, "read"))
            .map(|m| m.project_id);
        let ids: Vec<&str> = s
            .grants
            .iter()
            .filter(|g| g.token == token && auth::rights_allow(&g.rights, "read"))
            .map(|g| g.project_id.as_str())
            .chain(machine.as_deref())
            .collect();
        sqlx::query("SELECT id,name,'operator'::text AS role FROM projects WHERE id=ANY($1) AND id>$2 ORDER BY id LIMIT $3").bind(ids).bind(cursor).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?
    };
    Ok(page(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"role":r.get::<String,_>("role")})).collect(),limit,"id"))
}
async fn bundles(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(project): Path<String>,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    id(&project)?;
    let a = auth::actor(&h, &s, &project, "read")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, &project, "read").await?;
    let (cursor, limit) = p.bounds()?;
    let rows=sqlx::query("SELECT id,name,created_at,origin,source_label,compatibility_target FROM bundles WHERE project_id=$1 AND id::text>$2 ORDER BY id::text LIMIT $3").bind(&project).bind(cursor).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(page(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"workspaceId":project,"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"origin":r.get::<String,_>("origin"),"sourceLabel":r.get::<Option<String>,_>("source_label"),"compatibilityTarget":r.get::<String,_>("compatibility_target")})).collect(),limit,"id"))
}
async fn channels(
    State(s): State<AppState>,
    h: HeaderMap,
    Path((project, bundle)): Path<(String, String)>,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    id(&project)?;
    let bundle = crate::path(&bundle)?;
    let a = auth::actor(&h, &s, &project, "read")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, &project, "read").await?;
    let (cursor, limit) = p.bounds()?;
    let rows = sqlx::query(
        "SELECT name, revision, version_id FROM channels
         WHERE project_id=$1 AND bundle_id=$2 AND name>$3
         ORDER BY name LIMIT $4",
    )
    .bind(project)
    .bind(bundle)
    .bind(cursor)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(page(rows.iter().map(|r|json!({"name":r.get::<String,_>("name"),"revision":r.get::<i64,_>("revision").to_string(),"versionId":r.get::<Uuid,_>("version_id")})).collect(),limit,"name"))
}
#[derive(Deserialize)]
struct Login {
    issuer: String,
    subject: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default, rename = "emailVerified")]
    email_verified: bool,
}
async fn login(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(v): Json<Login>,
) -> ApiResult<Json<Value>> {
    let configured = s.access.login_token();
    if h.get("authorization").and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {configured}").as_str())
    {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Login credential required",
        ));
    }
    if v.issuer != s.access.oidc_issuer() || v.subject.trim().is_empty() || v.subject.len() > 512 {
        return Err(invalid());
    }
    let display_name = v
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= 200);
    let email = v.email.as_deref().and_then(crate::mail::normalize_email);
    if v.email_verified && email.is_none() {
        return Err(invalid());
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    let user:Uuid=sqlx::query_scalar("INSERT INTO users(id,issuer,subject,display_name,email,email_verified) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email,email_verified=EXCLUDED.email_verified RETURNING id").bind(Uuid::new_v4()).bind(v.issuer).bind(v.subject).bind(display_name).bind(email).bind(v.email_verified).fetch_one(&mut *tx).await.map_err(db)?;
    // A fresh secret rotates the caller's previous session when supplied.
    if let Some(secret) = h.get("x-acclimate-session").and_then(|v| v.to_str().ok()) {
        sqlx::query("UPDATE browser_sessions SET revoked_at=now() WHERE secret_hash=$1")
            .bind(crate::digest(secret.as_bytes()))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let session = Uuid::new_v4();
    let expiry:chrono::DateTime<chrono::Utc>=sqlx::query_scalar("INSERT INTO browser_sessions(id,secret_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours') RETURNING expires_at").bind(session).bind(crate::digest(secret.as_bytes())).bind(user).fetch_one(&mut *tx).await.map_err(db)?;
    audit(&mut tx, "", user, "login", "/v1/auth/sessions").await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"sessionId":session,"userId":user,"secret":secret,"expiresAt":expiry}),
    ))
}
async fn session(State(s): State<AppState>, h: HeaderMap) -> ApiResult<Json<Value>> {
    machine(&h, &s)?;
    let (user, session) = identity(&h)?;
    let mut tx = auth::session_read_transaction(&s, &h).await?;
    let row = sqlx::query("SELECT issuer,subject,display_name FROM users WHERE id=$1")
        .bind(user)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let issuer = row.get::<String, _>("issuer");
    let subject = row.get::<String, _>("subject");
    Ok(Json(with_display_name(
        json!({
            "userId":user,"sessionId":session,"issuer":issuer,"subject":subject,
            "canCreateWorkspace":s.access.is_operator(&issuer, &subject)
        }),
        row.get("display_name"),
    )))
}

async fn logout(State(s): State<AppState>, h: HeaderMap) -> ApiResult<StatusCode> {
    machine(&h, &s)?;
    let (user, session) = identity(&h)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    let revoked: Option<Uuid> = sqlx::query_scalar("UPDATE browser_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING id")
        .bind(session).bind(user).fetch_optional(&mut *tx).await.map_err(db)?;
    if revoked.is_none() {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "invalid_session",
            "Invalid session",
        ));
    }
    audit(
        &mut tx,
        "",
        user,
        &service(&h, &s),
        "/v1/auth/session/logout",
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct NewProject {
    id: String,
    name: String,
}
async fn create_project(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(v): Json<NewProject>,
) -> ApiResult<Json<Value>> {
    machine(&h, &s)?;
    id(&v.id)?;
    if v.name.trim().is_empty() || v.name.len() > 200 {
        return Err(invalid());
    }
    let (user, session) = identity(&h)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    require_operator(&s, &mut tx, user, session).await?;
    let inserted =
        sqlx::query("INSERT INTO projects(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING")
            .bind(&v.id)
            .bind(&v.name)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    if inserted.rows_affected() == 0 {
        return Err(err(
            StatusCode::CONFLICT,
            "workspace_exists",
            "Workspace ID is already registered",
        ));
    }
    sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin')")
        .bind(&v.id)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    audit(&mut tx, &v.id, user, &service(&h, &s), "/v1/workspaces").await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"id":v.id,"name":v.name,"role":"admin"})))
}
#[derive(Deserialize)]
struct Membership {
    role: String,
}
async fn membership(
    State(s): State<AppState>,
    h: HeaderMap,
    Path((project, user)): Path<(String, String)>,
    Json(v): Json<Membership>,
) -> ApiResult<StatusCode> {
    if !matches!(v.role.as_str(), "viewer" | "editor" | "admin") {
        return Err(invalid());
    }
    change_membership(s, h, project, user, Some(v.role)).await
}
async fn remove_membership(
    State(s): State<AppState>,
    h: HeaderMap,
    Path((project, user)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    change_membership(s, h, project, user, None).await
}
async fn change_membership(
    s: AppState,
    h: HeaderMap,
    project: String,
    user: String,
    role: Option<String>,
) -> ApiResult<StatusCode> {
    let a = auth::actor(&h, &s, &project, "read")?;
    if a.user_id.is_none() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Browser admin required",
        ));
    }
    let target = crate::path(&user)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    // Serialize membership writers before caller/target locks to avoid crossed-admin cycles.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("membership:{project}"))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, &project, "admin").await?;
    let previous = sqlx::query_scalar::<_, String>(
        "SELECT role FROM project_memberships WHERE project_id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(&project)
    .bind(target)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    if previous.as_deref() == Some("admin") && role.as_deref() != Some("admin") {
        let admins: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM project_memberships WHERE project_id=$1 AND role='admin'",
        )
        .bind(&project)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if admins <= 1 {
            return Err(err(
                StatusCode::CONFLICT,
                "last_admin",
                "Add another administrator before removing or demoting the final administrator",
            ));
        }
    }
    if let Some(role) = role {
        sqlx::query("INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role").bind(&project).bind(target).bind(role).execute(&mut *tx).await.map_err(db)?;
    } else {
        sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
            .bind(&project)
            .bind(target)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    audit(
        &mut tx,
        &project,
        a.user_id.unwrap(),
        &a.service_principal,
        &format!("/v1/workspaces/{project}/memberships/{target}"),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT)
}

fn service(h: &HeaderMap, s: &AppState) -> String {
    let token = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    s.grants
        .iter()
        .find(|g| Some(g.token.as_str()) == token)
        .map(|g| g.principal_id.clone())
        .unwrap_or_else(|| "console".into())
}
// `path` is the audited operation key: the canonical route
// (`/v1/workspaces/...`).
pub(crate) async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    user: Uuid,
    service: &str,
    path: &str,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO mutation_audit(project_id,actor_user_id,service_principal,principal_id,path,operation_key) VALUES($1,$2,$3,$4,$5,$6)").bind(project).bind(user).bind(service).bind(format!("user:{user}")).bind(path).bind(Uuid::new_v4().to_string()).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

async fn memberships(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(project): Path<String>,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    id(&project)?;
    let a = auth::actor(&h, &s, &project, "read")?;
    if a.user_id.is_none() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Browser admin required",
        ));
    }
    let (cursor, limit) = p.bounds()?;
    if !cursor.is_empty() && Uuid::parse_str(&cursor).is_err() {
        return Err(invalid());
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, &project, "admin").await?;
    let rows = sqlx::query("SELECT u.id,u.issuer,u.subject,u.display_name,m.role FROM project_memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND u.id::text>$2 ORDER BY u.id::text LIMIT $3 FOR SHARE OF m")
        .bind(&project).bind(cursor).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?;
    let items = rows.iter().map(|r| with_display_name(json!({"id":r.get::<Uuid,_>("id"),"issuer":r.get::<String,_>("issuer"),"subject":r.get::<String,_>("subject"),"role":r.get::<String,_>("role")}),r.get("display_name"))).collect();
    tx.commit().await.map_err(db)?;
    Ok(page(items, limit, "id"))
}

async fn verified_user(
    State(s): State<AppState>,
    h: HeaderMap,
    Path((project, user)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let a = auth::actor(&h, &s, &project, "read")?;
    if a.user_id.is_none() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Browser admin required",
        ));
    }
    let user = crate::path(&user)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    auth::authorize_transaction(&mut tx, &a, &project, "admin").await?;
    let row = sqlx::query("SELECT u.issuer,u.subject,u.display_name,m.role FROM users u LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1")
        .bind(user).bind(&project)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "not_found",
                "Verified user not found",
            )
        })?;
    let result = with_display_name(
        json!({"id":user,"issuer":row.get::<String,_>("issuer"),"subject":row.get::<String,_>("subject"),"role":row.get::<Option<String>,_>("role")}),
        row.get("display_name"),
    );
    tx.commit().await.map_err(db)?;
    Ok(Json(result))
}

/// A live browser session and exact configured operator pair are both rechecked
/// inside the caller's transaction. Operator capability never implies membership.
async fn require_operator(
    s: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    session: Uuid,
) -> ApiResult<()> {
    let row = sqlx::query("SELECT u.issuer,u.subject FROM browser_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF s")
        .bind(session).bind(user).fetch_optional(&mut **tx).await.map_err(db)?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_session", "Invalid session"))?;
    if !s.access.is_operator(
        &row.get::<String, _>("issuer"),
        &row.get::<String, _>("subject"),
    ) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Operator identity required",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adoption {
    #[serde(rename = "workspaceId")]
    project_id: String,
    reason: String,
}
async fn adopt_workspace(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(v): Json<Adoption>,
) -> ApiResult<Json<Value>> {
    machine(&h, &s)?;
    let (user, session) = identity(&h)?;
    id(&v.project_id)?;
    if v.reason.trim().is_empty() || v.reason.len() > 2000 {
        return Err(invalid());
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    // Same order as membership mutations: writer lock, live session, membership.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("membership:{}", v.project_id))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    require_operator(&s, &mut tx, user, session).await?;
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM projects WHERE id=$1 FOR SHARE")
            .bind(&v.project_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    if exists.is_none() {
        return Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            "Workspace not found",
        ));
    }
    let historical = sqlx::query(
        "SELECT user_id,reason,created_at FROM workspace_adoptions WHERE project_id=$1",
    )
    .bind(&v.project_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let already_adopted = historical.is_some();
    let (reason, created_at) = if let Some(row) = historical {
        if row.get::<Uuid, _>("user_id") != user {
            return Err(err(
                StatusCode::CONFLICT,
                "already_adopted",
                "Workspace was adopted by another operator",
            ));
        }
        (
            row.get::<String, _>("reason"),
            row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        )
    } else {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM project_memberships WHERE project_id=$1")
                .bind(&v.project_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count != 0 {
            return Err(err(
                StatusCode::CONFLICT,
                "workspace_owned",
                "Workspace already has memberships",
            ));
        }
        let created_at = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>("INSERT INTO workspace_adoptions(project_id,user_id,reason) VALUES($1,$2,$3) RETURNING created_at")
            .bind(&v.project_id).bind(user).bind(&v.reason).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query(
            "INSERT INTO project_memberships(project_id,user_id,role) VALUES($1,$2,'admin')",
        )
        .bind(&v.project_id)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        audit(
            &mut tx,
            &v.project_id,
            user,
            "console",
            "/v1/auth/workspace-adoptions",
        )
        .await?;
        (v.reason, created_at)
    };
    let current_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM project_memberships WHERE project_id=$1 AND user_id=$2",
    )
    .bind(&v.project_id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({ "workspaceId":v.project_id, "userId":user, "reason":reason, "createdAt":created_at, "alreadyAdopted":already_adopted, "currentRole":current_role }),
    ))
}

// Names are optional display metadata, never an authorization identity.
fn with_display_name(mut identity: Value, name: Option<String>) -> Value {
    if let Some(name) = name {
        identity["displayName"] = json!(name);
    }
    identity
}
