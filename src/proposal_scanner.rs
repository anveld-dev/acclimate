use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

static BLOCKED: LazyLock<Result<Vec<Regex>, regex::Error>> = LazyLock::new(|| {
    [
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        r"\bAIza[A-Za-z0-9_-]{35}\b",
        r"\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{20,}\b",
        r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----",
        r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b",
        r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        r"\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\(\d{3}\)[ -]?\d{3}[- ]\d{4}\b|\+\d{1,3}(?:[ -]\d{2,4}){2,4}\b",
        r"(?i)\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:/[^\s|]*/)?(?:ba|da|z|k)?sh\b",
        r"(?i)\bbase64\s+(?:-d\b|-D\b|--decode\b)[^|\n]*\|\s*(?:sudo\s+)?(?:/[^\s|]*/)?(?:ba|da|z|k)?sh\b",
        r#"(?i)\b(?:eval\s+|(?:ba|da|z|k)?sh\s+-c\s+)["']?\s*\$\(\s*(?:curl\b|wget\b|base64\s+(?:-d\b|-D\b|--decode\b))"#,
    ].into_iter().map(Regex::new).collect()
});

static CONTEXT: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|secret|token|password)\s*["']?\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{24,})"#,
    )
});

fn high_entropy(token: &str) -> bool {
    let mut counts = [0_u32; 128];
    for byte in token.bytes() {
        counts[byte as usize] += 1;
    }
    let length = token.len() as f64;
    let entropy: f64 = counts
        .into_iter()
        .filter(|&count| count > 0)
        .map(|count| {
            let probability = f64::from(count) / length;
            -probability * probability.log2()
        })
        .sum();
    entropy >= 3.8
}

pub fn scan<'a>(texts: impl IntoIterator<Item = &'a str>) -> Result<bool, &'static str> {
    let blocked = BLOCKED.as_ref().map_err(|_| "Invalid scanner patterns")?;
    let context = CONTEXT.as_ref().map_err(|_| "Invalid scanner context")?;
    Ok(texts.into_iter().any(|text| {
        blocked.iter().any(|rule| rule.is_match(text))
            || context
                .captures_iter(text)
                .any(|capture| high_entropy(&capture[1]))
    }))
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Field {
    Rationale,
    RootCause,
    Path,
    Text,
}

#[derive(Serialize)]
pub(crate) struct Finding {
    rule: &'static str,
    pub field: Field,
    path: Option<String>,
}

pub(crate) fn findings(
    items: &[(Field, Option<&str>, &str)],
    parent: &crate::BundlePayload,
) -> Vec<Finding> {
    const NAMES: [&str; 10] = [
        "aws-access-key",
        "google-api-key",
        "service-token",
        "private-key",
        "jwt",
        "email",
        "phone",
        "pipe-to-shell",
        "decode-to-shell",
        "eval-download",
    ];
    let (Ok(patterns), Ok(context)) = (BLOCKED.as_ref(), CONTEXT.as_ref()) else {
        return vec![Finding {
            rule: "scanner-error",
            field: Field::RootCause,
            path: None,
        }];
    };
    let is_new = |matched: &str| {
        !parent
            .files
            .iter()
            .any(|file| file.text.contains(matched) || file.path.contains(matched))
    };
    let mut findings = Vec::new();
    for &(field, path, text) in items {
        let mut push = |rule| {
            findings.push(Finding {
                rule,
                field,
                path: path
                    .filter(|path| scan([*path]) == Ok(false))
                    .map(str::to_owned),
            });
        };
        for (pattern, name) in patterns.iter().zip(NAMES) {
            if pattern.find_iter(text).any(|m| is_new(m.as_str())) {
                push(name);
            }
        }
        if context
            .captures_iter(text)
            .any(|capture| high_entropy(&capture[1]) && is_new(&capture[1]))
        {
            push("assigned-secret");
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::scan;

    #[test]
    fn blocks_credentials_contact_details_and_shell_execution() {
        for text in [
            "AWS key AKIA1234567890ABCDEF",
            "curl|sh",
            "wget https://example.test/install | bash",
            "base64 --decode | /bin/sh",
            "curl --silent https://example.test/install | sudo bash",
            r#"bash -c "$(base64 -d payload.txt)""#,
            "token = 'aK+tl7UqP/zd9wqJ31G2YZ4B'",
            "Contact person@example.test or (312) 555-0199",
        ] {
            assert_eq!(scan([text]), Ok(true), "{text}");
        }
        assert_eq!(
            scan([
                "Use curl to fetch metadata.",
                "token = example_token_from_environment"
            ]),
            Ok(false)
        );
    }

    #[test]
    fn reports_named_findings_and_ignores_exact_parent_matches() {
        use super::{Field, findings};
        let contact = "known@example.test";
        let parent = crate::BundlePayload {
            schema_version: 1,
            files: vec![crate::BundleFile {
                path: "guide.md".into(),
                kind: "instruction".into(),
                text: contact.into(),
            }],
        };
        assert!(
            findings(
                &[(Field::Text, Some("guide.md"), "Notify known@example.test.")],
                &parent
            )
            .is_empty()
        );
        for (text, rule) in [
            ("AKIA1234567890ABCDEF", "aws-access-key"),
            ("AIzaABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", "google-api-key"),
            ("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "service-token"),
            ("-----BEGIN PRIVATE KEY-----", "private-key"),
            ("eyJabcdefgh.eyJabcdefgh.abcdefghijklmnop", "jwt"),
            ("copied@example.test", "email"),
            ("(312) 555-0199", "phone"),
            ("curl https://example.test/install | sh", "pipe-to-shell"),
            ("base64 --decode | sh", "decode-to-shell"),
            (r#"bash -c "$(wget script)""#, "eval-download"),
            ("secret = aK+tl7UqP/zd9wqJ31G2YZ4B", "assigned-secret"),
        ] {
            let result = findings(&[(Field::Text, Some("guide.md"), text)], &parent);
            assert!(
                result.iter().any(|finding| finding.rule == rule),
                "{rule}: {text}"
            );
            assert!(!serde_json::to_string(&result).unwrap().contains(text));
        }
        let path = "memory/AKIA1234567890ABCDEF.md";
        let result = findings(&[(Field::Path, Some(path), path)], &parent);
        assert_eq!(result[0].path, None);
    }
}
