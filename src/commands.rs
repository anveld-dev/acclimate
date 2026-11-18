use crate::{ApiResult, AppState, auth::Actor, db, err};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;

/// The installed evaluator promises retained operations only for this route grammar.
pub(crate) fn guided_project(project: &str) -> bool {
    !project.is_empty()
        && project.len() <= 128
        && project != "."
        && project != ".."
        && project
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
pub(crate) fn guided_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn guided_evaluator_route(project: &str, path: &str) -> bool {
    let Some(suffix) = path.strip_prefix(&format!("/v1/projects/{project}/")) else {
        return false;
    };
    match suffix.split('/').collect::<Vec<_>>().as_slice() {
        ["bundles", bundle, "comparisons" | "evaluation-requests"] => guided_uuid(bundle),
        [
            "bundles",
            bundle,
            "evaluation-requests",
            request,
            "start" | "finish" | "interrupt",
        ] => guided_uuid(bundle) && guided_uuid(request),
        _ => false,
    }
}

// Body identities are part of the guided target too. Legacy raw writes retain
// their historical ID syntax; a retained-ready write must use canonical UUIDs.
fn guided_evaluator_body(path: &str, body: &[u8]) -> bool {
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let canonical = |value: &Value| value.as_str().is_some_and(guided_uuid);
    if path.ends_with("/start") {
        canonical(&body["attemptId"])
    } else if path.ends_with("/finish") {
        canonical(&body["attemptId"]) && canonical(&body["comparisonId"])
    } else if path.ends_with("/interrupt") {
        true
    } else {
        canonical(&body["parentVersionId"])
            && canonical(&body["candidateVersionId"])
            && (body["proposalId"].is_null() || canonical(&body["proposalId"]))
            && (body["evaluation"].is_null()
                || (canonical(&body["evaluation"]["requestId"])
                    && canonical(&body["evaluation"]["attemptId"])))
    }
}

// This is the sole action/namespace definition for execution, replay, lookup and close.
fn rights(project: &str, path: &str) -> Option<&'static [&'static str]> {
    let suffix = path.strip_prefix(&format!("/v1/projects/{project}/"))?;
    let p: Vec<_> = suffix.split('/').collect();
    if p.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return None;
    }
    if !guided_project(project) {
        return None;
    }
    let uuid = |s: &str| uuid::Uuid::parse_str(s).is_ok() && s.len() == 36;
    match p.as_slice() {
        ["bundle-setups"] => Some(&["write", "promote"]),
        // Version creation uses the same legacy UUID syntax as ordinary authoring.
        // A marked write retains its receipt; lookup/close require current write authority.
        ["bundles", b, "versions"] if uuid(b) => Some(&["write"]),
        ["bundles", b, "proposals"] if uuid(b) => Some(&["propose"]),
        ["bundles", b, "evaluation-requests"] if uuid(b) => Some(&["write"]),
        ["bundles", b, "comparisons"] if guided_uuid(b) => Some(&["write"]),
        [
            "bundles",
            b,
            "evaluation-requests",
            e,
            "start" | "finish" | "interrupt",
        ] if guided_uuid(b) && guided_uuid(e) => Some(&["write"]),
        ["bundles", b, "channels", c, "promotions"]
            if uuid(b) && crate::channels::valid_channel(c) =>
        {
            Some(&["promote"])
        }
        ["bundles", b, "channels", c, "drafts"] if uuid(b) && crate::channels::valid_channel(c) => {
            Some(&["write"])
        }
        ["bundles", b, "channels", c, "drafts", d, "save" | "discard"]
            if uuid(b) && uuid(d) && crate::channels::valid_channel(c) =>
        {
            Some(&["write"])
        }
        ["bundles", b, "channels", c, "drafts", d, "publish"]
            if uuid(b) && uuid(d) && crate::channels::valid_channel(c) =>
        {
            Some(&["promote"])
        }
        _ => None,
    }
}
fn global(path: &str) -> bool {
    path.ends_with("/bundle-setups") || path.split('/').nth(8) == Some("drafts")
}
fn namespace(path: &str) -> &str {
    if global(path) { "" } else { path }
}
fn lock(principal: &str, project: &str, path: &str, key: &str) -> String {
    if path.is_empty() || global(path) {
        format!("content:{principal}:{project}:{key}")
    } else {
        format!("{principal}:{project}:POST:{path}:{key}")
    }
}
fn validate_key(key: &str) -> ApiResult<()> {
    if key.is_empty() || key.len() > 128 || !key.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid operation ID",
        ));
    }
    Ok(())
}
async fn authorize(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    s: &AppState,
    a: &Actor,
    h: &HeaderMap,
    p: &str,
    path: &str,
) -> ApiResult<()> {
    for right in rights(p, path).unwrap_or(&["write", "promote"]) {
        crate::auth::actor(h, s, p, right)?;
        crate::auth::authorize_transaction(tx, a, p, right).await?;
    }
    Ok(())
}
fn response(row: &sqlx::postgres::PgRow) -> Response {
    (
        StatusCode::from_u16(row.get::<i32, _>("response_status") as u16).unwrap_or(StatusCode::OK),
        [(header::CONTENT_TYPE, "application/json")],
        row.get::<Vec<u8>, _>("response_body"),
    )
        .into_response()
}
pub(crate) struct MutationTx<'a> {
    pub(crate) tx: sqlx::Transaction<'a, sqlx::Postgres>,
    principal: String,
    project: String,
    path: String,
    key: String,
    fingerprint: Vec<u8>,
    retained: bool,
    user_id: Option<uuid::Uuid>,
    service_principal: String,
}
pub(crate) enum MutationStart<'a> {
    Execute(MutationTx<'a>),
    Replay(Response),
}
pub(crate) async fn begin_mutation<'a>(
    s: &'a AppState,
    a: &Actor,
    project: &str,
    path: &str,
    h: &HeaderMap,
    body: &[u8],
) -> ApiResult<MutationStart<'a>> {
    begin_mutation_inner(s, a, project, path, h, body, false).await
}

