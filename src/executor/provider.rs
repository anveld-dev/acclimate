use acclimate_provider_address::validate_endpoint;
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sqlx::{PgPool, Postgres, Transaction};
use std::io::ErrorKind;
use std::io::{Error, Result};

const KEY_FORMAT: &str = "ACCLIMATE_PROVIDER_ENCRYPTION_KEY must be 64 hex characters. Generate one with `openssl rand -hex 32`";
/// Sealed under the key on first start, so a later start can tell a different key apart.
const CHECK_PLAINTEXT: &[u8] = b"acclimate provider key check v1";
const CHECK_AAD: &[u8] = b"acclimate-provider-key-check";

/// The configured key cannot open what is stored. Starting would fail every lease.
#[derive(Debug)]
pub struct KeyMismatch;
impl std::fmt::Display for KeyMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ACCLIMATE_PROVIDER_ENCRYPTION_KEY does not match the key the stored provider keys were encrypted with, so workspaces could not use their providers. Either restore the original key in the service environment and start again, or discard every stored workspace provider and start over with this key by running `acclimate-service --reset-provider-keys --confirm` with the service's DATABASE_URL; each workspace administrator must then enter their provider again."
        )
    }
}
impl std::error::Error for KeyMismatch {}

pub struct ProviderKey(aead::LessSafeKey);
impl ProviderKey {
    pub fn from_hex(value: &str) -> Result<Self> {
        let bytes = hex::decode(value.trim()).map_err(|_| Error::other(KEY_FORMAT))?;
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes)
            .map_err(|_| Error::other(KEY_FORMAT))?;
        Ok(Self(aead::LessSafeKey::new(key)))
    }

    fn seal(&self, aad: &[u8], clear: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| Error::other("nonce generation failed"))?;
        let mut ciphertext = clear.to_vec();
        self.0
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad),
                &mut ciphertext,
            )
            .map_err(|_| Error::other("encryption failed"))?;
        Ok([nonce.as_slice(), &ciphertext].concat())
    }

    fn unseal<'a>(&self, aad: &[u8], bytes: &'a mut [u8]) -> Option<&'a [u8]> {
        let (nonce, body) = bytes.split_at_mut_checked(12)?;
        let clear = self
            .0
            .open_in_place(
                aead::Nonce::try_assume_unique_for_key(nonce).ok()?,
                aead::Aad::from(aad),
                body,
            )
            .ok()?;
        Some(clear)
    }

    /// A new check value for this key.
    pub fn check_value(&self) -> Result<Vec<u8>> {
        self.seal(CHECK_AAD, CHECK_PLAINTEXT)
    }

    pub fn matches_check(&self, value: &[u8]) -> bool {
        self.unseal(CHECK_AAD, &mut value.to_vec()) == Some(CHECK_PLAINTEXT)
    }

    /// Check this key against the stored check value, and record one the first time a key is
    /// used. Before a check value exists, a key that opens none of the stored provider keys is
    /// refused rather than recorded. A mismatch returns [`KeyMismatch`].
    pub async fn verify_stored(&self, pool: &PgPool) -> Result<()> {
        let mut tx = pool.begin().await.map_err(Error::other)?;
        // Serializes the first record between the service and an operator command.
        sqlx::query("LOCK TABLE provider_key_check IN EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(Error::other)?;
        let stored: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT check_value FROM provider_key_check")
                .fetch_optional(&mut *tx)
                .await
                .map_err(Error::other)?;
        if let Some(stored) = stored {
            return if self.matches_check(&stored) {
                Ok(())
            } else {
                Err(Error::other(KeyMismatch))
            };
        }
        let providers: Vec<(String, String, Vec<u8>)> = sqlx::query_as(
            "SELECT project_id,base_url,encrypted_key FROM workspace_model_providers",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(Error::other)?;
        if !providers.is_empty()
            && !providers.into_iter().any(|(project, endpoint, mut bytes)| {
                self.open(&project, &endpoint, &mut bytes).is_some()
            })
        {
            return Err(Error::other(KeyMismatch));
        }
        sqlx::query("INSERT INTO provider_key_check(check_value) VALUES($1)")
            .bind(self.check_value()?)
            .execute(&mut *tx)
            .await
            .map_err(Error::other)?;
        tx.commit().await.map_err(Error::other)
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
        self.store_in(&mut tx, project, endpoint, models, Some(secret))
            .await?;
        tx.commit().await.map_err(Error::other)
    }

    pub(crate) async fn store_in(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project: &str,
        endpoint: &str,
        models: &[String],
        secret: Option<&str>,
    ) -> Result<()> {
        validate_endpoint(
            endpoint,
            &std::env::var("ACCLIMATE_PROVIDER_HTTP_HOSTS").unwrap_or_default(),
        )?;
        if secret.is_some_and(|s| s.trim().is_empty())
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
        let Some(secret) = secret else {
            let updated=sqlx::query("UPDATE workspace_model_providers SET allowed_models=$3,verification=DEFAULT,probe_attempts=0,probe_id=NULL,probe_token=NULL,probe_owner=NULL,probe_expires=NULL WHERE project_id=$1 AND base_url=$2").bind(project).bind(endpoint).bind(models).execute(&mut **tx).await.map_err(Error::other)?;
            if updated.rows_affected() == 0 {
                return Err(Error::new(
                    ErrorKind::InvalidInput,
                    "A key is required for a new provider URL",
                ));
            }
            return Ok(());
        };
        let sealed = self.seal(
            format!("{project}\n{endpoint}").as_bytes(),
            secret.as_bytes(),
        )?;
        sqlx::query("INSERT INTO workspace_model_providers(project_id,base_url,allowed_models,encrypted_key) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET base_url=excluded.base_url,allowed_models=excluded.allowed_models,encrypted_key=excluded.encrypted_key,verification=DEFAULT,probe_attempts=0,probe_id=NULL,probe_token=NULL,probe_owner=NULL,probe_expires=NULL")
        .bind(project)
        .bind(endpoint)
        .bind(models)
        .bind(sealed)
        .execute(&mut **tx)
        .await
        .map_err(|_|Error::other("provider update failed"))?;
        Ok(())
    }

    pub(super) fn open(&self, project: &str, endpoint: &str, bytes: &mut [u8]) -> Option<String> {
        let clear = self.unseal(format!("{project}\n{endpoint}").as_bytes(), bytes)?;
        Some(std::str::from_utf8(clear).ok()?.to_owned())
    }
}

/// Remove every stored workspace provider and the key check value, so the service can start with
/// a new key. Returns the number of providers removed.
pub async fn reset_provider_keys(pool: &PgPool) -> Result<u64> {
    let mut tx = pool.begin().await.map_err(Error::other)?;
    sqlx::query("LOCK TABLE provider_key_check IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await
        .map_err(Error::other)?;
    let removed = sqlx::query("DELETE FROM workspace_model_providers")
        .execute(&mut *tx)
        .await
        .map_err(Error::other)?
        .rows_affected();
    sqlx::query("DELETE FROM provider_key_check")
        .execute(&mut *tx)
        .await
        .map_err(Error::other)?;
    tx.commit().await.map_err(Error::other)?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_value_opens_only_under_its_own_key() {
        let key = ProviderKey::from_hex(&"01".repeat(32)).unwrap();
        let other = ProviderKey::from_hex(&"02".repeat(32)).unwrap();
        let value = key.check_value().unwrap();
        assert!(key.matches_check(&value));
        assert!(!other.matches_check(&value));
        // Each check value has its own nonce, and a damaged one does not match.
        assert_ne!(key.check_value().unwrap(), value);
        let mut damaged = value.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(!key.matches_check(&damaged));
        assert!(!key.matches_check(&value[..8]));
        // A provider key sealed for a workspace is not a check value.
        let provider = key
            .seal(b"p\nhttps://example.test", CHECK_PLAINTEXT)
            .unwrap();
        assert!(!key.matches_check(&provider));
        assert_eq!(
            key.open("p", "https://example.test", &mut provider.clone())
                .as_deref(),
            std::str::from_utf8(CHECK_PLAINTEXT).ok()
        );
    }

    #[test]
    fn key_errors_say_how_to_make_a_key_and_never_echo_it() {
        for bad in ["zz", &"01".repeat(31), &"0".repeat(65)] {
            let message = ProviderKey::from_hex(bad).err().unwrap().to_string();
            assert!(message.contains("64 hex characters"), "{message}");
            assert!(!message.contains(bad));
        }
        let mismatch = KeyMismatch.to_string();
        assert!(mismatch.contains("restore the original key"));
        assert!(mismatch.contains("--reset-provider-keys --confirm"));
    }
}
