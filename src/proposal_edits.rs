//! Bounded exact original-text edits.
use crate::BundlePayload;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    schema_version: u8,
    edits: Vec<Edit>,
    rationale: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    path: String,
    old_text: String,
    new_text: String,
}

pub fn reconstruct(
    parent: &BundlePayload,
    content: &str,
) -> Result<(BundlePayload, String), String> {
    if content.len() > 32 * 1024 {
        return Err("Proposal content exceeds 32KiB".into());
    }
    let response: Response = serde_json::from_str(content)
        .map_err(|error| format!("Invalid proposal edit envelope: {error}"))?;
    if response.schema_version != 1
        || response.edits.len() > 128
        || response.rationale.trim().is_empty()
        || response.rationale.len() > 4096
    {
        return Err("Proposal edit bounds exceeded".into());
    }
    let mut ranges: HashMap<usize, Vec<(usize, usize, String)>> = HashMap::new();
    for edit in response.edits {
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
    for (index, mut edits) in ranges {
        edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
        for (start, end, text) in edits {
            candidate.files[index].text.replace_range(start..end, &text);
        }
    }
    crate::bundles::validate_payload(&candidate)?;
    crate::encode_payload(&candidate).map_err(|error| error.2)?;
    if candidate
        .files
        .iter()
        .zip(&parent.files)
        .all(|(a, b)| a.text == b.text)
    {
        return Err("Proposal did not change any file".into());
    }
    Ok((candidate, response.rationale))
}
