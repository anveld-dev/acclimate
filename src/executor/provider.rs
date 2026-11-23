use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sqlx::{PgPool, Postgres, Transaction};
use std::io::ErrorKind;
use std::io::{Error, Result};
use std::net::IpAddr;

pub struct ProviderKey(aead::LessSafeKey);
impl ProviderKey {
    pub fn from_hex(value: &str) -> Result<Self> {
        let bytes =
            hex::decode(value).map_err(|_| Error::other("invalid provider encryption key"))?;
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes)
            .map_err(|_| Error::other("provider encryption key must be 32 bytes"))?;
        Ok(Self(aead::LessSafeKey::new(key)))
    }

    pub async fn store(
        &self,
        pool: &PgPool,
        project: &str,
        endpoint: &str,
        models: &[String],
        secret: &str,
    ) -> Result<()> {
        let mut tx = pool.begin().await.map_err(Error::other)?;
        self.store_in(&mut tx, project, endpoint, models, secret)
            .await?;
        tx.commit().await.map_err(Error::other)
    }

    pub(crate) async fn store_in(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project: &str,
        endpoint: &str,
        models: &[String],
        secret: &str,
    ) -> Result<()> {
        validate_endpoint(
            endpoint,
            &std::env::var("ACCLIMATE_PROVIDER_HTTP_HOSTS").unwrap_or_default(),
        )?;
        if secret.trim().is_empty()
            || models.is_empty()
            || models
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != models.len()
            || models.iter().any(|model| model.trim().is_empty())
        {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "provider requires a key and distinct allowed models",
            ));
        }
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| Error::other("nonce generation failed"))?;
        let mut ciphertext = secret.as_bytes().to_vec();
        self.0
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(format!("{project}\n{endpoint}").as_bytes()),
                &mut ciphertext,
            )
            .map_err(|_| Error::other("encryption failed"))?;
        sqlx::query("INSERT INTO workspace_model_providers(project_id,base_url,allowed_models,encrypted_key) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET base_url=excluded.base_url,allowed_models=excluded.allowed_models,encrypted_key=excluded.encrypted_key,verification=DEFAULT,probe_attempts=0,probe_id=NULL,probe_token=NULL,probe_owner=NULL,probe_expires=NULL")
        .bind(project)
        .bind(endpoint)
        .bind(models)
        .bind([nonce.as_slice(),&ciphertext].concat())
        .execute(&mut **tx)
        .await
        .map_err(|_|Error::other("provider update failed"))?;
        Ok(())
    }

    pub(super) fn open(&self, project: &str, endpoint: &str, bytes: &mut [u8]) -> Option<String> {
        let (nonce, body) = bytes.split_at_mut_checked(12)?;
        let clear = self
            .0
            .open_in_place(
                aead::Nonce::try_assume_unique_for_key(nonce).ok()?,
                aead::Aad::from(format!("{project}\n{endpoint}").as_bytes()),
                body,
            )
            .ok()?;
        Some(std::str::from_utf8(clear).ok()?.to_owned())
    }
}

fn validate_endpoint(endpoint: &str, allowlist: &str) -> Result<()> {
    let invalid = || Error::new(ErrorKind::InvalidInput, "invalid provider endpoint");
    let url = reqwest::Url::parse(endpoint).map_err(|_| invalid())?;
    let host = url
        .host_str()
        .ok_or_else(invalid)?
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    let allowed = allowlist
        .split(',')
        .any(|name| name.trim().eq_ignore_ascii_case(host));
    if !(url.scheme() == "https" || url.scheme() == "http" && allowed)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let ip = host.parse::<IpAddr>().ok().map(|ip| ip.to_canonical());
    if matches!(ip,Some(IpAddr::V4(v)) if v.is_link_local() || matches!(v.octets(),[100,100,100,200]|[168,63,129,16]))
        || matches!(ip,Some(IpAddr::V6(v)) if v.is_unicast_link_local() || v.to_string()=="fd00:ec2::254")
        || matches!(host, "metadata.google.internal" | "metadata.goog")
        || ip.is_some_and(|v| v.is_unspecified() || !allowed && v.is_loopback())
        || !allowed && (host == "localhost" || host.ends_with(".localhost"))
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_addresses() {
        for url in [
            "http://example.org",
            "https://localhost",
            "https://[::ffff:127.0.0.1]",
            "https://169.254.169.254",
            "https://[fd00:ec2::254]",
            "https://100.100.100.200",
        ] {
            assert!(validate_endpoint(url, "169.254.169.254").is_err(), "{url}");
        }
        assert!(validate_endpoint("http://cliproxy:8317/v1", "cliproxy").is_ok());
    }
}
