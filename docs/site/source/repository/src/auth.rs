use crate::{ApiResult, AppState, Grant, err};
use std::collections::{HashMap, HashSet};

/// Validate static grants before accepting requests. Errors never contain grant values.
pub fn validate_grants(grants: &[Grant]) -> Result<(), &'static str> {
    let mut principals = HashMap::new();
    let mut pairs = HashSet::new();
    for grant in grants {
        if grant.token.is_empty()
            || grant.principal_id.trim().is_empty()
            || grant.project_id.trim().is_empty()
        {
            return Err("grant token, principal and project must be nonempty");
        }
        if grant.principal_id.trim().contains(':') {
            return Err("grant principal must not use a reserved namespace");
        }
        if let Some(previous) = principals.insert(&grant.token, &grant.principal_id)
            && previous != &grant.principal_id
        {
            return Err("a token cannot identify multiple principals");
        }
        if !pairs.insert((&grant.token, &grant.project_id)) {
            return Err("duplicate token and project grant");
        }
        let mut rights = HashSet::new();
        for right in &grant.rights {
            if !matches!(right.as_str(), "read" | "write" | "propose" | "promote") {
                return Err("unknown grant right");
            }
            if !rights.insert(right) {
                return Err("duplicate grant right");
            }
        }
    }
    Ok(())
}

