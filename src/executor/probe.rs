use super::*;

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ModelResult {
    model: String,
    ok: bool,
    usage: bool,
    message: Option<String>,
}

pub(super) async fn claim(
    tx: &mut Tx<'_>,
    owner: Uuid,
    key: Option<&ProviderKey>,
) -> ApiResult<Option<Value>> {
    loop {
        let row=sqlx::query("SELECT project_id,base_url,encrypted_key,allowed_models,probe_attempts FROM workspace_model_providers WHERE verification->>'status'='pending' AND (probe_expires IS NULL OR probe_expires<=now()) ORDER BY project_id LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(&mut **tx).await.map_err(db)?;
        let Some(row) = row else { return Ok(None) };
        let project: String = row.get("project_id");
        let endpoint: String = row.get("base_url");
        let models: Vec<String> = row.get("allowed_models");
        let secret_key = key.and_then(|k| {
            k.open(
                &project,
                &endpoint,
                &mut row.get::<Vec<u8>, _>("encrypted_key"),
            )
        });
        if secret_key.is_none() {
            unusable_key(&project, key.is_some());
        }
        if secret_key.is_none() || row.get::<i16, _>("probe_attempts") >= 2 {
            let message = if secret_key.is_none() {
                "Provider key unavailable"
            } else {
                "Probe timed out"
            };
            let results: Vec<_> = models
                .iter()
                .map(|m| json!({"model":m,"ok":false,"usage":false,"message":message}))
                .collect();
            sqlx::query("UPDATE workspace_model_providers SET verification=jsonb_build_object('status','failed','checkedAt',now(),'models',$2::jsonb),probe_token=NULL WHERE project_id=$1").bind(project).bind(json!(results)).execute(&mut **tx).await.map_err(db)?;
            continue;
        }
        let id = Uuid::new_v4();
        let bearer = secret();
        let expires:DateTime<Utc>=sqlx::query_scalar("UPDATE workspace_model_providers SET probe_id=$2,probe_token=$3,probe_owner=$4,probe_expires=now()+interval '45 seconds',probe_attempts=probe_attempts+1 WHERE project_id=$1 RETURNING probe_expires").bind(&project).bind(id).bind(digest(bearer.as_bytes())).bind(owner).fetch_one(&mut **tx).await.map_err(db)?;
        audit(tx, &project, owner, id, "/internal/executor/leases").await?;
        return Ok(Some(
            json!({"kind":"probe","leaseId":id,"leaseToken":bearer,"expiresAt":expires,"heartbeatSeconds":15,"models":models,"provider":{"baseUrl":endpoint,"apiKey":secret_key}}),
        ));
    }
}

pub(super) async fn finish(
    tx: &mut Tx<'_>,
    id: Uuid,
    hash: &str,
    models: Vec<ModelResult>,
) -> ApiResult<()> {
    let (project,owner,allowed):(String,Uuid,Vec<String>)=sqlx::query_as("SELECT project_id,probe_owner,allowed_models FROM workspace_model_providers WHERE probe_id=$1 AND probe_token=$2 AND probe_expires>now() AND EXISTS(SELECT FROM executor_credentials WHERE id=probe_owner AND revoked_at IS NULL) FOR UPDATE").bind(id).bind(hash).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(conflict)?;
    if models.len() != allowed.len()
        || !allowed.iter().all(|m| models.iter().any(|r| &r.model == m))
    {
        return Err(invalid());
    }
    let status = if models.iter().all(|r| r.ok && r.usage) {
        "verified"
    } else {
        "failed"
    };
    sqlx::query("UPDATE workspace_model_providers SET verification=jsonb_build_object('status',$2::text,'models',$3::jsonb,'checkedAt',now()),probe_token=NULL WHERE project_id=$1").bind(&project).bind(status).bind(json!(models)).execute(&mut **tx).await.map_err(db)?;
    audit(tx, &project, owner, id, "/internal/executor/leases/result").await
}
