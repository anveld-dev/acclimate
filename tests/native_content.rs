use acclimate_service::{BundlePayload, compatibility};
#[test]
fn shared_native_compatibility_fixtures() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../contracts/fixtures/native-compatibility.json"
    ))
    .unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let payload: BundlePayload =
            serde_json::from_value(serde_json::json!({"schemaVersion":1,"files":fixture["files"]}))
                .unwrap();
        let issues = compatibility::validate(&payload, fixture["target"].as_str().unwrap())
            .err()
            .unwrap_or_default();
        assert_eq!(
            serde_json::json!(issues.iter().map(|i| &i.code).collect::<Vec<_>>()),
            fixture["codes"],
            "{}",
            fixture["name"]
        );
        assert!(issues.iter().all(|i| !i.message.contains("Body")));
    }
}
