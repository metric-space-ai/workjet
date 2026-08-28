// SPDX-License-Identifier: MIT OR AGPL-3.0-only
//
// The gateway host runs on the user's machine and proxies every provider
// request, so "what does it write about those requests" is a privacy boundary,
// not a logging preference. Three properties hold today only because nobody has
// changed a line. These tests make changing that line loud.

// The commercial-mode half of this trio lives in
// `internal/runtime/executor/helps/logging_helpers_test.rs`: `logging_helpers`
// is private to its parent module, and widening that visibility just to reach
// it from here would be a real API change made for a test's convenience.

use std::fs;
use std::path::{Path, PathBuf};

use crate::internal::config::sdk_config::SdkConfig;

fn host_source() -> (PathBuf, String) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("internal/api/server.rs");
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    (path, source)
}

/// `RequestLoggingPolicy` also offers `full`/`full_scoped`, which write EVERY
/// upstream request body to disk. The host must never select them — it uses
/// `error_only_scoped` at all of its call sites, so only failures are recorded.
/// Nothing enforced that: switching a single call site broke no test.
#[test]
fn the_host_never_selects_full_request_logging() {
    let (path, source) = host_source();

    let full_selections: Vec<usize> = source
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("RequestLoggingPolicy::full"))
        .map(|(index, _)| index + 1)
        .collect();
    assert!(
        full_selections.is_empty(),
        "{} selects full request logging at line(s) {full_selections:?}; the host must only ever \
         use error_only_scoped, or every upstream request body lands on disk",
        path.display()
    );

    // Pin the positive half too: without it, deleting the logging setup
    // outright would also satisfy the assertion above.
    let scoped = source
        .matches("RequestLoggingPolicy::error_only_scoped")
        .count();
    assert!(
        scoped > 0,
        "{} no longer selects error_only_scoped anywhere — the request logging setup vanished \
         rather than being narrowed",
        path.display()
    );
}

/// `request_log` enables full upstream capture and carries `#[serde(default)]`,
/// so an absent key must mean "off". A configuration that simply never mentions
/// the field can never opt a user into capture.
#[test]
fn sdk_config_request_log_defaults_to_false() {
    let empty: SdkConfig = serde_json::from_str("{}").expect("deserialize an empty SdkConfig");
    assert!(
        !empty.request_log,
        "request_log defaulted to true: a configuration that never mentions the field would start \
         capturing upstream request bodies"
    );
    assert!(
        !SdkConfig::default().request_log,
        "SdkConfig::default() enables request_log"
    );

    // The field must still be reachable, or the two assertions above pass
    // merely because it was renamed away. Serialized configuration spells it
    // kebab-case (`request-log`); the Rust identifier is not the wire name.
    let enabled: SdkConfig =
        serde_json::from_str(r#"{"request-log":true}"#).expect("deserialize request-log");
    assert!(
        enabled.request_log,
        "request_log can no longer be enabled through configuration, which would make the default \
         assertions above vacuous"
    );
}
