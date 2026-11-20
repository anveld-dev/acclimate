use crate::{BundleFile, BundlePayload, ProposalRequest, compatibility, digest};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillPackages {
    pub create_skill_names: Vec<String>,
    pub retire_skill_names: Vec<String>,
}

impl SkillPackages {
    pub(crate) fn enabled(&self) -> bool {
        !self.create_skill_names.is_empty() || !self.retire_skill_names.is_empty()
    }

    pub(crate) fn valid(&self) -> bool {
        [&self.create_skill_names, &self.retire_skill_names]
            .iter()
            .all(|names| {
                let mut seen = HashSet::new();
                names.len() <= 32
                    && names.iter().all(|name| {
                        compatibility::name_valid(name) && seen.insert(name.to_ascii_lowercase())
                    })
            })
    }

    pub(crate) fn permits_future_path(&self, path: &str) -> bool {
        skill_name(path).is_some_and(|name| self.create_skill_names.iter().any(|s| s == name))
            && crate::bundles::validate_payload(&BundlePayload {
                schema_version: 1,
                files: vec![BundleFile {
                    path: path.into(),
                    kind: "skill".into(),
                    text: String::new(),
                }],
            })
            .is_ok()
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum SkillOperation {
    CreateSkill {
        name: String,
        files: Vec<NewFile>,
    },
    RetireSkill {
        name: String,
        expected_package_digest: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NewFile {
    relative_path: String,
    text: String,
}

fn skill_name(path: &str) -> Option<&str> {
    path.strip_prefix("skills/")?
        .split_once('/')
        .map(|(name, _)| name)
}

fn members<'a>(payload: &'a BundlePayload, name: &str) -> Vec<&'a BundleFile> {
    payload
        .files
        .iter()
        .filter(|file| skill_name(&file.path) == Some(name))
        .collect()
}

fn collides(payload: &BundlePayload, name: &str) -> bool {
    let root = format!("skills/{name}").to_ascii_lowercase();
    let prefix = format!("{root}/");
    payload.files.iter().any(|file| {
        let path = file.path.to_ascii_lowercase();
        path == root || path.starts_with(&prefix)
    })
}

// Same canonical inventory and terminal LF as SDK packageDigest.
pub(crate) fn package_digests(
    parent: &BundlePayload,
    policy: &SkillPackages,
) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for name in &policy.retire_skill_names {
        let mut members = members(parent, name);
        if members.is_empty() || members.iter().any(|file| file.kind != "skill") {
            continue;
        }
        members.sort_by(|a, b| a.path.cmp(&b.path));
        let files: Vec<_> = members
            .iter()
            .map(|file| {
                serde_json::json!({
                    "kind": file.kind, "path": file.path, "textDigest": digest(file.text.as_bytes())
                })
            })
            .collect();
        let inventory = serde_json::json!({"files": files, "kind": "skill-package-inventory", "name": name, "schemaVersion": 1});
        result.insert(name.clone(), digest(format!("{inventory}\n").as_bytes()));
    }
    result
}

pub(super) fn apply(
    parent: &BundlePayload,
    candidate: &mut BundlePayload,
    policy: &SkillPackages,
    operations: Vec<SkillOperation>,
    edited_paths: &HashSet<&str>,
) -> Result<(), String> {
    let mut claimed = HashSet::new();
    let digests = package_digests(parent, policy);
    for operation in operations {
        let name = match &operation {
            SkillOperation::CreateSkill { name, .. } | SkillOperation::RetireSkill { name, .. } => {
                name
            }
        };
        if !claimed.insert(name.to_ascii_lowercase())
            || edited_paths
                .iter()
                .any(|path| skill_name(path).is_some_and(|other| other.eq_ignore_ascii_case(name)))
        {
            return Err("Conflicting skill operations".into());
        }
        match operation {
            SkillOperation::CreateSkill { name, files } => {
                if !policy.create_skill_names.contains(&name)
                    || collides(parent, &name)
                    || files.is_empty()
                    || files.len() > 128
                {
                    return Err("Skill creation outside permitted scope".into());
                }
                let mut added: Vec<_> = files
                    .into_iter()
                    .map(|file| BundleFile {
                        path: format!("skills/{name}/{}", file.relative_path),
                        kind: "skill".into(),
                        text: file.text,
                    })
                    .collect();
                added.sort_by(|a, b| a.path.cmp(&b.path));
                candidate.files.extend(added);
            }
            SkillOperation::RetireSkill {
                name,
                expected_package_digest,
            } => {
                if digests.get(&name) != Some(&expected_package_digest) {
                    return Err("Skill retirement precondition failed".into());
                }
                candidate
                    .files
                    .retain(|file| skill_name(&file.path) != Some(name.as_str()));
            }
        }
    }
    Ok(())
}

/// Validate the full result as well as the wire edit envelope. A custom provider
/// returns a payload directly and still has exactly the admitted capabilities.
pub(crate) fn validate_changes(
    parent: &BundlePayload,
    candidate: &BundlePayload,
    request: &ProposalRequest,
    policy: Option<&SkillPackages>,
) -> Result<(), String> {
    let before: HashMap<_, _> = parent.files.iter().map(|file| (&file.path, file)).collect();
    let after: HashMap<_, _> = candidate
        .files
        .iter()
        .map(|file| (&file.path, file))
        .collect();
    // Native loaders can observe file order. Preserve the existing relative
    // order, including when a package is created or removed in the same edit.
    if !parent
        .files
        .iter()
        .map(|file| &file.path)
        .filter(|path| after.contains_key(path))
        .eq(candidate
            .files
            .iter()
            .map(|file| &file.path)
            .filter(|path| before.contains_key(path)))
    {
        return Err("Proposal reordered existing files".into());
    }
    let mut created = HashSet::new();
    let mut retired = HashSet::new();
    let mut changed = false;
    let mut removed_notes = 0;
    let mut new_notes = 0;
    for file in &parent.files {
        if let Some(next) = after.get(&file.path) {
            if file.kind != next.kind
                || (file.text != next.text
                    && (!request.allowed_paths.contains(&file.path)
                        || (file.kind == "memory" && super::memory_path(&file.path))))
            {
                return Err("Edit outside allowed paths".into());
            }
            if file.kind == "skill"
                && file.text != next.text
                && let Some((name, "SKILL.md")) = file
                    .path
                    .strip_prefix("skills/")
                    .and_then(|path| path.split_once('/'))
                && (compatibility::metadata_valid(&file.text, name)
                    || next.text.starts_with("---\n")
                    || next.text.starts_with("---\r\n"))
                && !compatibility::metadata_valid(&next.text, name)
            {
                return Err("Invalid skill package".into());
            }
            // A generated edit may change only `name` and `description` frontmatter.
            // Anything else an author declared, such as `allowed-tools`, stays as written.
            if file.kind == "skill"
                && restricted_frontmatter(&next.text) != restricted_frontmatter(&file.text)
            {
                return Err("Invalid skill package".into());
            }
            changed |= file.text != next.text;
        } else {
            if file.kind == "memory"
                && super::memory_path(&file.path)
                && request.allowed_paths.contains(&file.path)
            {
                removed_notes += 1;
                continue;
            }
            let name = skill_name(&file.path).ok_or("File set changed")?;
            if file.kind != "skill"
                || !policy.is_some_and(|p| p.retire_skill_names.iter().any(|s| s == name))
            {
                return Err("File set changed".into());
            }
            retired.insert(name);
        }
    }
    for file in &candidate.files {
        if before.contains_key(&file.path) {
            continue;
        }
        if file.kind == "memory"
            && super::memory_path(&file.path)
            && request.allowed_paths.contains(&file.path)
            && !file.text.trim().is_empty()
            && file.text.len() <= 4096
        {
            new_notes += 1;
            continue;
        }
        let name = skill_name(&file.path).ok_or("File set changed")?;
        if file.kind != "skill"
            || !policy.is_some_and(|p| p.create_skill_names.iter().any(|s| s == name))
        {
            return Err("File set changed".into());
        }
        created.insert(name);
    }
    if removed_notes > new_notes {
        return Err("Memory notes may only be removed by supersession".into());
    }
    if !changed && new_notes == 0 && created.is_empty() && retired.is_empty() {
        return Err("Proposal did not change any file".into());
    }
    for name in retired {
        if collides(candidate, name) {
            return Err("Retirement must remove the entire skill".into());
        }
    }
    for name in created {
        if collides(parent, name) {
            return Err("Skill creation requires a new package".into());
        }
        let package = BundlePayload {
            schema_version: 1,
            files: members(candidate, name).into_iter().cloned().collect(),
        };
        // A generic bundle also needs a usable SKILL.md in a newly created package.
        compatibility::validate(&package, "codex").map_err(|_| "Invalid skill package")?;
        // Authored packages may bundle scripts, tool permissions, hooks or a model;
        // a generated package is Markdown whose frontmatter is only `name` and
        // `description`, so it cannot grant itself tools or permissions.
        if package.files.iter().any(|file| {
            !file.path.ends_with(".md") || !restricted_frontmatter(&file.text).is_empty()
        }) {
            return Err("Invalid skill package".into());
        }
    }
    Ok(())
}

/// Frontmatter keys a service-generated proposal may write.
const PROPOSAL_FRONTMATTER: [&str; 2] = ["name", "description"];

/// The frontmatter lines outside the proposal allowlist: every key other than
/// `name` and `description` (such as `allowed-tools`, `hooks` or `model`), with
/// its indented continuation lines, and any line that is not a key at all.
fn restricted_frontmatter(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Vec::new();
    };
    let mut restricted = Vec::new();
    let mut inside_restricted = false;
    for line in rest.split('\n').take_while(|line| *line != "---") {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with([' ', '\t']) {
            if inside_restricted {
                restricted.push(line.to_owned());
            }
            continue;
        }
        let key = line.split_once(':').map(|(key, _)| key.trim_end());
        inside_restricted = !key.is_some_and(|key| PROPOSAL_FRONTMATTER.contains(&key));
        if inside_restricted {
            restricted.push(line.to_owned());
        }
    }
    restricted
}
