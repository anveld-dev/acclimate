fn main() {
    // Every target embedding sqlx::migrate! must use the same migration checksums.
    println!("cargo:rerun-if-changed=migrations");
}