use axum::http::{HeaderMap, StatusCode, header};
#[derive(Clone)]
pub(crate) struct Actor {
    pub(crate) principal: String,
    pub(crate) service_principal: String,
    pub(crate) user_id: Option<uuid::Uuid>,
    pub(crate) session_id: Option<uuid::Uuid>,
    pub(crate) required_right: String,
}
pub(crate) fn actor(h: &HeaderMap, s: &AppState, project: &str, right: &str) -> ApiResult<Actor> {
    let raw = h
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .ok_or_else(|| {
            err(
                StatusCode::UNAUTHORIZED,
                "unauthenticated",
                "Bearer token required",
            )
        })?;
    if s.access.console_token() == raw {
        let user = h
            .get("x-acclimate-trusted-user")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| uuid::Uuid::parse_str(v).ok())
            .ok_or_else(|| {
                err(
                    StatusCode::UNAUTHORIZED,
                    "unauthenticated",
                    "Browser session required",
                )
            })?;
        let session = h
            .get("x-acclimate-trusted-session")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| uuid::Uuid::parse_str(v).ok())
            .ok_or_else(|| {
                err(
                    StatusCode::UNAUTHORIZED,
                    "unauthenticated",
                    "Browser session required",
                )
            })?;
        let role = h
            .get("x-acclimate-trusted-role")
            .and_then(|v| v.to_str().ok());
        if !match right {
            "read" => role.is_some(),
            "admin" => role == Some("admin"),
            _ => matches!(role, Some("editor" | "admin")),
        } {
            return Err(err(
                StatusCode::FORBIDDEN,
                "denied",
                "Current membership does not allow this operation",
            ));
        }
        return Ok(Actor {
            principal: format!("user:{user}"),
            service_principal: "console".into(),
            user_id: Some(user),
            session_id: Some(session),
            required_right: right.into(),
        });
    }
    if !s.grants.iter().any(|g| g.token == raw) {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Unknown bearer token",
        ));
    }
    let g = s
        .grants
        .iter()
        .find(|g| g.token == raw && g.project_id == project)
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "denied", "No grant for project"))?;
    if !g.rights.iter().any(|r| r == right) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Required right is missing",
        ));
    }
    if h.contains_key("x-acclimate-session") {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "invalid_console_transport",
            "Browser requests require dedicated console transport",
        ));
    }
    Ok(Actor {
        principal: g.principal_id.clone(),
        service_principal: g.principal_id.clone(),
        user_id: None,
        session_id: None,
        required_right: right.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Grant;
    use std::sync::Arc;
    #[tokio::test]
    async fn one_principal_can_have_distinct_project_grants() {
        let state = AppState {
            access: Arc::new(
                crate::AccessConfig::new(
                    "https://fixture.example".into(),
                    "fixture-login".into(),
                    "fixture-console".into(),
                    vec![crate::OperatorIdentity {
                        issuer: "https://fixture.example".into(),
                        subject: "operator".into(),
                    }],
                    &[],
                )
                .unwrap(),
            ),
            runtime: Arc::new(crate::RuntimeStatus::new()),
            db: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/unused")
                .unwrap(),
            grants: Arc::new(vec![
                Grant {
                    token: "fixture-token".into(),
                    principal_id: "app".into(),
                    project_id: "a".into(),
                    rights: vec!["read".into()],
                },
                Grant {
                    token: "fixture-token".into(),
                    principal_id: "app".into(),
                    project_id: "b".into(),
                    rights: vec!["read".into(), "write".into()],
                },
            ]),
            provider: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer fixture-token".parse().unwrap(),
        );
        assert!(actor(&headers, &state, "b", "write").is_ok());
        assert!(actor(&headers, &state, "a", "write").is_err());
        assert!(actor(&headers, &state, "missing", "read").is_err());
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    fn grant(token: &str, principal: &str, project: &str, rights: &[&str]) -> Grant {
        Grant {
            token: token.into(),
            principal_id: principal.into(),
            project_id: project.into(),
            rights: rights.iter().map(|s| (*s).into()).collect(),
        }
    }

    #[test]
    fn rejects_ambiguous_and_invalid_grants_without_exposing_values() {
        let cases = [
            vec![
                grant("secret", "a", "p", &["read"]),
                grant("secret", "b", "q", &["read"]),
            ],
            vec![
                grant("secret", "a", "p", &["read"]),
                grant("secret", "a", "p", &["write"]),
            ],
            vec![grant("secret", "a", "p", &["read", "read"])],
            vec![grant("secret", "a", "p", &["admin"])],
            vec![grant("", "a", "p", &["read"])],
            vec![grant(
                "secret",
                "service:connected-learning",
                "p",
                &["read"],
            )],
            vec![grant("secret", "user:spoof", "p", &["read"])],
            vec![grant("secret", "future:reserved", "p", &["read"])],
        ];
        for grants in cases {
            let error = validate_grants(&grants).unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert!(
            validate_grants(&[
                grant("secret", "a", "p", &["read"]),
                grant("secret", "a", "q", &["write"])
            ])
            .is_ok()
        );
    }
}

pub(crate) async fn session_context(
    axum::extract::State(s): axum::extract::State<AppState>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use sqlx::Row;
    request.headers_mut().remove("x-acclimate-trusted-role");
    request.headers_mut().remove("x-acclimate-trusted-user");
    request.headers_mut().remove("x-acclimate-trusted-session");
    let login =
        request.uri().path() == "/v1/auth/sessions" && request.method() == axum::http::Method::POST;
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let console = bearer == Some(s.access.console_token());
    let login_authority = login && bearer == Some(s.access.login_token());
    let has_session = request.headers().contains_key("x-acclimate-session");
    // Never interpret a session until its transport class is authenticated. Login
    // alone may carry an opaque previous-session rotation hint.
    if !login_authority
        && (has_session || request.uri().path().starts_with("/v1/auth/"))
        && !console
    {
        return err(
            StatusCode::UNAUTHORIZED,
            "invalid_console_transport",
            "Dedicated console transport required",
        )
        .into_response();
    }
    if !login && console && !has_session {
        return err(
            StatusCode::UNAUTHORIZED,
            "invalid_session",
            "Browser session required",
        )
        .into_response();
    }
    if let Some(secret) = request
        .headers()
        .get("x-acclimate-session")
        .filter(|_| !login)
    {
        let Ok(secret) = secret.to_str() else {
            return err(
                StatusCode::UNAUTHORIZED,
                "invalid_session",
                "Invalid session",
            )
            .into_response();
        };
        let row = sqlx::query("SELECT id,user_id FROM browser_sessions WHERE secret_hash=$1 AND revoked_at IS NULL AND expires_at>now()")
            .bind(crate::digest(secret.as_bytes())).fetch_optional(&s.db).await;
        match row {
            Ok(Some(row)) => {
                let user: uuid::Uuid = row.get("user_id");
                let session: uuid::Uuid = row.get("id");
                request.headers_mut().insert(
                    "x-acclimate-trusted-user",
                    user.to_string().parse().unwrap(),
                );
                request.headers_mut().insert(
                    "x-acclimate-trusted-session",
                    session.to_string().parse().unwrap(),
                );
            }
            Ok(None) => {
                return err(
                    StatusCode::UNAUTHORIZED,
                    "invalid_session",
                    "Invalid or expired session",
                )
                .into_response();
            }
            Err(e) => return crate::db(e).into_response(),
        }
    }
    // Resolve a role for synchronous actor checks. Each handler owns its single
    // authorization + data transaction; never retain a second pool connection here.
    if let Some(user) = request
        .headers()
        .get("x-acclimate-trusted-user")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| uuid::Uuid::parse_str(v).ok())
    {
        let parts: Vec<_> = request.uri().path().split('/').collect();
        if parts.len() >= 4 && parts[1] == "v1" && matches!(parts[2], "workspaces" | "projects") {
            let role: Option<String> = match sqlx::query_scalar(
                "SELECT role FROM project_memberships WHERE project_id=$1 AND user_id=$2",
            )
            .bind(parts[3])
            .bind(user)
            .fetch_optional(&s.db)
            .await
            {
                Ok(role) => role,
                Err(e) => return crate::db(e).into_response(),
            };
            let Some(role) = role else {
                return err(StatusCode::FORBIDDEN, "denied", "No project membership")
                    .into_response();
            };
            request
                .headers_mut()
                .insert("x-acclimate-trusted-role", role.parse().unwrap());
        }
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
}

pub(crate) async fn authorize_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    a: &Actor,
    project: &str,
    right: &str,
) -> ApiResult<()> {
    use sqlx::Row;
    let (Some(user), Some(session)) = (a.user_id, a.session_id) else {
        return Ok(());
    };
    let valid: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM browser_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE")
        .bind(session).bind(user).fetch_optional(&mut **tx).await.map_err(crate::db)?;
    if valid.is_none() {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "invalid_session",
            "Invalid or expired session",
        ));
    }
    let row = sqlx::query(
        "SELECT role FROM project_memberships WHERE project_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(project)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await
    .map_err(crate::db)?;
    let allowed = row.is_some_and(|r| {
        let role: String = r.get("role");
        match right {
            "read" => true,
            "admin" => role == "admin",
            _ => role == "editor" || role == "admin",
        }
    });
    if !allowed {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Current membership does not allow this operation",
        ));
    }
    Ok(())
}

