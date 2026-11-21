use std::{
    net::TcpListener,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn service(bind: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_acclimate-service"));
    command
        .env_clear()
        .env("DATABASE_URL", "postgresql://fixture@127.0.0.1:1/fixture")
        .env("ACCLIMATE_AUTH", "[]")
        .env("ACCLIMATE_OIDC_ISSUER", "https://fixture.example")
        .env("ACCLIMATE_LOGIN_TOKEN", "fixture-login")
        .env("ACCLIMATE_CONSOLE_TOKEN", "fixture-console")
        .env(
            "ACCLIMATE_OPERATORS",
            r#"[{"issuer":"https://fixture.example","subject":"operator"}]"#,
        )
        .env("ACCLIMATE_BIND", bind)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}
#[test]
fn mandatory_production_configuration_fails_before_listening() {
    for name in [
        "DATABASE_URL",
        "ACCLIMATE_AUTH",
        "ACCLIMATE_OIDC_ISSUER",
        "ACCLIMATE_LOGIN_TOKEN",
        "ACCLIMATE_CONSOLE_TOKEN",
        "ACCLIMATE_OPERATORS",
    ] {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);
        let started = Instant::now();
        let output = service(&address.to_string())
            .env_remove(name)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{name}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{name}: attempted database connection before configuration validation"
        );
        assert!(
            std::net::TcpStream::connect(address).is_err(),
            "{name}: listened without configuration"
        );
    }
}
#[test]
fn legacy_modes_and_implicit_databases_are_rejected_before_connecting() {
    for (name, value) in [
        ("ACCLIMATE_MODE", "local"),
        ("ACCLIMATE_MODE", "hosted"),
        ("CONSOLE_MODE", "local"),
        ("DATABASE_URL", "sqlite:local.db"),
        ("DATABASE_URL", "postgresql://localhost"),
        ("DATABASE_URL", "postgresql://fixture@localhost"),
        ("DATABASE_URL", "postgresql://fixture@localhost///"),
        (
            "DATABASE_URL",
            "postgresql://fixture@localhost/fixture?dbname=",
        ),
        (
            "DATABASE_URL",
            "postgresql://fixture@localhost/fixture?user=",
        ),
        (
            "DATABASE_URL",
            "postgresql://fixture@localhost/fixture?host=",
        ),
        ("DATABASE_URL", "postgresql://localhost/fixture"),
        ("DATABASE_URL", "host=localhost dbname=postgres"),
        ("ACCLIMATE_BIND", "invalid"),
    ] {
        let output = service("127.0.0.1:0").env(name, value).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{name}");
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            !error.contains("Connection refused"),
            "{name}: config was not validated first"
        );
    }
}

#[test]
fn removed_settings_fail_preflight_by_name() {
    for name in [
        "ACCLIMATE_CRITIC_MODEL",
        "ACCLIMATE_CRITIC_ENDPOINT",
        "ACCLIMATE_CRITIC_TOKEN",
        "ACCLIMATE_LEARNING_REVIEW_SECONDS",
        "ACCLIMATE_LEARNING_PARENT_MAX_REUSES",
        "ACCLIMATE_LEARNING_PARENT_MAX_AGE_SECONDS",
        "ACCLIMATE_LEARNING_PAIR_BUDGET",
        "ACCLIMATE_LEARNING_MAX_REPETITIONS",
        "ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS",
        "ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS",
        "ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS",
        "ACCLIMATE_LEARNING_CALIBRATION_ATTEMPTS",
        "ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS",
        "ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES",
        "ACCLIMATE_EVALUATION_ABANDON_SECONDS",
    ] {
        let output = service("127.0.0.1:0").env(name, "").output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{name}");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(name) && error.contains("removed"), "{error}");
    }
}
