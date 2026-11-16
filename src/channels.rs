pub fn valid_channel(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 64
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

use crate::{
    ApiResult, AppState, ChannelResolution, ComparisonRequest, PromoteRequest, Promotion,
    PromotionPage, db, err, path,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;
pub(crate) async fn resolve(
    State(s): State<AppState>,
    Path((p, b, c)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let mut tx = crate::integrations::content_transaction(&s, &h, &p, &b, Some(&c), None).await?;
    if !valid_channel(&c) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid channel",
        ));
    }
    let r=sqlx::query("SELECT c.revision,v.id,v.bundle_id,v.parent_version_id,v.digest,v.created_at FROM channels c JOIN versions v ON v.id=c.version_id AND v.project_id=c.project_id AND v.bundle_id=c.bundle_id WHERE c.project_id=$1 AND c.bundle_id=$2 AND c.name=$3").bind(&p).bind(path(&b)?).bind(&c).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Channel not found"))?;
    let rev: i64 = r.get("revision");
    let etag = format!("\"{rev}\"");
    if h.get(header::IF_NONE_MATCH).and_then(|x| x.to_str().ok()) == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let out = ChannelResolution {
        channel: c,
        revision: rev.to_string(),
        version: crate::store::meta(&r),
    };
    Ok((StatusCode::OK, [(header::ETAG, etag)], Json(out)).into_response())
}
pub(crate) async fn list_promotions(
    State(s): State<AppState>,
    Path((p, b, c)): Path<(String, String, String)>,
    h: HeaderMap,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<PromotionPage>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    if !valid_channel(&c) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid channel",
        ));
    }
    let invalid = || {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid history query",
        )
    };
    let mut limit = None;
    let mut before = None;
    if let Some(query) = query {
        let url =
            reqwest::Url::parse(&format!("http://localhost/?{query}")).map_err(|_| invalid())?;
        for (key, value) in url.query_pairs() {
            let value = value.as_ref();
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            let number: i64 = value.parse().map_err(|_| invalid())?;
            match key.as_ref() {
                "limit" if limit.is_none() && (1..=100).contains(&number) => limit = Some(number),
                "beforeRevision" if before.is_none() && number > 0 && !value.starts_with('0') => {
                    before = Some(number)
                }
                _ => return Err(invalid()),
            }
        }
    }
    let bid = path(&b)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM channels WHERE project_id=$1 AND bundle_id=$2 AND name=$3)",
    )
    .bind(&p)
    .bind(bid)
    .bind(&c)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "Channel not found"));
    }
    let limit = limit.unwrap_or(20);
    let rows = sqlx::query("SELECT p.id AS promotion_id,p.channel,p.revision,p.previous_version_id,p.comparison_id,p.unevaluated_reason,p.reviewer,p.created_at AS promotion_created,v.id,v.bundle_id,v.parent_version_id,v.digest,v.created_at FROM promotions p JOIN versions v ON v.id=p.version_id AND v.project_id=p.project_id AND v.bundle_id=p.bundle_id WHERE p.project_id=$1 AND p.bundle_id=$2 AND p.channel=$3 AND ($4::bigint IS NULL OR p.revision<$4) ORDER BY p.revision DESC LIMIT $5")
        .bind(&p).bind(bid).bind(&c).bind(before).bind(limit + 1).fetch_all(&mut *tx).await.map_err(db)?;
    let has_more = rows.len() > limit as usize;
    let items: Vec<Promotion> = rows
        .iter()
        .take(limit as usize)
        .map(|r| Promotion {
            id: r.get::<Uuid, _>("promotion_id").to_string(),
            channel: r.get("channel"),
            revision: r.get::<i64, _>("revision").to_string(),
            version: crate::store::meta(r),
            previous_version_id: r
                .get::<Option<Uuid>, _>("previous_version_id")
                .map(|x| x.to_string()),
            comparison_id: r
                .get::<Option<Uuid>, _>("comparison_id")
                .map(|x| x.to_string()),
            unevaluated_reason: r.get("unevaluated_reason"),
            reviewer: r.get("reviewer"),
            created_at: r.get::<DateTime<Utc>, _>("promotion_created").to_rfc3339(),
        })
        .collect();
    let next_before_revision = if has_more {
        items.last().map(|item| item.revision.clone())
    } else {
        None
    };
    Ok(Json(PromotionPage {
        items,
        next_before_revision,
    }))
}
pub(crate) async fn promote(
    State(s): State<AppState>,
    Path((p, b, c)): Path<(String, String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "promote")?;
    let req: PromoteRequest = serde_json::from_slice(&body).map_err(|_| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Malformed request",
        )
    })?;
    let route = format!("/v1/projects/{p}/bundles/{b}/channels/{c}/promotions");
    let (mut command, replay) =
        crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await?;
    if let Some(r) = replay {
        return Ok(r);
    }
    let promotion = promote_in_tx(&mut command.tx, &p, path(&b)?, &c, &a.principal, req).await?;
    crate::commands::finish_mutation(command, StatusCode::CREATED, promotion).await
}
pub(crate) async fn promote_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: &str,
    bid: Uuid,
    c: &str,
    principal: &str,
    req: PromoteRequest,
) -> ApiResult<Promotion> {
    if !valid_channel(c) || req.comparison_id.is_some() == req.unevaluated_reason.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Specify comparisonId or unevaluatedReason",
        ));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("promotion:{p}:{bid}:{c}"))
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    let vid = path(&req.version_id)?;
    let current=sqlx::query("SELECT revision,version_id FROM channels WHERE project_id=$1 AND bundle_id=$2 AND name=$3 FOR UPDATE").bind(p).bind(bid).bind(c).fetch_optional(&mut **tx).await.map_err(db)?;
    let (revision, previous) = current
        .map(|r| {
            (
                r.get::<i64, _>("revision"),
                Some(r.get::<Uuid, _>("version_id")),
            )
        })
        .unwrap_or((0, None));
    if revision.to_string() != req.expected_revision {
        return Err(err(
            StatusCode::CONFLICT,
            "revision_conflict",
            "Channel revision changed",
        ));
    }
    let vr=sqlx::query("SELECT id,bundle_id,parent_version_id,digest,payload,created_at FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=$3").bind(p).bind(bid).bind(vid).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Version not found"))?;
    let payload: crate::BundlePayload =
        serde_json::from_slice(&vr.get::<Vec<u8>, _>("payload")).map_err(db)?;
    crate::compatibility::validate_in_tx(tx, p, bid, &payload).await?;
    if let Some(cid) = req.comparison_id.as_deref() {
        let cr = sqlx::query(
            "SELECT body,complete FROM comparisons WHERE project_id=$1 AND bundle_id=$2 AND id=$3",
        )
        .bind(p)
        .bind(bid)
        .bind(path(cid)?)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Comparison not found"))?;
        let cmp: ComparisonRequest = serde_json::from_value(cr.get("body")).map_err(db)?;
        if !cr.get::<bool, _>("complete")
            || cmp.candidate_version_id != vid.to_string()
            || cmp.parent_version_id
                != vr
                    .get::<Option<Uuid>, _>("parent_version_id")
                    .map(|x| x.to_string())
                    .unwrap_or_default()
            || previous.map(|x| x.to_string()) != Some(cmp.parent_version_id.clone())
        {
            return Err(err(
                StatusCode::CONFLICT,
                "parent_conflict",
                "Evidence does not match current parent and target",
            ));
        }
        let dig = sqlx::query(
            "SELECT digest FROM versions WHERE id=$1 AND project_id=$2 AND bundle_id=$3",
        )
        .bind(path(&cmp.parent_version_id)?)
        .bind(p)
        .bind(bid)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?
        .get::<String, _>("digest");
        if cmp.candidate_digest != vr.get::<String, _>("digest") || cmp.parent_digest != dig {
            return Err(err(
                StatusCode::CONFLICT,
                "parent_conflict",
                "Evidence digests do not match versions",
            ));
        }
    } else if req
        .unevaluated_reason
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Unevaluated reason required",
        ));
    }
    let nr = revision + 1;
    sqlx::query("INSERT INTO channels(project_id,bundle_id,name,revision,version_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,bundle_id,name) DO UPDATE SET revision=EXCLUDED.revision,version_id=EXCLUDED.version_id").bind(p).bind(bid).bind(c).bind(nr).bind(vid).execute(&mut **tx).await.map_err(db)?;
    let id = Uuid::new_v4();
    let row = sqlx::query("INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,previous_version_id,comparison_id,unevaluated_reason,reviewer) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at").bind(id).bind(p).bind(bid).bind(c).bind(nr).bind(vid).bind(previous).bind(req.comparison_id.as_deref().map(path).transpose()?).bind(&req.unevaluated_reason).bind(principal).fetch_one(&mut **tx).await.map_err(db)?;
    let when = row.get::<DateTime<Utc>, _>("created_at").to_rfc3339();
    Ok(Promotion {
        id: id.to_string(),
        channel: c.into(),
        revision: nr.to_string(),
        version: crate::store::meta(&vr),
        previous_version_id: previous.map(|x| x.to_string()),
        comparison_id: req.comparison_id,
        unevaluated_reason: req.unevaluated_reason,
        reviewer: principal.into(),
        created_at: when,
    })
}
