//! Bounded exact original-text edits. The public provider trait still returns a full payload.
use crate::{BundlePayload, ProposalRequest};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
mod skills;
pub use skills::SkillPackages;
pub(crate) use skills::{package_digests, validate_changes};

pub const INSTRUCTION: &str = "Return only JSON {\"schemaVersion\":1,\"edits\":[{\"path\":\"existing allowed path\",\"oldText\":\"exact unique original anchor\",\"newText\":\"replacement\"}],\"rationale\":\"reason\"}. Edit only allowedPaths. Anchors refer to original parent text and must match exactly once, including whitespace. Multiple edits in a file must not overlap. Empty oldText is allowed only for an empty file. Preserve every other byte. No tools, full payload or renames. At most 128 edits; entire JSON content at most 32768 UTF-8 bytes; rationale at most 4096 UTF-8 bytes.";
pub const SKILL_INSTRUCTION: &str = "Return only JSON with schemaVersion:1, edits (the same exact unique original oldText/newText/path rules as fixed-file proposals), rationale and optional skillOperations. For a whole new authorized package use {op:'createSkill',name,files:[{relativePath,text}]} with a valid SKILL.md matching the name. For complete retirement use {op:'retireSkill',name,expectedPackageDigest} copying the exact packageDigests value. Only names authorized for that operation; no package moves, partial deletion or overlapping operations. Edit existing files only in request.allowedPaths. Match each oldText against original parent exactly once; empty oldText only for an empty file. Preserve other bytes. At most 128 edits and skill operations combined; entire JSON content at most 32768 UTF-8 bytes; rationale at most 4096 UTF-8 bytes.";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    schema_version: u8,
    edits: Vec<Edit>,
    #[serde(default)]
    skill_operations: Vec<skills::SkillOperation>,
    rationale: String,
    #[serde(default)]
    note_operations: Vec<CreateNote>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    path: String,
    old_text: String,
    new_text: String,
}

pub const NOTE_INSTRUCTION: &str = "Prefer reusable lessons over copying task details. For memory notes use optional noteOperations:[{op:\"create_note\",path,text,supersedes?}]. Use a new allowed memory/ path, nonempty text up to 4096 UTF-8 bytes, and optionally remove one existing allowed memory/ note via supersedes. Do not edit memory/ notes in place. rationale must be nonempty.";

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum CreateNote {
    CreateNote {
        path: String,
        text: String,
        supersedes: Option<String>,
    },
}

pub(crate) fn memory_path(path: &str) -> bool {
    path.starts_with("memory/")
        && crate::bundles::validate_payload(&BundlePayload {
            schema_version: 1,
            files: vec![crate::BundleFile {
                path: path.into(),
                kind: "memory".into(),
                text: String::new(),
            }],
        })
        .is_ok()
}

pub(crate) fn validate_growth(
    parent: &BundlePayload,
    candidate: &BundlePayload,
) -> Result<(), String> {
    let baseline = crate::encode_payload(parent)
        .map_err(|error| error.2)?
        .len();
    let floor = std::env::var("ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(2048);
    if crate::encode_payload(candidate)
        .map_err(|error| error.2)?
        .len()
        .saturating_sub(baseline)
        > (baseline / 10).max(floor)
    {
        return Err("Candidate exceeds proposal byte-growth limit".into());
    }
    Ok(())
}

pub(crate) fn changed_files<'a>(
    parent: &'a BundlePayload,
    candidate: &'a BundlePayload,
) -> Vec<(&'a str, Option<&'a str>, Option<&'a str>)> {
    let before: HashMap<_, _> = parent
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.text.as_str()))
        .collect();
    let after: HashMap<_, _> = candidate
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.text.as_str()))
        .collect();
    parent
        .files
        .iter()
        .chain(
            candidate
                .files
                .iter()
                .filter(|file| !before.contains_key(file.path.as_str())),
        )
        .filter_map(|file| {
            let path = file.path.as_str();
            let old = before.get(path).copied();
            let new = after.get(path).copied();
            (old != new).then_some((path, old, new))
        })
        .collect()
}

pub(crate) fn edit_excerpts(
    parent: &BundlePayload,
    candidate: &BundlePayload,
) -> Vec<serde_json::Value> {
    changed_files(parent, candidate)
        .into_iter()
        .take(4)
        .map(|(path, before, after)| {
            let offset = before
                .unwrap_or_default()
                .chars()
                .zip(after.unwrap_or_default().chars())
                .take_while(|(a, b)| a == b)
                .count();
            let excerpt = |text: &str| text.chars().skip(offset).take(100).collect::<String>();
            serde_json::json!({"path":path,"before":before.map(excerpt),"after":after.map(excerpt)})
        })
        .collect()
}

