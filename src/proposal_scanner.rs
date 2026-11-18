use regex::{Regex, RegexSet};
use std::sync::LazyLock;

static BLOCKED: LazyLock<Result<RegexSet, regex::Error>> = LazyLock::new(|| {
    RegexSet::new([
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
    ])
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

pub(crate) fn scan<'a>(texts: impl IntoIterator<Item = &'a str>) -> Result<bool, &'static str> {
    let blocked = BLOCKED.as_ref().map_err(|_| "Invalid scanner patterns")?;
    let context = CONTEXT.as_ref().map_err(|_| "Invalid scanner context")?;
    Ok(texts.into_iter().any(|text| {
        blocked.is_match(text)
            || context
                .captures_iter(text)
                .any(|capture| high_entropy(&capture[1]))
    }))
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
}
