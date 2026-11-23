//! Operator commands and startup checks around executor credentials and provider keys.
use super::*;
use acclimate_service::executor;

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn listed_executor_credentials_show_presence_and_never_a_secret() {
    let f = Fixture::new().await;
    let pool = &f.state.db;
    let (revoked, revoked_token) = executor::create_credential(pool).await.unwrap();
    executor::revoke_credential(pool, revoked).await.unwrap();
    f.announce().await;
    let listed = executor::list_credentials(pool).await.unwrap();
    assert_eq!(listed.len(), 2);
    let hashes: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM executor_credentials")
        .fetch_all(pool)
        .await
        .unwrap();
    let text = json!(listed).to_string();
    for secret in hashes.iter().chain([&f.token, &revoked_token]) {
        assert!(!text.contains(secret.as_str()));
    }
    // The fixture's own credential was created first and has polled once.
    let (active, gone) = (&listed[0], &listed[1]);
    assert_eq!(active["revoked"], false);
    assert_eq!(active["revokedAt"], Value::Null);
    assert_eq!(active["runtime"], Fixture::identity());
    assert!(active["lastSeenAt"].is_string());
    assert!(active["createdAt"].is_string());
    assert_eq!(gone["id"], json!(revoked));
    assert_eq!(gone["revoked"], true);
    assert!(gone["revokedAt"].is_string());
    assert_eq!(gone["lastSeenAt"], Value::Null);
    assert_eq!(gone["runtime"], Value::Null);
}

fn key(byte: &str) -> executor::ProviderKey {
    executor::ProviderKey::from_hex(&byte.repeat(32)).unwrap()
}

fn is_mismatch(error: std::io::Error) -> bool {
    error
        .into_inner()
        .is_some_and(|inner| inner.is::<executor::KeyMismatch>())
}

async fn check_values(pool: &sqlx::PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM provider_key_check")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn the_first_provider_key_is_recorded_and_a_different_one_refused() {
    let f = Fixture::new().await;
    let pool = &f.state.db;
    key("0a").verify_stored(pool).await.unwrap();
    key("0a").verify_stored(pool).await.unwrap();
    assert_eq!(check_values(pool).await, 1);
    assert!(is_mismatch(
        key("0b").verify_stored(pool).await.unwrap_err()
    ));
    assert_eq!(check_values(pool).await, 1);
    // A deliberate reset removes providers and the check, so the new key is recorded next.
    key("0a")
        .store(
            pool,
            &f.project,
            "https://provider.invalid/v1",
            &["task".into()],
            "private-fixture-provider-key",
        )
        .await
        .unwrap();
    assert_eq!(executor::reset_provider_keys(pool).await.unwrap(), 1);
    assert_eq!(check_values(pool).await, 0);
    key("0b").verify_stored(pool).await.unwrap();
    assert!(is_mismatch(
        key("0a").verify_stored(pool).await.unwrap_err()
    ));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn an_upgrade_records_only_a_key_that_opens_the_stored_providers() {
    let f = Fixture::new().await;
    let pool = &f.state.db;
    key("0a")
        .store(
            pool,
            &f.project,
            "https://provider.invalid/v1",
            &["task".into()],
            "private-fixture-provider-key",
        )
        .await
        .unwrap();
    assert!(is_mismatch(
        key("0b").verify_stored(pool).await.unwrap_err()
    ));
    assert_eq!(check_values(pool).await, 0);
    key("0a").verify_stored(pool).await.unwrap();
    assert_eq!(check_values(pool).await, 1);
}

fn service(url: &str, args: &[&str], key: Option<&str>) -> std::process::Output {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_acclimate-service"));
    command
        .args(args)
        .env_clear()
        .env("DATABASE_URL", url)
        .env("ACCLIMATE_AUTH", "[]")
        .env("ACCLIMATE_OIDC_ISSUER", "https://fixture.example")
        .env("ACCLIMATE_LOGIN_TOKEN", "fixture-login")
        .env("ACCLIMATE_CONSOLE_TOKEN", "fixture-console")
        .env(
            "ACCLIMATE_OPERATORS",
            r#"[{"issuer":"https://fixture.example","subject":"operator"}]"#,
        )
        .env("ACCLIMATE_INTERNAL_BIND", "127.0.0.1:0")
        .env("ACCLIMATE_BIND", "127.0.0.1:0");
    if let Some(key) = key {
        command.env("ACCLIMATE_PROVIDER_ENCRYPTION_KEY", key);
    }
    command.output().unwrap()
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]
async fn operator_commands_and_a_mismatched_key_at_startup() {
    let f = Fixture::new().await;
    let pool = &f.state.db;
    let schema: String = sqlx::query_scalar("SELECT current_schema()")
        .fetch_one(pool)
        .await
        .unwrap();
    let base = common::database_url();
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}");

    let listed = service(&url, &["--list-executor-tokens"], None);
    assert!(listed.status.success(), "{listed:?}");
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert!(!listed.to_string().contains(&f.token));

    key("0a").verify_stored(pool).await.unwrap();
    let refused = service(&url, &[], Some(&"0b".repeat(32)));
    assert_eq!(refused.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(
        stderr.contains("does not match the key the stored provider keys were encrypted with"),
        "{stderr}"
    );
    assert!(stderr.contains("--reset-provider-keys --confirm"));
    assert!(!stderr.contains(&"0b".repeat(32)));

    let unconfirmed = service(&url, &["--reset-provider-keys"], None);
    assert_eq!(unconfirmed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&unconfirmed.stderr).contains("--confirm"));
    assert_eq!(check_values(pool).await, 1);
    let reset = service(&url, &["--reset-provider-keys", "--confirm"], None);
    assert!(reset.status.success(), "{reset:?}");
    assert_eq!(
        serde_json::from_slice::<Value>(&reset.stdout).unwrap(),
        json!({"removedProviders":0})
    );
    assert_eq!(check_values(pool).await, 0);
}
