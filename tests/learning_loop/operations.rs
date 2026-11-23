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