pub(crate) async fn begin_admin_mutation<'a>(
    s: &'a AppState,
    a: &Actor,
    project: &str,
    path: &str,
    h: &HeaderMap,
    body: &[u8],
) -> ApiResult<MutationStart<'a>> {
    begin_mutation_inner(s, a, project, path, h, body, true).await
}

async fn begin_mutation_inner<'a>(
    s: &'a AppState,
    a: &Actor,
    project: &str,
    path: &str,
    h: &HeaderMap,
    body: &[u8],
    require_admin: bool,
) -> ApiResult<MutationStart<'a>> {
    let key = h
        .get("idempotency-key")
        .and_then(|x| x.to_str().ok())
        .ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Idempotency-Key required",
            )
        })?;
    validate_key(key)?;
    let audited = rights(project, path).is_some();
    let durable = global(path);
    let marked = h
        .get("x-acclimate-durable-operation")
        .is_some_and(|v| v == "true");
    // Never silently give a guided evaluator a transient 24-hour operation.
    // Other historical routes retain their existing marker handling.
    let evaluator_route = path.ends_with("/comparisons") || path.contains("/evaluation-requests");
    if marked
        && evaluator_route
        && (!audited
            || !guided_evaluator_route(project, path)
            || !guided_evaluator_body(path, body)
            || a.principal.len() > 1024)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "guided_target_unsupported",
            "Target does not support retained evaluator operations",
        ));
    }
    let retained = durable || (audited && marked);
    let mut hash = Sha256::new();
    hash.update(b"POST\0");
    hash.update(path.as_bytes());
    hash.update([0]);
    hash.update(body);
    let fingerprint = hash.finalize().to_vec();
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, a, project, &a.required_right).await?;
    if audited {
        authorize(&mut tx, s, a, h, project, path).await?;
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(lock(&a.principal, project, path, key))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    // An unmarked retry must also honor a retained result or closed operation.
    let recorded = if audited || durable {
        sqlx::query("SELECT path,status,fingerprint,response_status,response_body FROM operation_records WHERE principal_id=$1 AND project_id=$2 AND namespace=$3 AND key=$4").bind(&a.principal).bind(project).bind(namespace(path)).bind(key).fetch_optional(&mut *tx).await.map_err(db)?
    } else {
        None
    };
    if let Some(row) = recorded.as_ref()
        && row.get::<String, _>("status") == "closed"
    {
        return Err(err(
            StatusCode::CONFLICT,
            "operation_closed",
            "Operation was closed; review a new request",
        ));
    }
    let transient = if recorded.is_none() && !durable {
        sqlx::query("SELECT path,fingerprint,response_status,response_body FROM idempotency WHERE principal_id=$1 AND project_id=$2 AND method='POST' AND path=$3 AND key=$4 AND expires_at>now() FOR UPDATE").bind(&a.principal).bind(project).bind(path).bind(key).fetch_optional(&mut *tx).await.map_err(db)?
    } else {
        None
    };
    let replay = recorded.as_ref().or(transient.as_ref());
    if let Some(row) = replay {
        if row.get::<Vec<u8>, _>("fingerprint") != fingerprint
            || row.get::<String, _>("path") != path
        {
            return Err(err(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "Key was used with different request bytes",
            ));
        }
        // A marked retry can retain an earlier transient result without executing it again.
        if retained && recorded.is_none() {
            store_receipt(
                &mut tx,
                &a.principal,
                project,
                path,
                key,
                &fingerprint,
                (row.get("response_status"), row.get("response_body")),
            )
            .await?;
        }
    }
    let result = replay.map(response);
    sqlx::query("DELETE FROM idempotency WHERE principal_id=$1 AND project_id=$2 AND method='POST' AND path=$3 AND key=$4 AND expires_at<=now()").bind(&a.principal).bind(project).bind(path).bind(key).execute(&mut *tx).await.map_err(db)?;
    if require_admin {
        crate::auth::authorize_transaction(&mut tx, a, project, "admin").await?;
    }
    if let Some(response) = result {
        if retained {
            tx.commit().await.map_err(db)?;
        }
        return Ok(MutationStart::Replay(response));
    }
    Ok(MutationStart::Execute(MutationTx {
        tx,
        principal: a.principal.clone(),
        project: project.into(),
        path: path.into(),
        key: key.into(),
        fingerprint,
        retained,
        user_id: a.user_id,
        service_principal: a.service_principal.clone(),
    }))
}
async fn store_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &str,
    project: &str,
    path: &str,
    key: &str,
    fingerprint: &[u8],
    response: (i32, Vec<u8>),
) -> ApiResult<()> {
    let (status, bytes) = response;
    sqlx::query("INSERT INTO operation_records(principal_id,project_id,namespace,key,path,status,fingerprint,response_status,response_body) VALUES($1,$2,$3,$4,$5,'committed',$6,$7,$8) ON CONFLICT DO NOTHING").bind(principal).bind(project).bind(namespace(path)).bind(key).bind(path).bind(fingerprint).bind(status).bind(bytes).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}
