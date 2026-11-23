use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sqlx::PgPool;
use std::io::{Error, Result};

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
        let url =
            reqwest::Url::parse(endpoint).map_err(|_| Error::other("invalid provider endpoint"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::other("invalid provider endpoint"));
        }
        if secret.trim().is_empty()
            || models.is_empty()
            || models.iter().any(|model| model.trim().is_empty())
        {
            return Err(Error::other("provider requires a key and allowed models"));
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
        sqlx::query("INSERT INTO workspace_model_providers(project_id,base_url,allowed_models,encrypted_key) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET base_url=excluded.base_url,allowed_models=excluded.allowed_models,encrypted_key=excluded.encrypted_key")
        .bind(project)
        .bind(endpoint)
        .bind(models)
        .bind([nonce.as_slice(),&ciphertext].concat())
        .execute(pool)
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
