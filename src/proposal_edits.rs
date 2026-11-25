//! Exact original-text edits and whole-file operations.
use crate::{BundleFile, BundlePayload};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Changes {
    pub edits: Vec<Edit>,
    pub files: Vec<FileOp>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum FileOp {
    Write { path: String, text: String },
    Delete { path: String },
}

pub fn reconstruct(
    parent: &BundlePayload,
    changes: &Changes,
    target: &str,
) -> Result<BundlePayload, String> {
    if changes.edits.is_empty() && changes.files.is_empty() {
        return Err("At least one operation is required".into());
    }
    let mut ranges: HashMap<usize, Vec<(usize, usize, String)>> = HashMap::new();
    for edit in &changes.edits {
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
        edits.push((start, end, edit.new_text.clone()));
    }
    let mut candidate = parent.clone();
    for (index, mut edits) in ranges {
        edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
        for (start, end, text) in edits {
            candidate.files[index].text.replace_range(start..end, &text);
        }
    }
    let mut paths: HashSet<&str> = changes
        .edits
        .iter()
        .map(|edit| edit.path.as_str())
        .collect();
    for op in &changes.files {
        let path = match op {
            FileOp::Write { path, .. } | FileOp::Delete { path } => path,
        };
        if !paths.insert(path) {
            return Err("Whole-file path overlaps another operation".into());
        }
        let index = candidate.files.iter().position(|file| &file.path == path);
        match (op, index) {
            (FileOp::Write { text, .. }, Some(index)) => {
                candidate.files[index].text.clone_from(text)
            }
            (FileOp::Write { text, .. }, None) => {
                let kind = if path.starts_with("skills/") {
                    "skill"
                } else if path.starts_with("memory/") {
                    "memory"
                } else {
                    "instruction"
                };
                candidate.files.push(BundleFile {
                    path: path.clone(),
                    kind: kind.into(),
                    text: text.clone(),
                });
            }
            (FileOp::Delete { .. }, Some(index)) => {
                candidate.files.remove(index);
            }
            (FileOp::Delete { .. }, None) => return Err("Delete path does not exist".into()),
        }
    }
    crate::bundles::validate_payload(&candidate)?;
    crate::compatibility::validate(&candidate, target).map_err(|issues| {
        let codes: BTreeSet<_> = issues.iter().map(|issue| issue.code.as_str()).collect();
        format!(
            "Result is incompatible with the {target} target ({})",
            codes.into_iter().collect::<Vec<_>>().join(", ")
        )
    })?;
    crate::encode_payload(&candidate).map_err(|error| error.2)?;
    Ok(candidate)
}

pub(crate) fn changed_files<'a>(
    parent: &'a BundlePayload,
    candidate: &'a BundlePayload,
) -> BTreeSet<&'a str> {
    let before: HashMap<_, _> = parent
        .files
        .iter()
        .map(|file| (file.path.as_str(), &file.text))
        .collect();
    let after: HashMap<_, _> = candidate
        .files
        .iter()
        .map(|file| (file.path.as_str(), &file.text))
        .collect();
    before
        .keys()
        .chain(after.keys())
        .copied()
        .filter(|path| before.get(path) != after.get(path))
        .collect()
}