pub(crate) async fn finish_mutation(
    mut c: MutationTx<'_>,
    status: StatusCode,
    value: impl Serialize,
) -> ApiResult<Response> {
    let bytes = serde_json::to_vec(&value).map_err(db)?;
    if c.retained {
        store_receipt(
            &mut c.tx,
            &c.principal,
            &c.project,
            &c.path,
            &c.key,
            &c.fingerprint,
            (status.as_u16() as i32, bytes.clone()),
        )
        .await?;
    } else {
        sqlx::query("INSERT INTO idempotency(principal_id,project_id,method,path,key,fingerprint,response_status,response_body,expires_at) VALUES($1,$2,'POST',$3,$4,$5,$6,$7,now()+interval '24 hours')").bind(&c.principal).bind(&c.project).bind(&c.path).bind(&c.key).bind(&c.fingerprint).bind(status.as_u16() as i32).bind(&bytes).execute(&mut *c.tx).await.map_err(db)?;
    }
    sqlx::query("INSERT INTO mutation_audit(project_id,actor_user_id,service_principal,principal_id,path,operation_key) VALUES($1,$2,$3,$4,$5,$6)").bind(&c.project).bind(c.user_id).bind(&c.service_principal).bind(&c.principal).bind(&c.path).bind(&c.key).execute(&mut *c.tx).await.map_err(db)?;
    c.tx.commit().await.map_err(db)?;
    Ok((status, [(header::CONTENT_TYPE, "application/json")], bytes).into_response())
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationScope {
    operation_path: Option<String>,
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/projects/{project}/operations/{id}", get(operation))
        .route("/v1/projects/{project}/operations/{id}/close", post(close))
}
async fn operation(
    State(s): State<AppState>,
    Path((p, id)): Path<(String, String)>,
    Query(scope): Query<OperationScope>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    outcome(s, p, id, scope, h, false).await
}
async fn close(
    State(s): State<AppState>,
    Path((p, id)): Path<(String, String)>,
    h: HeaderMap,
    Json(scope): Json<OperationScope>,
) -> ApiResult<Json<Value>> {
    if h.get("idempotency-key").and_then(|v| v.to_str().ok()) != Some(id.as_str()) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Close requires the target Idempotency-Key",
        ));
    }
    outcome(s, p, id, scope, h, true).await
}
async fn outcome(
    s: AppState,
    p: String,
    id: String,
    scope: OperationScope,
    h: HeaderMap,
    closing: bool,
) -> ApiResult<Json<Value>> {
    validate_key(&id)?;
    let path = scope.operation_path.as_deref().unwrap_or("");
    if !path.is_empty() && rights(&p, path).is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Unsupported operation path",
        ));
    }
    // Parse an actor with action rights rather than imposing an extra read grant.
    let first = rights(&p, path)
        .and_then(|r| r.first().copied())
        .unwrap_or(if closing { "write" } else { "read" });
    let actor = if path.is_empty() {
        ["read", "write", "promote", "propose"]
            .into_iter()
            .find_map(|right| crate::auth::actor(&h, &s, &p, right).ok())
            .ok_or_else(|| {
                err(
                    StatusCode::FORBIDDEN,
                    "denied",
                    "Current authority does not allow operation recovery",
                )
            })?
    } else {
        crate::auth::actor(&h, &s, &p, first)?
    };
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &p, &actor.required_right).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(lock(&actor.principal, &p, path, &id))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let row=sqlx::query("SELECT path,status,fingerprint,response_status,response_body FROM operation_records WHERE principal_id=$1 AND project_id=$2 AND namespace=$3 AND key=$4").bind(&actor.principal).bind(&p).bind(namespace(path)).bind(&id).fetch_optional(&mut *tx).await.map_err(db)?;
    let transient = if row.is_none() && !path.is_empty() && !global(path) {
        sqlx::query("SELECT path,fingerprint,response_status,response_body FROM idempotency WHERE principal_id=$1 AND project_id=$2 AND method='POST' AND path=$3 AND key=$4 AND expires_at>now()").bind(&actor.principal).bind(&p).bind(path).bind(&id).fetch_optional(&mut *tx).await.map_err(db)?
    } else {
        None
    };
    let committed = row
        .as_ref()
        .filter(|r| r.get::<String, _>("status") == "committed")
        .or(transient.as_ref());
    let actual_path = committed
        .or(row.as_ref())
        .map(|r| r.get::<String, _>("path"))
        .unwrap_or_else(|| path.into());
    if !actual_path.is_empty() || closing || row.is_some() {
        authorize(&mut tx, &s, &actor, &h, &p, &actual_path).await?;
    }
    if closing
        && row.is_none()
        && let Some(receipt) = committed
    {
        store_receipt(
            &mut tx,
            &actor.principal,
            &p,
            &actual_path,
            &id,
            &receipt.get::<Vec<u8>, _>("fingerprint"),
            (receipt.get("response_status"), receipt.get("response_body")),
        )
        .await?;
    }
    let value = if let Some(row) = committed {
        json!({"status":"committed","operationId":id,"path":actual_path,"requestFingerprint":format!("sha256:{}",hex::encode(row.get::<Vec<u8>,_>("fingerprint"))),"result":serde_json::from_slice::<Value>(&row.get::<Vec<u8>,_>("response_body")).map_err(db)?})
    } else if closing || row.is_some() {
        if closing {
            sqlx::query("INSERT INTO operation_records(principal_id,project_id,namespace,key,path,status) VALUES($1,$2,$3,$4,$5,'closed') ON CONFLICT DO NOTHING").bind(&actor.principal).bind(&p).bind(namespace(path)).bind(&id).bind(path).execute(&mut *tx).await.map_err(db)?;
        }
        json!({"status":"closed","operationId":id})
    } else {
        json!({"status":"not_observed","operationId":id})
    };
    tx.commit().await.map_err(db)?;
    Ok(Json(value))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guided_targets_and_retained_evaluator_routes_have_one_closed_grammar() {
        for project in [
            "",
            ".",
            "..",
            "has/slash",
            "has%2Fslash",
            "δ",
            &"p".repeat(129),
        ] {
            assert!(!guided_project(project));
        }
        assert!(guided_project("existing_project-1.2"));
        let bundle = "abcdefab-cdef-4abc-8def-abcdefabcdef";
        let request = "12345678-1234-4234-8234-123456789abc";
        assert!(guided_uuid(bundle));
        assert!(!guided_uuid(&bundle.to_uppercase()));
        for suffix in [
            format!("bundles/{bundle}/comparisons"),
            format!("bundles/{bundle}/evaluation-requests"),
            format!("bundles/{bundle}/evaluation-requests/{request}/start"),
            format!("bundles/{bundle}/evaluation-requests/{request}/finish"),
            format!("bundles/{bundle}/evaluation-requests/{request}/interrupt"),
        ] {
            let route = format!("/v1/projects/p/{suffix}");
            assert!(guided_evaluator_route("p", &route));
            assert_eq!(rights("p", &route), Some(["write"].as_slice()));
            assert_eq!(namespace(&route), route);
            assert!(!guided_evaluator_route(
                "p",
                &route.replace(bundle, &bundle.to_uppercase())
            ));
        }
    }
    #[test]
    fn version_receipts_keep_authoring_uuid_syntax_and_route_namespace() {
        for bundle in [
            "abcdefab-1111-4111-8111-111111111111",
            "ABCDEFAB-1111-4111-8111-111111111111",
        ] {
            let route = format!("/v1/projects/p/bundles/{bundle}/versions");
            assert_eq!(rights("p", &route), Some(["write"].as_slice()));
            assert_eq!(namespace(&route), route);
            // This authoring extension does not broaden the evaluator promise.
            assert!(!guided_evaluator_route("p", &route));
            assert!(rights("other", &route).is_none());
        }
        assert!(rights("p", "/v1/projects/p/bundles/not-a-uuid/versions").is_none());
        assert!(
            rights(
                "p",
                "/v1/projects/p/bundles/abcdefab111141118111111111111111/versions"
            )
            .is_none()
        );
    }
    #[test]
    fn namespaces_and_action_rights_remain_compatible() {
        assert_eq!(
            lock("u", "p", "/v1/projects/p/bundle-setups", "k"),
            "content:u:p:k"
        );
        assert_eq!(
            lock(
                "u",
                "p",
                "/v1/projects/p/bundles/11111111-1111-4111-8111-111111111111/channels/c/drafts",
                "k"
            ),
            "content:u:p:k"
        );
        assert_ne!(
            lock(
                "u",
                "p",
                "/v1/projects/p/bundles/11111111-1111-4111-8111-111111111111/proposals",
                "k"
            ),
            lock(
                "u",
                "p",
                "/v1/projects/p/bundles/11111111-1111-4111-8111-111111111111/evaluation-requests",
                "k"
            )
        );
        assert_eq!(
            rights("p", "/v1/projects/p/bundle-setups"),
            Some(["write", "promote"].as_slice())
        );
        assert_eq!(
            rights(
                "p",
                "/v1/projects/p/bundles/11111111-1111-4111-8111-111111111111/channels/c/drafts/22222222-2222-4222-8222-222222222222/publish"
            ),
            Some(["promote"].as_slice())
        );
        assert!(
            rights(
                "p",
                "/v1/projects/x/bundles/11111111-1111-4111-8111-111111111111/proposals"
            )
            .is_none()
        );
        assert!(rights("p", "/v1/projects/p/credentials").is_none());
        assert!(!global(
            "/v1/projects/p/bundles/11111111-1111-4111-8111-111111111111/channels/drafts/promotions"
        ));
    }
}
