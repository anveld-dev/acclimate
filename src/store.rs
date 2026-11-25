use crate::{ApiResult, VersionMetadata, db, err};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;
pub(crate) fn meta(row: &sqlx::postgres::PgRow) -> VersionMetadata {
    VersionMetadata {
        id: row.get::<Uuid, _>("id").to_string(),
        bundle_id: row.get::<Uuid, _>("bundle_id").to_string(),
        parent_version_id: row
            .get::<Option<Uuid>, _>("parent_version_id")
            .map(|x| x.to_string()),
        digest: row.get("digest"),
        created_at: row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
    }
}
pub(crate) async fn version_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: &str,
    b: Uuid,
    v: Uuid,
) -> ApiResult<sqlx::postgres::PgRow> {
    sqlx::query("SELECT id,bundle_id,parent_version_id,digest,created_at FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=$3").bind(p).bind(b).bind(v).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Version not found"))
}
