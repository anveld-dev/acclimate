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
fn name_valid(name: &str) -> bool {
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
fn metadata_valid(text: &str, name: &str) -> bool {
    let normalized = text.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return false;
    };
    let mut metadata = Vec::new();
    let mut closed = false;
    for line in rest.split('\n') {
        if line == "---" {
            closed = true;
            break;
        }
        metadata.push(line);
    }
    if !closed {
        return false;
    }
    let metadata = metadata.join("\n");
    let lines: Vec<_> = metadata
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .collect();
    let declared_name = lines
        .iter()
        .filter_map(|line| line.strip_prefix("name:"))
        .map(|value| value.trim_matches([' ', '\t']))
        .find(|value| name_valid(value));
    let matching_name = declared_name == Some(name);
    let description = lines.iter().any(|line| {
        line.strip_prefix("description:").is_some_and(|value| {
            let value = value.trim_start_matches([' ', '\t']);
            value.chars().next().is_some_and(|c| !js_whitespace(c))
                && value.encode_utf16().count() >= 2
        })
    });
    matching_name && description
}
pub fn validate(payload: &BundlePayload, target: &str) -> Result<(), Vec<CompatibilityIssue>> {
    if target == "generic" {
        return Ok(());
    }
    let mut issues = Vec::new();
    let mut add = |code: &str, message: &str, path: Option<&str>, package: Option<&str>| {
        issues.push(CompatibilityIssue {
            code: code.into(),
            message: message.into(),
            path: path.map(str::to_owned),
            package: package.map(str::to_owned),
        })
    };
    if !valid_target(target) {
        add("unknown_target", "Unknown compatibility target", None, None);
        return Err(issues);
    }
    if payload
        .files
        .iter()
        .filter(|f| f.kind == "instruction")
        .count()
        > 1
    {
        add(
            "instruction_count",
            "Native mapping supports at most one instruction file",
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
                "Skill files require skills/<name>/<file>",
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
                "Cursor skill names require lowercase letters, digits or hyphens",
                Some(&file.path),
                Some(name),
            );
        }
        let folded = name.to_ascii_lowercase();
        if let Some(existing) = seen.get(&folded) {
            if existing != name {
                add(
                    "skill_case_collision",
                    "Skill names differ only by case",
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
                if !metadata_valid(&file.text, &name) {
                    add(
                        "skill_metadata",
                        "Skill metadata requires a matching name and description",
                        Some(&file.path),
                        Some(&name),
                    );
                }
            }
            _ => add(
                "skill_manifest",
                "Skill package requires an exact SKILL.md manifest",
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
