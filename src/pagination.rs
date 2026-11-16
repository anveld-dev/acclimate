//! Chronological list policy and scoped cursors. Timestamps preserve PostgreSQL microseconds.
use crate::{ApiResult, db, err};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}
impl ListQuery {
    pub(crate) fn bounds(&self) -> ApiResult<i64> {
        let n = self.limit.unwrap_or(50);
        if !(1..=100).contains(&n) {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Limit must be between 1 and 100",
            ));
        }
        Ok(n)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page<T: Serialize> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

/// Callers fetch one extra item using a validated limit; only retained items produce cursors.
pub(crate) fn page<T: Serialize>(
    mut items: Vec<T>,
    limit: i64,
    cursor: impl FnOnce(&T) -> String,
) -> Page<T> {
    let next_cursor = if items.len() > limit as usize {
        items.truncate(limit as usize);
        items.last().map(cursor)
    } else {
        None
    };
    Page { items, next_cursor }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    v: u8,
    collection: String,
    project: String,
    bundle: Uuid,
    micros: i64,
    id: Uuid,
}
fn invalid() -> crate::ApiErr {
    err(
        StatusCode::BAD_REQUEST,
        "invalid_cursor",
        "Cursor is invalid or belongs to another collection",
    )
}
pub(crate) fn encode(
    collection: &str,
    project: &str,
    bundle: Uuid,
    created_at: &str,
    id: &str,
) -> String {
    let timestamp = DateTime::parse_from_rfc3339(created_at).expect("database timestamp");
    let cursor = Cursor {
        v: 1,
        collection: collection.into(),
        project: project.into(),
        bundle,
        micros: timestamp.timestamp_micros(),
        id: Uuid::parse_str(id).expect("database ID"),
    };
    format!(
        "v1.{}",
        hex::encode(serde_json::to_vec(&cursor).expect("cursor serialization"))
    )
}
pub(crate) async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    collection: &str,
    project: &str,
    bundle: Uuid,
    value: Option<&str>,
) -> ApiResult<Option<(DateTime<Utc>, Uuid)>> {
    let Some(value) = value else { return Ok(None) };
    if let Ok(id) = Uuid::parse_str(value) {
        // Legacy UUID cursors resolve only inside the selected collection and scope.
        let query = match collection {
            "evaluation_requests" => {
                "SELECT created_at,id FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3"
            }
            "proposals" => {
                "SELECT created_at,id FROM proposals WHERE project_id=$1 AND bundle_id=$2 AND id=$3"
            }
            "comparisons" => {
                "SELECT created_at,id FROM comparisons WHERE project_id=$1 AND bundle_id=$2 AND id=$3"
            }
            _ => return Err(invalid()),
        };
        return sqlx::query_as(query)
            .bind(project)
            .bind(bundle)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?
            .map(Some)
            .ok_or_else(invalid);
    }
    if value.len() > 4096 {
        return Err(invalid());
    }
    let bytes =
        hex::decode(value.strip_prefix("v1.").ok_or_else(invalid)?).map_err(|_| invalid())?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.v != 1
        || cursor.collection != collection
        || cursor.project != project
        || cursor.bundle != bundle
    {
        return Err(invalid());
    }
    Ok(Some((
        DateTime::from_timestamp_micros(cursor.micros).ok_or_else(invalid)?,
        cursor.id,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoded_cursor_preserves_microseconds_and_scope() {
        let bundle = Uuid::new_v4();
        let id = Uuid::new_v4();
        let encoded = encode(
            "comparisons",
            "project",
            bundle,
            "2026-11-14T12:13:14.123456+00:00",
            &id.to_string(),
        );
        let c: Cursor =
            serde_json::from_slice(&hex::decode(encoded.strip_prefix("v1.").unwrap()).unwrap())
                .unwrap();
        assert_eq!(c.micros % 1_000_000, 123456);
        assert_eq!(
            (c.collection.as_str(), c.project.as_str(), c.bundle, c.id),
            ("comparisons", "project", bundle, id)
        );
    }
}
