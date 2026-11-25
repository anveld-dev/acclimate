//! Pure native preparation rules plus transaction-scoped immutable bundle policy lookup.
use crate::{ApiResult, BundlePayload, db, err};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

pub fn default_target() -> String {
    "generic".into()
}
pub fn valid_target(target: &str) -> bool {
    matches!(target, "generic" | "codex" | "claude" | "pi" | "cursor")
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompatibilityIssue {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    pub message: String,
}
pub(crate) fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
// ECMAScript \s, used by the existing native manifest grammar.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
/// Returns the text inside one pair of matching quotes, ignoring trailing spaces or tabs.
fn unquote(value: &str) -> Option<&str> {
    let trimmed = value.trim_end_matches([' ', '\t']);
    let bytes = trimmed.as_bytes();
    (bytes.len() >= 2 && matches!(bytes[0], b'"' | b'\'') && bytes[bytes.len() - 1] == bytes[0])
        .then(|| &trimmed[1..trimmed.len() - 1])
}
/// Splits a top-level `key: value` line whose key matches `[A-Za-z0-9_][A-Za-z0-9_.-]*`.
fn key_line(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once(':')?;
    let mut bytes = key.bytes();
    let first = bytes.next()?;
    ((first.is_ascii_alphanumeric() || first == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)))
    .then_some((key, value))
}
/// A YAML block scalar header: `>` or `|`, optional chomping and indentation indicators,
/// then optional spaces and a `#` comment.
fn block_scalar(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(['>', '|']) else {
        return false;
    };
    let bytes = rest.as_bytes();
    let chomp = |b: Option<&u8>| matches!(b, Some(b'-' | b'+'));
    let digit = |b: Option<&u8>| matches!(b, Some(b'1'..=b'9'));
    let skip = if chomp(bytes.first()) {
        1 + usize::from(digit(bytes.get(1)))
    } else if digit(bytes.first()) {
        1 + usize::from(chomp(bytes.get(1)))
    } else {
        0
    };
    let rest = &rest[skip..];
    let after = rest.trim_start_matches([' ', '\t']);
    after.is_empty() || (after.starts_with('#') && after.len() < rest.len())
}
struct Entry<'a> {
    key: &'a str,
    value: &'a str,
    continuation: Vec<&'a str>,
}
/// Explains why a SKILL.md frontmatter block is unusable, without quoting file text.
pub(crate) fn metadata_problem(text: &str, name: &str) -> Option<String> {
    let missing = || Some("SKILL.md must start with a --- frontmatter block closed by ---".into());
    let normalized = text.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return missing();
    };
    let lines: Vec<_> = rest.split('\n').collect();
    let Some(end) = lines.iter().position(|line| *line == "---") else {
        return missing();
    };
    let mut entries = Vec::<Entry>::new();
    for (index, line) in lines[..end].iter().enumerate() {
        if line.chars().all(js_whitespace) || line.starts_with('#') {
            continue;
        }
        let line_number = index + 2;
        if line.starts_with([' ', '\t']) {
            let Some(previous) = entries.last_mut() else {
                return Some(format!(
                    "SKILL.md frontmatter line {line_number} is indented but follows no key"
                ));
            };
            previous.continuation.push(line);
            continue;
        }
        let Some((key, value)) = key_line(line) else {
            return Some(format!(
                "SKILL.md frontmatter line {line_number} is not a key, an indented continuation, a comment or blank"
            ));
        };
        entries.push(Entry {
            key,
            value,
            continuation: Vec::new(),
        });
    }
    let names: Vec<_> = entries.iter().filter(|e| e.key == "name").collect();
    let [declared] = names[..] else {
        return Some(format!(
            "SKILL.md frontmatter needs exactly one name: {name} (found {} name keys)",
            names.len()
        ));
    };
    let declared = declared.value.trim_start_matches([' ', '\t']);
    let declared = unquote(declared).unwrap_or(declared.trim_end_matches([' ', '\t']));
    if declared != name {
        return Some(if name_valid(declared) {
            format!("SKILL.md frontmatter needs exactly one name: {name} (found \"{declared}\")")
        } else {
            format!("SKILL.md frontmatter needs exactly one name: {name}")
        });
    }
    let descriptions: Vec<_> = entries.iter().filter(|e| e.key == "description").collect();
    let [description] = descriptions[..] else {
        return Some(format!(
            "SKILL.md frontmatter needs exactly one non-empty description (found {})",
            descriptions.len()
        ));
    };
    let inline = description.value.trim_start_matches([' ', '\t']);
    if block_scalar(inline) {
        let has_text = description
            .continuation
            .iter()
            .any(|line| line.chars().any(|c| !js_whitespace(c)));
        return (!has_text).then(|| {
            "SKILL.md frontmatter needs exactly one non-empty description; the block scalar has no indented text".into()
        });
    }
    let value = unquote(inline).unwrap_or(inline);
    let valid = value.chars().next().is_some_and(|c| !js_whitespace(c))
        && value.encode_utf16().count() >= 2;
    (!valid).then(|| {
        "SKILL.md frontmatter needs exactly one non-empty description of at least 2 characters"
            .into()
    })
}
pub fn validate(payload: &BundlePayload, target: &str) -> Result<(), Vec<CompatibilityIssue>> {
    if target == "generic" {
        return Ok(());
    }
    let mut issues = Vec::new();
    let mut add = |code: &str, message: String, path: Option<&str>, package: Option<&str>| {
        issues.push(CompatibilityIssue {
            code: code.into(),
            message,
            path: path.map(str::to_owned),
            package: package.map(str::to_owned),
        })
    };
    if !valid_target(target) {
        add(
            "unknown_target",
            "Unknown compatibility target; use generic, codex, claude, pi or cursor".into(),
            None,
            None,
        );
        return Err(issues);
    }
    let instructions: Vec<_> = payload
        .files
        .iter()
        .filter(|f| f.kind == "instruction")
        .map(|f| f.path.as_str())
        .collect();
    if instructions.len() > 1 {
        add(
            "instruction_count",
            format!(
                "Native mapping supports at most one instruction file; found {}: {}",
                instructions.len(),
                instructions.join(", ")
            ),
            None,
            None,
        );
    }
    let skills: Vec<_> = payload.files.iter().filter(|f| f.kind == "skill").collect();
    // Preserve package discovery order to produce the same diagnostics as the SDK.
    let mut names = Vec::<(String, String)>::new();
    let mut seen = BTreeMap::<String, String>::new();
    for file in &skills {
        let parts: Vec<_> = file.path.split('/').collect();
        if parts.len() < 3 || parts[0] != "skills" || !name_valid(parts[1]) || parts[2].is_empty() {
            add(
                "skill_path",
                "Skill files must be under skills/<name>/<file>, where <name> uses letters, digits, _ or - (max 64)".into(),
                Some(&file.path),
                None,
            );
            continue;
        }
        let name = parts[1];
        if target == "cursor"
            && !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            add(
                "skill_name",
                format!(
                    "Cursor skill names require lowercase letters, digits or - (max 64); rename \"{name}\""
                ),
                Some(&file.path),
                Some(name),
            );
        }
        let folded = name.to_ascii_lowercase();
        if let Some(existing) = seen.get(&folded) {
            if existing != name {
                add(
                    "skill_case_collision",
                    format!(
                        "Skill names differ only by case: \"{name}\" and \"{existing}\"; use one spelling"
                    ),
                    Some(&file.path),
                    Some(name),
                );
            }
        } else {
            seen.insert(folded.clone(), name.into());
            names.push((folded, name.into()));
        }
    }
    for (folded, name) in names {
        let manifest_path = format!("skills/{name}/SKILL.md");
        let manifest = skills
            .iter()
            .find(|f| f.path.to_ascii_lowercase() == format!("skills/{folded}/skill.md"));
        match manifest {
            Some(file) if file.path == manifest_path => {
                if let Some(problem) = metadata_problem(&file.text, &name) {
                    add("skill_metadata", problem, Some(&file.path), Some(&name));
                }
            }
            other => add(
                "skill_manifest",
                format!(
                    "Skill package requires an exact SKILL.md manifest at {manifest_path}{}",
                    other.map_or(String::new(), |file| format!(" (found {})", file.path))
                ),
                Some(&manifest_path),
                Some(&name),
            ),
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}
pub(crate) async fn validate_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    bundle: Uuid,
    payload: &BundlePayload,
) -> ApiResult<()> {
    let target: String = sqlx::query_scalar(
        "SELECT compatibility_target FROM bundles WHERE project_id=$1 AND id=$2",
    )
    .bind(project)
    .bind(bundle)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Bundle not found"))?;
    validate(payload, &target).map_err(|issues| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_compatibility",
            "Payload is incompatible with bundle target",
        )
        .with_details(serde_json::json!({"issues":issues}))
    })
}
