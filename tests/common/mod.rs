#![allow(dead_code)]
use acclimate_service::{AccessConfig, OperatorIdentity};
use std::sync::Arc;
pub const CONSOLE_TOKEN: &str = "production-fixture-console";
pub const LOGIN_TOKEN: &str = "production-fixture-login";
pub const ISSUER: &str = "https://production-fixture.example";
pub fn database_url() -> String {
    std::env::var("ACCLIMATE_TEST_DATABASE_URL")
        .expect("run scripts/productization/rust_tests.py with an isolated PostgreSQL cluster")
}

pub fn access() -> Arc<AccessConfig> {
    Arc::new(
        AccessConfig::new(
            ISSUER.into(),
            LOGIN_TOKEN.into(),
            CONSOLE_TOKEN.into(),
            vec![OperatorIdentity {
                issuer: ISSUER.into(),
                subject: "operator".into(),
            }],
            &[],
        )
        .unwrap(),
    )
}
