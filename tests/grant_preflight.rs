use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

const CANARY: &str = "DO_NOT_PRINT_TOKEN_OR_CONFIGURATION_7c98f1";

fn check(args: &[&str], input: &[u8]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_acclimate-service"));
    let mut child = command
        .args(args)
        .env_clear()
        // A check-only command must not parse even runtime/production settings.
        .env("TOKIO_WORKER_THREADS", CANARY)
        .env("DATABASE_URL", CANARY)
        .env("ACCLIMATE_AUTH", CANARY)
        .env("ACCLIMATE_OIDC_ISSUER", CANARY)
        .env("ACCLIMATE_PROPOSER_TOKEN", CANARY)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(mut stdin) = child.stdin.take() {
        // Oversized/unknown-command checks may close their input deliberately.
        let _ = stdin.write_all(input);
    }
    child.wait_with_output().unwrap()
}

fn assert_private(output: &Output) {
    let public = [output.stdout.as_slice(), output.stderr.as_slice()].concat();
    let public = String::from_utf8_lossy(&public);
    assert!(!public.contains(CANARY), "operator input was reflected");
    assert!(public.len() <= 128, "check output is not fixed/bounded");
}

#[test]
fn grants_check_uses_explicit_stdin_and_needs_no_service_or_runtime_configuration() {
    for input in [
        "[]".to_owned(),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"{CANARY}","workspaceId":"{CANARY}","rights":["read","write"]}}]"#
        ),
        format!(
            r#"[{{"token":"old-{CANARY}","principalId":"same-worker","workspaceId":"project","rights":["read","write"]}},{{"token":"replacement-{CANARY}","principalId":"same-worker","workspaceId":"project","rights":["read","write"]}}]"#
        ),
    ] {
        let output = check(&["--check-grants"], input.as_bytes());
        assert_eq!(output.status.code(), Some(0));
        assert_eq!(output.stdout, b"{\"schemaVersion\":1,\"valid\":true}\n");
        assert!(output.stderr.is_empty());
        assert_private(&output);
    }
}

#[test]
fn grants_check_rejects_malformed_unknown_duplicate_and_invalid_input_without_echo() {
    let grant = format!(
        r#"{{"token":"{CANARY}","principalId":"worker","workspaceId":"project","rights":["read","write"]}}"#
    );
    for input in [
        String::new(),
        CANARY.into(),
        format!("[\"{CANARY}\"]"),
        format!(r#"[["{CANARY}","worker","project",["read"]]]"#),
        format!("[{grant},{grant}]"),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"worker","workspaceId":"project","rights":["read","propose"]}}]"#
        ),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"worker","workspaceId":"project","rights":["{CANARY}"]}}]"#
        ),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"worker","workspaceId":"project","rights":["read","read"]}}]"#
        ),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"worker","workspaceId":"project","rights":["read"],"{CANARY}":"secret"}}]"#
        ),
        format!(
            r#"[{{"token":"{CANARY}","token":"replacement","principalId":"worker","workspaceId":"project","rights":["read"]}}]"#
        ),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"","workspaceId":"project","rights":["read"]}}]"#
        ),
        format!(
            r#"[{{"token":"{CANARY}","principalId":"worker","workspaceId":"project","rights":["read"]}},{{"token":"{CANARY}","principalId":"other","workspaceId":"other","rights":["read"]}}]"#
        ),
    ] {
        let output = check(&["--check-grants"], input.as_bytes());
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(
            output.stderr,
            b"{\"schemaVersion\":1,\"valid\":false,\"code\":\"grants.invalid\"}\n"
        );
        assert_private(&output);
    }
    let invalid_utf8 = check(&["--check-grants"], &[0xff, 0xfe]);
    assert_eq!(invalid_utf8.status.code(), Some(1));
    assert_private(&invalid_utf8);
    let oversized = check(&["--check-grants"], &vec![b' '; 1024 * 1024 + 1]);
    assert_eq!(oversized.status.code(), Some(1));
    assert_private(&oversized);
}

#[test]
fn unknown_check_arguments_fail_before_reading_or_runtime_configuration() {
    for args in [
        vec!["--check-grants", CANARY],
        vec![CANARY],
        vec!["--check-grants-file", CANARY],
    ] {
        let output = check(&args, b"[]");
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(
            output.stderr,
            b"{\"schemaVersion\":1,\"valid\":false,\"code\":\"command.invalid\"}\n"
        );
        assert_private(&output);
    }
}
