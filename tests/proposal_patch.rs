use acclimate_service::{
    BundlePayload,
    proposal_edits::{Changes, reconstruct},
};
use serde_json::{Value, json};
fn parent(text: &str) -> BundlePayload {
    serde_json::from_value(json!({"schemaVersion":1,"files":[{"path":"guide.md","kind":"instruction","text":text},{"path":"memory/large.md","kind":"memory","text":"unchanged\n".repeat(5000)}]})).unwrap()
}
fn patch(edits: Value) -> Changes {
    serde_json::from_value(json!({"edits":edits,"files":[]})).unwrap()
}
#[test]
fn disjoint_original_unicode_anchors_preserve_large_untouched_bytes_and_order() {
    let p = parent(&format!(
        "{}\nαβ gamma δ\n{}",
        "prefix".repeat(7000),
        "tail".repeat(2000)
    ));
    let c = reconstruct(
        &p,
        &patch(json!([
 {"path":"guide.md","oldText":"αβ","newText":"💡"},
 {"path":"guide.md","oldText":"gamma δ","newText":"gamma β"}])),
        "generic",
    )
    .unwrap();
    assert_eq!(
        c.files[0].text,
        p.files[0]
            .text
            .replace("αβ", "💡")
            .replace("gamma δ", "gamma β")
    );
    assert_eq!(c.files[1].text, p.files[1].text);
    assert_eq!(c.files[1].path, p.files[1].path);
    assert_eq!(c.files[1].kind, p.files[1].kind);
    assert!(p.files[1].text.len() > 40_000);
}
#[test]
fn rejects_overlap_duplicate_ambiguous_missing_and_empty_anchors() {
    for edits in [
        json!([{"path":"guide.md","oldText":"abc","newText":"x"},{"path":"guide.md","oldText":"bcd","newText":"y"}]),
        json!([{"path":"guide.md","oldText":"abc","newText":"x"},{"path":"guide.md","oldText":"abc","newText":"y"}]),
        json!([{"path":"guide.md","oldText":"","newText":"x"}]),
        json!([{"path":"guide.md","oldText":"missing","newText":"x"}]),
        json!([{"path":"missing.md","oldText":"abc","newText":"x"}]),
    ] {
        assert!(reconstruct(&parent("abcd"), &patch(edits), "generic").is_err());
    }
    assert!(
        reconstruct(
            &parent("aaa"),
            &patch(json!([{"path":"guide.md","oldText":"aa","newText":"x"}])),
            "generic"
        )
        .is_err()
    );
    let empty = parent("");
    assert_eq!(
        reconstruct(
            &empty,
            &patch(json!([{"path":"guide.md","oldText":"","newText":"hello"}])),
            "generic"
        )
        .unwrap()
        .files[0]
            .text,
        "hello"
    );
    assert!(reconstruct(&empty,&patch(json!([{"path":"guide.md","oldText":"","newText":"x"},{"path":"guide.md","oldText":"","newText":"y"}])), "generic").is_err());
}
fn whole(files: Value) -> Changes {
    serde_json::from_value(json!({"edits":[],"files":files})).unwrap()
}

#[test]
fn writes_and_deletes_any_file_and_preserves_existing_kind_and_order() {
    let p = parent("original");
    let changes = whole(json!([
        {"op":"write","path":"guide.md","text":"updated"},
        {"op":"delete","path":"memory/large.md"},
        {"op":"write","path":"skills/triage/SKILL.md","text":"---\nname: triage\ndescription: Help\nallowed-tools: Read\n---\nCheck retries."},
        {"op":"write","path":"memory/new.md","text":"new note"}
    ]));
    let c = reconstruct(&p, &changes, "generic").unwrap();
    assert_eq!(
        c.files
            .iter()
            .map(|file| (file.path.as_str(), file.kind.as_str()))
            .collect::<Vec<_>>(),
        [
            ("guide.md", "instruction"),
            ("skills/triage/SKILL.md", "skill"),
            ("memory/new.md", "memory")
        ]
    );
    assert_eq!(c.files[0].text, "updated");
    let edits = patch(
        json!([{"path":"memory/large.md","oldText":"unchanged\n".repeat(5000),"newText":"new"}]),
    );
    assert_eq!(
        reconstruct(&p, &edits, "generic").unwrap().files[1].text,
        "new"
    );
}

#[test]
fn rejects_invalid_paths_duplicates_and_empty_payloads() {
    let p = parent("original");
    for files in [
        json!([{"op":"delete","path":"missing.md"}]),
        json!([{"op":"delete","path":"guide.md"},{"op":"delete","path":"guide.md"}]),
        json!([{"op":"delete","path":"guide.md"},{"op":"delete","path":"memory/large.md"}]),
        json!([{"op":"write","path":"Guide.md","text":"duplicate"}]),
    ] {
        assert!(reconstruct(&p, &whole(files), "generic").is_err());
    }
    let changes: Changes = serde_json::from_value(json!({
        "edits":[{"path":"guide.md","oldText":"original","newText":"new"}],
        "files":[{"op":"delete","path":"guide.md"}]
    }))
    .unwrap();
    assert!(reconstruct(&p, &changes, "generic").is_err());
}

#[test]
fn delivery_and_target_limits_apply_without_a_growth_cap() {
    let p = parent("original");
    let second = whole(json!([{"op":"write","path":"second.md","text":"other"}]));
    assert!(reconstruct(&p, &second, "generic").is_ok());
    assert!(reconstruct(&p, &second, "codex").is_err());
    for (count, should_fit) in [(4, true), (5, false)] {
        let ops = (0..count).map(|i| json!({"op":"write","path":format!("memory/long-{i}.md"),"text":"x".repeat(225*1024)})).collect::<Vec<_>>();
        assert_eq!(
            reconstruct(&p, &whole(json!(ops)), "generic").is_ok(),
            should_fit
        );
    }
}
