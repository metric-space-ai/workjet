// ref: internal/runtime/executor/claude_executor_request_remap_test.go @ a88197f845c979132c8978ea223c6af05cc81536
// Port-Status: adapted_to_ctox
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

use super::{
    remap_claude_oauth_tool_names_with_secret, restore_claude_oauth_tool_names_from_response,
    restore_claude_oauth_tool_names_from_stream_line,
};

#[test]
fn oauth_stream_restores_complete_event_frames_and_preserves_boundaries() {
    for tool in ["Bash", "Read", "exec_command"] {
        let request = serde_json::to_vec(&serde_json::json!({"tools": [{"name": tool}]})).unwrap();
        let (mapped, reverse) = remap_claude_oauth_tool_names_with_secret(&request, "caller-a");
        let mapped: serde_json::Value = serde_json::from_slice(&mapped).unwrap();
        let alias = mapped["tools"][0]["name"].as_str().unwrap();
        for newline in ["\n", "\r\n"] {
            let frame = format!(
                "event: content_block_start{newline}data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"{alias}\",\"input\":{{}}}}}}{newline}{newline}"
            );
            let restored = restore_claude_oauth_tool_names_from_stream_line(
                frame.as_bytes(),
                "",
                false,
                &reverse,
            );
            assert_eq!(
                restore_claude_oauth_tool_names_from_response(
                    frame.as_bytes(),
                    "",
                    false,
                    &reverse
                ),
                restored,
            );
            let restored = String::from_utf8(restored).unwrap();
            assert!(restored.starts_with(&format!("event: content_block_start{newline}data: ")));
            assert!(restored.ends_with(&format!("{newline}{newline}")));
            let data = restored
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap();
            let payload: serde_json::Value = serde_json::from_str(data).unwrap();
            assert_eq!(payload["content_block"]["name"], tool);
            assert_eq!(payload["content_block"]["id"], "call_1");
        }
    }
}

#[test]
fn oauth_stream_restores_data_only_frames_without_losing_separator() {
    let reverse = std::collections::HashMap::from([("alias".to_owned(), "Read".to_owned())]);
    let frame =
        b"data: {\"content_block\":{\"type\":\"tool_reference\",\"tool_name\":\"alias\"}}\n\n";
    let restored = restore_claude_oauth_tool_names_from_stream_line(frame, "", false, &reverse);
    assert!(restored.ends_with(b"\n\n"));
    let data = std::str::from_utf8(&restored)
        .unwrap()
        .trim()
        .strip_prefix("data: ")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(data).unwrap();
    assert_eq!(payload["content_block"]["tool_name"], "Read");
}

#[test]
fn oauth_stream_leaves_unrelated_frames_and_arguments_unchanged() {
    let reverse = std::collections::HashMap::from([("alias".to_owned(), "Read".to_owned())]);
    for frame in [
        b": keepalive\r\nevent: ping\r\ndata: {\"type\":\"ping\"}\r\n\r\n".as_slice(),
        b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"partial_json\":\"alias\"}}\n\n".as_slice(),
        b"data: [DONE]\n\n".as_slice(),
    ] {
        assert_eq!(restore_claude_oauth_tool_names_from_stream_line(frame, "", false, &reverse), frame);
    }
}

#[test]
fn declared_tool_and_history_receive_same_mcp_alias() {
    let body = br#"{"tools":[{"name":"fetch_url"}],"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"fetch_url"}]}]}"#;
    let (mapped, reverse) = remap_claude_oauth_tool_names_with_secret(body, "caller-a");
    let root: serde_json::Value = serde_json::from_slice(&mapped).unwrap();
    let alias = root
        .pointer("/tools/0/name")
        .and_then(serde_json::Value::as_str)
        .unwrap();
    assert!(alias.starts_with("mcp__"));
    assert_eq!(
        root.pointer("/messages/0/content/0/name")
            .and_then(serde_json::Value::as_str),
        Some(alias)
    );
    assert_eq!(reverse.get(alias).map(String::as_str), Some("fetch_url"));
}

#[test]
fn typed_custom_tools_are_aliased_but_server_tools_remain_native() {
    let body = br#"{"tools":[{"name":"custom","type":"custom"},{"name":"native","type":"web_search_20250305"}],"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"custom"},{"type":"tool_use","name":"native"}]}]}"#;
    let (mapped, reverse) = remap_claude_oauth_tool_names_with_secret(body, "caller-a");
    let root: serde_json::Value = serde_json::from_slice(&mapped).unwrap();
    let alias = root
        .pointer("/tools/0/name")
        .and_then(serde_json::Value::as_str)
        .unwrap();
    assert!(alias.starts_with("mcp__"));
    assert_eq!(root["tools"][1]["name"], "native");
    assert_eq!(root["messages"][0]["content"][0]["name"], alias);
    assert_eq!(root["messages"][0]["content"][1]["name"], "native");
    assert_eq!(reverse.get(alias).map(String::as_str), Some("custom"));
    assert!(!reverse.values().any(|name| name == "native"));
}

#[test]
fn server_tool_name_protects_ambiguous_history_reference() {
    let body = br#"{"tools":[{"name":"shared","type":"custom"},{"name":"shared","type":"web_search_20250305"}],"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"shared"}]}]}"#;
    let (mapped, reverse) = remap_claude_oauth_tool_names_with_secret(body, "caller-a");
    let root: serde_json::Value = serde_json::from_slice(&mapped).unwrap();
    assert_ne!(root["tools"][0]["name"], "shared");
    assert_eq!(root["tools"][1]["name"], "shared");
    assert_eq!(root["messages"][0]["content"][0]["name"], "shared");
    assert_eq!(reverse.len(), 1);
}
