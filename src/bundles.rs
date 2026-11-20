use crate::BundlePayload;
use std::collections::HashSet;

pub fn validate_payload(p: &BundlePayload) -> Result<(), String> {
    if p.schema_version != 1 || p.files.is_empty() || p.files.len() > 128 {
        return Err("Invalid payload schema or file count".into());
    }
    let mut paths = HashSet::new();
    let mut total = 0usize;
    for f in &p.files {
        let path = &f.path;
        if path.len() > 240
            || path.is_empty()
            || !path.is_ascii()
            || path.split('/').any(|seg| {
                seg.is_empty()
                    || seg == "."
                    || seg == ".."
                    || !seg
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    || {
                        let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
                        matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                            || ["COM", "LPT"].iter().any(|p| {
                                stem.strip_prefix(p)
                                    .and_then(|x| x.parse::<u8>().ok())
                                    .is_some_and(|x| (1..=9).contains(&x))
                            })
                    }
            })
        {
            return Err("Unsafe payload path".into());
        }
        if !matches!(f.kind.as_str(), "instruction" | "skill" | "memory") {
            return Err("Unsupported file kind".into());
        }
        if f.text.len() > 262144 {
            return Err("File text exceeds 256KiB".into());
        }
        total += f.text.len();
        let lower = path.to_ascii_lowercase();
        if !paths.insert(lower) {
            return Err("Duplicate or case-colliding path".into());
        }
    }
    for a in &paths {
        if paths
            .iter()
            .any(|b| b.len() > a.len() && b.starts_with(&format!("{a}/")))
        {
            return Err("File and directory path collision".into());
        }
    }
    if total > 1_048_576 {
        return Err("Payload exceeds 1MiB".into());
    }
    Ok(())
}

use crate::{ApiResult, AppState, Bundle, CreateVersionRequest, VersionMetadata, db, path};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;
pub(crate) async fn create_bundle(
    State(s): State<AppState>,
    Path(project): Path<String>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &project, "write")?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NewBundle {
        name: String,
        #[serde(default = "crate::compatibility::default_target")]
        compatibility_target: String,
    }
    let req = serde_json::from_slice::<NewBundle>(&body).map_err(|_| {
        crate::err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Expected {name}",
        )
    })?;
    let name = req.name;
    if !crate::compatibility::valid_target(&req.compatibility_target) {
        return Err(crate::err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Unknown compatibility target",
        ));
    }
    if name.trim().is_empty() || body.len() > 2 * 1024 * 1024 {
        return Err(crate::err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid name",
        ));
    }
    // Internal operation key, not a route: see commands::internal_operation_path.
    let route = format!("/v1/projects/{project}/bundles");
    let mut command =
        match crate::commands::begin_mutation(&s, &a, &project, &route, &h, &body).await? {
            crate::commands::MutationStart::Execute(command) => command,
            crate::commands::MutationStart::Replay(response) => return Ok(response),
        };
    sqlx::query("INSERT INTO projects(id,name) VALUES($1,$1) ON CONFLICT(id) DO NOTHING")
        .bind(&project)
        .execute(&mut *command.tx)
        .await
        .map_err(db)?;
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "INSERT INTO bundles(id,project_id,name,compatibility_target) VALUES($1,$2,$3,$4) RETURNING created_at",
    )
    .bind(id)
    .bind(&project)
    .bind(name.trim())
    .bind(&req.compatibility_target)
    .fetch_one(&mut *command.tx)
    .await
    .map_err(db)?;
    let x = Bundle {
        id: id.to_string(),
        name: name.trim().into(),
        compatibility_target: req.compatibility_target,
        project_id: project,
        created_at: row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
    };
    crate::commands::finish_mutation(command, StatusCode::CREATED, &x).await
}
pub(crate) async fn create_version(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &project, "write")?;
    if body.len() > 2 * 1024 * 1024 {
        return Err(crate::err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Request too large",
        ));
    }
    let bid = crate::path(&bundle)?;
    let req: CreateVersionRequest = serde_json::from_slice(&body).map_err(|_| {
        crate::err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Malformed request",
        )
    })?;
    validate_payload(&req.payload)
        .map_err(|e| crate::err(StatusCode::BAD_REQUEST, "invalid_content", e))?;
    let payload = crate::encode_payload(&req.payload)?;
    // Internal operation key, not a route: see commands::internal_operation_path.
    let route = format!("/v1/projects/{project}/bundles/{bundle}/versions");
    let mut command =
        match crate::commands::begin_mutation(&s, &a, &project, &route, &h, &body).await? {
            crate::commands::MutationStart::Execute(command) => command,
            crate::commands::MutationStart::Replay(response) => return Ok(response),
        };
    let id = Uuid::new_v4();
    let par = req.parent_version_id.as_deref().map(path).transpose()?;
    let row=sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM bundles WHERE project_id=$2 AND id=$3) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM versions WHERE project_id=$2 AND bundle_id=$3 AND id=$4)) RETURNING id,bundle_id,parent_version_id,digest,created_at").bind(id).bind(&project).bind(bid).bind(par).bind(crate::digest(&payload)).bind(payload).bind(&a.principal).fetch_optional(&mut *command.tx).await.map_err(db)?.ok_or_else(||crate::err(StatusCode::NOT_FOUND,"not_found","Bundle or parent not found"))?;
    crate::commands::finish_mutation(command, StatusCode::CREATED, crate::store::meta(&row)).await
}
pub(crate) async fn get_version(
    State(s): State<AppState>,
    Path((p, b, v)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<VersionMetadata>> {
    let mut tx =
        crate::integrations::content_transaction(&s, &h, &p, &b, None, Some(crate::path(&v)?))
            .await?;
    let r = crate::store::version_row(&mut tx, &p, crate::path(&b)?, crate::path(&v)?).await?;
    Ok(Json(crate::store::meta(&r)))
}
pub(crate) async fn get_payload(
    State(s): State<AppState>,
    Path((p, b, v)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let mut tx =
        crate::integrations::content_transaction(&s, &h, &p, &b, None, Some(crate::path(&v)?))
            .await?;
    let r =
        sqlx::query("SELECT payload FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=$3")
            .bind(p)
            .bind(crate::path(&b)?)
            .bind(crate::path(&v)?)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or_else(|| crate::err(StatusCode::NOT_FOUND, "not_found", "Version not found"))?;
    let mut resp = Response::new(axum::body::Body::from(r.get::<Vec<u8>, _>("payload")));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(resp)
}
