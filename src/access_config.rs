//! Immutable production identity configuration, validated before listening.
use crate::Grant;
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorIdentity {
    pub issuer: String,
    pub subject: String,
}

#[derive(Clone)]
pub struct AccessConfig {
    issuer: String,
    login_token: String,
    console_token: String,
    operators: Vec<OperatorIdentity>,
    pub mail: Option<crate::mail::MailConfig>,
}
impl AccessConfig {
    pub fn from_env(grants: &[Grant]) -> Result<Self, &'static str> {
        if std::env::var_os("ACCLIMATE_MODE").is_some()
            || std::env::var_os("CONSOLE_MODE").is_some()
        {
            return Err(
                "ACCLIMATE_MODE and CONSOLE_MODE are obsolete; configure production identity explicitly",
            );
        }
        let required = |name| {
            std::env::var(name).map_err(|_| "required production access configuration is missing")
        };
        let operators = serde_json::from_str(&required("ACCLIMATE_OPERATORS")?)
            .map_err(|_| "invalid ACCLIMATE_OPERATORS")?;
        let mut config = Self::new(
            required("ACCLIMATE_OIDC_ISSUER")?,
            required("ACCLIMATE_LOGIN_TOKEN")?,
            required("ACCLIMATE_CONSOLE_TOKEN")?,
            operators,
            grants,
        )?;
        config.mail = crate::mail::MailConfig::from_env()?;
        Ok(config)
    }
    /// Fixtures supply explicit values through the exact production validator.
    pub fn new(
        issuer: String,
        login_token: String,
        console_token: String,
        operators: Vec<OperatorIdentity>,
        grants: &[Grant],
    ) -> Result<Self, &'static str> {
        crate::auth::validate_grants(grants)?;
        let url = reqwest::Url::parse(&issuer)
            .map_err(|_| "ACCLIMATE_OIDC_ISSUER must be an absolute HTTPS issuer")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || issuer.trim() != issuer
        {
            return Err(
                "ACCLIMATE_OIDC_ISSUER must be an absolute HTTPS issuer without credentials, query or fragment",
            );
        }
        if login_token.trim().is_empty() || console_token.trim().is_empty() {
            return Err("ACCLIMATE_LOGIN_TOKEN and ACCLIMATE_CONSOLE_TOKEN are required");
        }
        if login_token == console_token
            || grants
                .iter()
                .any(|g| g.token == login_token || g.token == console_token)
        {
            return Err("login, console and machine credentials must be distinct");
        }
        let mut pairs = HashSet::new();
        if operators.is_empty()
            || operators.iter().any(|operator| {
                operator.issuer != issuer
                    || operator.subject.trim().is_empty()
                    || operator.subject.len() > 512
                    || !pairs.insert((&operator.issuer, &operator.subject))
            })
        {
            return Err(
                "operator identities must be unique nonempty exact pairs at the pinned issuer",
            );
        }
        Ok(Self {
            issuer,
            login_token,
            console_token,
            operators,
            mail: None,
        })
    }
    pub fn oidc_issuer(&self) -> &str {
        &self.issuer
    }
    pub fn login_token(&self) -> &str {
        &self.login_token
    }
    pub fn console_token(&self) -> &str {
        &self.console_token
    }
    pub fn is_operator(&self, issuer: &str, subject: &str) -> bool {
        self.operators
            .iter()
            .any(|operator| operator.issuer == issuer && operator.subject == subject)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(
        issuer: &str,
        login: &str,
        console: &str,
        operators: Vec<OperatorIdentity>,
        grants: &[Grant],
    ) -> Result<AccessConfig, &'static str> {
        AccessConfig::new(
            issuer.into(),
            login.into(),
            console.into(),
            operators,
            grants,
        )
    }
    fn operators() -> Vec<OperatorIdentity> {
        vec![OperatorIdentity {
            issuer: "https://issuer.example".into(),
            subject: "operator".into(),
        }]
    }
    #[test]
    fn production_configuration_has_no_missing_or_ambiguous_authorities() {
        assert!(
            config(
                "https://issuer.example",
                "login",
                "console",
                operators(),
                &[]
            )
            .is_ok()
        );
        for issuer in [
            "http://issuer.example",
            "https://user:secret@issuer.example",
            "https://issuer.example#fragment",
            "https://issuer.example?query",
            "",
        ] {
            assert!(config(issuer, "login", "console", operators(), &[]).is_err());
        }
        assert!(config("https://issuer.example", "", "console", operators(), &[]).is_err());
        assert!(config("https://issuer.example", "same", "same", operators(), &[]).is_err());
        assert!(config("https://issuer.example", "login", "console", vec![], &[]).is_err());
        let grant = Grant {
            token: "console".into(),
            principal_id: "app".into(),
            project_id: "p".into(),
            rights: vec!["read".into()],
        };
        assert!(
            config(
                "https://issuer.example",
                "login",
                "console",
                operators(),
                &[grant]
            )
            .is_err()
        );
        let access = config(
            "https://issuer.example",
            "login",
            "console",
            operators(),
            &[],
        )
        .unwrap();
        assert!(access.is_operator("https://issuer.example", "operator"));
        assert!(!access.is_operator("https://other.example", "operator"));
        assert!(!access.is_operator("https://issuer.example", "ordinary"));
    }
}
