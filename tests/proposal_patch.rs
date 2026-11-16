use acclimate_service::{BundlePayload, ProposalRequest, proposal_edits::reconstruct};
use serde_json::{Value, json};
fn parent(text: &str) -> BundlePayload {
    serde_json::from_value(json!({"schemaVersion":1,"files":[{"path":"guide.md","kind":"instruction","text":text},{"path":"memory/large.md","kind":"memory","text":"unchanged\n".repeat(5000)}]})).unwrap()
}
fn request() -> ProposalRequest {
    ProposalRequest {
        parent_version_id: "parent".into(),
        allowed_paths: vec!["guide.md".into()],
        hypothesis: "Improve".into(),
        evidence: vec![],
    }
}
fn patch(edits: Value) -> String {
    json!({"schemaVersion":1,"edits":edits,"rationale":"A bounded revision"}).to_string()
}
#[test]
fn disjoint_original_unicode_anchors_preserve_large_untouched_bytes_and_order() {
    let p = parent(&format!(
        "{}\nαβ gamma δ\n{}",
        "prefix".repeat(7000),
        "tail".repeat(2000)
    ));
    let (c, _) = reconstruct(
        &p,
        &request(),
        &patch(json!([
 {"path":"guide.md","oldText":"αβ","newText":"💡"},
 {"path":"guide.md","oldText":"gamma δ","newText":"gamma β"}])),
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
fn rejects_overlap_duplicate_ambiguous_missing_outside_and_empty_anchors() {
    for edits in [
        json!([{"path":"guide.md","oldText":"abc","newText":"x"},{"path":"guide.md","oldText":"bcd","newText":"y"}]),
        json!([{"path":"guide.md","oldText":"abc","newText":"x"},{"path":"guide.md","oldText":"abc","newText":"y"}]),
        json!([{"path":"guide.md","oldText":"","newText":"x"}]),
        json!([{"path":"guide.md","oldText":"missing","newText":"x"}]),
        json!([{"path":"memory/large.md","oldText":"unchanged","newText":"x"}]),
        json!([{"path":"missing.md","oldText":"abc","newText":"x"}]),
    ] {
        assert!(reconstruct(&parent("abcd"), &request(), &patch(edits)).is_err());
    }
    assert!(
        reconstruct(
            &parent("aaa"),
            &request(),
            &patch(json!([{"path":"guide.md","oldText":"aa","newText":"x"}]))
        )
        .is_err()
    );
    let empty = parent("");
    assert_eq!(
        reconstruct(
            &empty,
            &request(),
            &patch(json!([{"path":"guide.md","oldText":"","newText":"hello"}]))
        )
        .unwrap()
        .0
        .files[0]
            .text,
        "hello"
    );
    assert!(reconstruct(&empty,&request(),&patch(json!([{"path":"guide.md","oldText":"","newText":"x"},{"path":"guide.md","oldText":"","newText":"y"}]))).is_err());
}
#[test]
fn protocol_bounds_and_no_full_payload_fallback() {
    let p = parent("original");
    assert!(
        reconstruct(
            &p,
            &request(),
            &json!({"payload":p,"rationale":"old full echo"}).to_string()
        )
        .is_err()
    );
    let edit = json!({"path":"guide.md","oldText":"original","newText":"x"});
    assert!(reconstruct(&p, &request(), &patch(json!(vec![edit; 129]))).is_err());
    let rationale = json!({"schemaVersion":1,"edits":[],"rationale":"💡".repeat(1025)}).to_string();
    assert!(reconstruct(&p, &request(), &rationale).is_err());
    let content =
        patch(json!([{"path":"guide.md","oldText":"original","newText":"x".repeat(32768)}]));
    assert!(reconstruct(&p, &request(), &content).is_err());
    assert!(reconstruct(&p, &request(), "{\"schemaVersion\":1,\"edits\":[]").is_err());
}

#[test]
fn inclusive_protocol_limits_and_final_payload_limit() {
    let p = parent("original");
    let mut content = patch(json!([]));
    content.extend(std::iter::repeat_n(' ', 32768 - content.len()));
    assert!(reconstruct(&p, &request(), &content).is_ok());
    content.push(' ');
    assert!(reconstruct(&p, &request(), &content).is_err());
    let rationale = json!({"schemaVersion":1,"edits":[],"rationale":"x".repeat(4096)}).to_string();
    assert!(reconstruct(&p, &request(), &rationale).is_ok());
    let original = (0..128)
        .map(|i| format!("anchor-{i:03} "))
        .collect::<String>();
    let edits = (0..128).map(|i| json!({"path":"guide.md","oldText":format!("anchor-{i:03}"),"newText":format!("changed-{i:03}")})).collect::<Vec<_>>();
    let (candidate, _) = reconstruct(&parent(&original), &request(), &patch(json!(edits))).unwrap();
    assert_eq!(
        candidate.files[0].text,
        original.replace("anchor-", "changed-")
    );
    let p = parent(&format!("before{}", "x".repeat(262_144 - 6)));
    assert!(
        reconstruct(
            &p,
            &request(),
            &patch(json!([{"path":"guide.md","oldText":"before","newText":"after is longer"}]))
        )
        .is_err()
    );
}
