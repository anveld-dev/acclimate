//! Bounded exact original-text edits. The public provider trait still returns a full payload.
use crate::{BundlePayload, ProposalRequest};
use serde::Deserialize;
use std::collections::HashMap;

pub const INSTRUCTION: &str = "Return only JSON {\"schemaVersion\":1,\"edits\":[{\"path\":\"existing allowed path\",\"oldText\":\"exact unique original anchor\",\"newText\":\"replacement\"}],\"rationale\":\"reason\"}. Edit only allowedPaths. Anchors refer to original parent text and must match exactly once, including whitespace. Multiple edits in a file must not overlap. Empty oldText is allowed only for an empty file. Preserve every other byte. No tools, full payload, new files, removals, or renames. At most 128 edits; entire JSON content at most 32768 UTF-8 bytes; rationale at most 4096 UTF-8 bytes.";
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
    request: &ProposalRequest,
    content: &str,
) -> Result<(BundlePayload, String), String> {
    if content.len() > 32 * 1024 {
        return Err("Proposal content exceeds 32KiB".into());
    }
    let response: Response =
        serde_json::from_str(content).map_err(|_| "Invalid proposal edit envelope")?;
    if response.schema_version != 1 || response.edits.len() > 128 || response.rationale.len() > 4096
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
    for (index, mut edits) in ranges {
        edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
        for (start, end, text) in edits {
            candidate.files[index].text.replace_range(start..end, &text);
        }
    }
    crate::bundles::validate_payload(&candidate)?;
    Ok((candidate, response.rationale))
}