pub fn reconstruct(
    parent: &BundlePayload,
    request: &ProposalRequest,
    content: &str,
) -> Result<(BundlePayload, String), String> {
    reconstruct_scoped(parent, request, None, content)
}

pub fn reconstruct_scoped(
    parent: &BundlePayload,
    request: &ProposalRequest,
    policy: Option<&SkillPackages>,
    content: &str,
) -> Result<(BundlePayload, String), String> {
    if policy.is_some_and(|p| !p.valid()) {
        return Err("Invalid skill permissions".into());
    }
    if content.len() > 32 * 1024 {
        return Err("Proposal content exceeds 32KiB".into());
    }
    let response: Response = serde_json::from_str(content)
        .map_err(|error| format!("Invalid proposal edit envelope: {error}"))?;
    if response.schema_version != 1
        || response.edits.len() + response.skill_operations.len() + response.note_operations.len()
            > 128
        || response.rationale.trim().is_empty()
        || response.rationale.len() > 4096
    {
        return Err("Proposal edit bounds exceeded".into());
    }
    let mut ranges: HashMap<usize, Vec<(usize, usize, String)>> = HashMap::new();
    for edit in response.edits {
        if !request.allowed_paths.contains(&edit.path) {
            return Err("Edit outside allowed paths".into());
        }
        let (index, file) = parent
            .files
            .iter()
            .enumerate()
            .find(|(_, file)| file.path == edit.path)
            .ok_or("Edit path does not exist")?;
        let start = if edit.old_text.is_empty() {
            if !file.text.is_empty() {
                return Err("Empty anchor requires an empty file".into());
            }
            0
        } else {
            // char_indices also observes overlapping matches and yields valid UTF-8 boundaries.
            let mut matches = file.text.char_indices().filter_map(|(offset, _)| {
                file.text[offset..]
                    .starts_with(&edit.old_text)
                    .then_some(offset)
            });
            let start = matches
                .next()
                .ok_or("Anchor does not match original text")?;
            if matches.next().is_some() {
                return Err("Anchor is ambiguous in original text".into());
            }
            start
        };
        let end = start + edit.old_text.len();
        let edits = ranges.entry(index).or_default();
        if edits
            .iter()
            .any(|(a, b, _)| (start < *b && *a < end) || (start == *a && end == *b))
        {
            return Err("Original edit ranges overlap".into());
        }
        edits.push((start, end, edit.new_text));
    }
    let mut candidate = parent.clone();
    let edited_paths: HashSet<_> = ranges
        .keys()
        .map(|i| parent.files[*i].path.as_str())
        .collect();
    for (index, mut edits) in ranges {
        edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
        for (start, end, text) in edits {
            candidate.files[index].text.replace_range(start..end, &text);
        }
    }
    if !response.skill_operations.is_empty() {
        let scope = policy.ok_or("File set changed")?;
        skills::apply(
            parent,
            &mut candidate,
            scope,
            response.skill_operations,
            &edited_paths,
        )?;
    }
    let mut removed = HashSet::new();
    for CreateNote::CreateNote {
        path,
        text,
        supersedes,
    } in response.note_operations
    {
        if !memory_path(&path)
            || !request.allowed_paths.contains(&path)
            || parent.files.iter().any(|file| file.path == path)
            || text.trim().is_empty()
            || text.len() > 4096
        {
            return Err("Invalid new memory note".into());
        }
        if let Some(previous) = supersedes
            && (!memory_path(&previous)
                || !request.allowed_paths.contains(&previous)
                || !parent
                    .files
                    .iter()
                    .any(|file| file.path == previous && file.kind == "memory")
                || edited_paths.contains(previous.as_str())
                || !removed.insert(previous))
        {
            return Err("Invalid superseded memory note".into());
        }
        candidate.files.push(crate::BundleFile {
            path,
            kind: "memory".into(),
            text,
        });
    }
    candidate.files.retain(|file| !removed.contains(&file.path));
    crate::bundles::validate_payload(&candidate)?;
    validate_changes(parent, &candidate, request, policy)?;
    validate_growth(parent, &candidate)?;
    Ok((candidate, response.rationale))
}