/// Deployment configuration validation; call before accepting traffic.
pub fn validate_access_config(grants: &[Grant]) -> Result<(), &'static str> {
    crate::access_config::AccessConfig::from_env(grants).map(|_| ())
}

pub(crate) async fn read_transaction<'a>(
    s: &'a AppState,
    h: &HeaderMap,
    project: &str,
) -> ApiResult<sqlx::Transaction<'a, sqlx::Postgres>> {
    let a = actor(h, s, project, "read")?;
    let mut tx = s.db.begin().await.map_err(crate::db)?;
    authorize_transaction(&mut tx, &a, project, "read").await?;
    Ok(tx)
}
pub(crate) async fn session_read_transaction<'a>(
    s: &'a AppState,
    h: &HeaderMap,
) -> ApiResult<sqlx::Transaction<'a, sqlx::Postgres>> {
    let mut tx = s.db.begin().await.map_err(crate::db)?;
    if let (Some(user), Some(session)) = (
        h.get("x-acclimate-trusted-user"),
        h.get("x-acclimate-trusted-session"),
    ) {
        let user = user
            .to_str()
            .ok()
            .and_then(|v| uuid::Uuid::parse_str(v).ok())
            .ok_or_else(|| {
                err(
                    StatusCode::UNAUTHORIZED,
                    "invalid_session",
                    "Invalid session",
                )
            })?;
        let session = session
            .to_str()
            .ok()
            .and_then(|v| uuid::Uuid::parse_str(v).ok())
            .ok_or_else(|| {
                err(
                    StatusCode::UNAUTHORIZED,
                    "invalid_session",
                    "Invalid session",
                )
            })?;
        let valid:Option<uuid::Uuid>=sqlx::query_scalar("SELECT id FROM browser_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE").bind(session).bind(user).fetch_optional(&mut *tx).await.map_err(crate::db)?;
        if valid.is_none() {
            return Err(err(
                StatusCode::UNAUTHORIZED,
                "invalid_session",
                "Invalid session",
            ));
        }
    }
    Ok(tx)
}
