// Origin: Workjet
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
use super::{request, response};
use crate::sdk::translator::{TranslationContext, TranslationState};
use serde_json::{json, Value};

fn event(bytes: &[u8]) -> Value {
    let text = std::str::from_utf8(bytes).unwrap();
    serde_json::from_str(
        text.lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap(),
    )
    .unwrap()
}

fn exchange(original: &[u8], arguments: &str) -> Vec<Value> {
    exchange_until_done(original, arguments, true)
}

fn exchange_until_done(original: &[u8], arguments: &str, finish_reason: bool) -> Vec<Value> {
    let mut state: TranslationState = None;
    let context = TranslationContext::default();
    let mut output = Vec::new();
    let mut chunks = vec![
        json!({"id":"source-response","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"source-call","type":"function","function":{"name":"mcp__workjet__guide","arguments":""}}]}}]}),
    ];
    for fragment in arguments.chars() {
        chunks.push(json!({"id":"source-response","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":fragment.to_string()}}]}}]}));
    }
    if finish_reason {
        chunks.push(json!({"id":"source-response","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}));
    }
    for chunk in chunks {
        for bytes in response::convert_openai_chat_completions_response_to_openai_responses(
            &context,
            "kimi-for-coding",
            original,
            original,
            &serde_json::to_vec(&chunk).unwrap(),
            &mut state,
        ) {
            output.push(event(&bytes));
        }
    }
    for bytes in response::convert_openai_chat_completions_response_to_openai_responses(
        &context,
        "kimi-for-coding",
        original,
        original,
        b"data: [DONE]",
        &mut state,
    ) {
        output.push(event(&bytes));
    }
    output
}

#[test]
fn twenty_union_calls_preserve_namespace_inputs_deltas_and_growing_history() {
    let schema = json!({"anyOf":[{"type":"object","properties":{"text":{"type":"string"}}},{"type":"array","items":{"type":"string"}}]});
    let ordinary = json!({"type":"object","properties":{"cmd":{"type":"string"}}});
    let mut history = vec![json!({"role":"user","content":"Run the authorized check"})];
    for n in 1..=20 {
        let original = json!({"model":"kimi-for-coding","tools":[{"type":"namespace","name":"mcp__workjet","tools":[{"type":"function","name":"guide","parameters":schema}]},{"type":"function","name":"exec_command","parameters":ordinary}],"input":history});
        let raw = serde_json::to_vec(&original).unwrap();
        let translated: Value = serde_json::from_slice(
            &request::convert_openai_responses_request_to_openai_chat_completions(
                "kimi-for-coding",
                &raw,
                true,
            ),
        )
        .unwrap();
        assert_eq!(
            translated["tools"][0]["function"]["name"],
            "mcp__workjet__guide"
        );
        assert_eq!(
            translated["tools"][0]["function"]["parameters"]["type"],
            "object"
        );
        assert_eq!(
            translated["tools"][0]["function"]["parameters"]["properties"]["input"],
            schema
        );
        assert_eq!(translated["tools"][1]["function"]["parameters"], ordinary);
        for message in translated["messages"].as_array().unwrap() {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let arguments: Value =
                        serde_json::from_str(call["function"]["arguments"].as_str().unwrap())
                            .unwrap();
                    assert!(arguments.get("input").is_some());
                }
            }
        }
        let input = if n % 2 == 0 {
            json!([format!("PROXY_MATRIX_{n:02}"), "東京"])
        } else {
            json!({"text":format!("PROXY_MATRIX_{n:02} 東京")})
        };
        let wrapped = json!({"input":input}).to_string();
        let events = exchange(&raw, &wrapped);
        assert!(!events.iter().any(|e| e["type"] == "response.failed"));
        let deltas: String = events
            .iter()
            .filter(|e| e["type"] == "response.function_call_arguments.delta")
            .map(|e| e["delta"].as_str().unwrap())
            .collect();
        assert_eq!(deltas, input.to_string());
        let done = events
            .iter()
            .find(|e| e["type"] == "response.function_call_arguments.done")
            .unwrap();
        assert_eq!(done["arguments"], input.to_string());
        let completed = events
            .iter()
            .find(|e| e["type"] == "response.completed")
            .unwrap();
        let call = completed["response"]["output"][0].clone();
        assert_eq!(call["type"], "function_call");
        assert_eq!(call["name"], "guide");
        assert_eq!(call["namespace"], "mcp__workjet");
        assert_eq!(call["call_id"], "source-call");
        assert_eq!(call["arguments"], input.to_string());
        let nonstream = json!({"id":"source-response","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"source-call","type":"function","function":{"name":"mcp__workjet__guide","arguments":wrapped}}]}}]});
        let mut state: TranslationState = None;
        let reply: Value = serde_json::from_slice(
            &response::convert_openai_chat_completions_response_to_openai_responses_non_stream(
                &TranslationContext::default(),
                "kimi-for-coding",
                &raw,
                &raw,
                &serde_json::to_vec(&nonstream).unwrap(),
                &mut state,
            ),
        )
        .unwrap();
        assert_eq!(reply["output"][0]["arguments"], input.to_string());
        assert_eq!(reply["output"][0]["namespace"], "mcp__workjet");
        history.push(call);
        history.push(json!({"type":"function_call_output","call_id":"source-call","output":format!("PROXY_MATRIX_{n:02}\\n")}));
    }
}

#[test]
fn malformed_wrapped_input_fails_without_publishing_a_completed_call() {
    let original=serde_json::to_vec(&json!({"tools":[{"type":"namespace","name":"mcp__workjet","tools":[{"type":"function","name":"guide","parameters":{"type":"array","items":{"type":"string"}}}]}]})).unwrap();
    let events = exchange(&original, r#"{"wrong":"input"}"#);
    assert!(events.iter().any(|e| e["type"] == "response.failed"));
    assert!(!events
        .iter()
        .any(|e| e["type"] == "response.completed" || e["type"] == "response.output_item.done"));
}

#[test]
fn ordinary_object_tools_keep_their_original_argument_shape() {
    let original=serde_json::to_vec(&json!({"tools":[{"type":"namespace","name":"mcp__workjet","tools":[{"type":"function","name":"guide","parameters":{"type":"object","properties":{"input":{"type":"string"}}}}]}]})).unwrap();
    let arguments = r#"{"input":"already an ordinary object"}"#;
    let events = exchange(&original, arguments);
    let done = events
        .iter()
        .find(|e| e["type"] == "response.function_call_arguments.done")
        .unwrap();
    assert_eq!(done["arguments"], arguments);
}

#[test]
fn terminal_done_unwraps_or_rejects_without_a_finish_reason() {
    let original = serde_json::to_vec(&json!({"tools":[{"type":"namespace","name":"mcp__workjet","tools":[{"type":"function","name":"guide","parameters":{"type":"array","items":{"type":"string"}}}]}]})).unwrap();
    let events = exchange_until_done(&original, r#"{"input":["valid"]}"#, false);
    let done = events
        .iter()
        .find(|e| e["type"] == "response.function_call_arguments.done")
        .unwrap();
    assert_eq!(done["arguments"], r#"["valid"]"#);
    let completed = events
        .iter()
        .find(|e| e["type"] == "response.completed")
        .unwrap();
    assert_eq!(
        completed["response"]["output"][0]["arguments"],
        r#"["valid"]"#
    );
    let invalid = exchange_until_done(&original, r#"{"wrong":"input"}"#, false);
    assert!(invalid.iter().any(|e| e["type"] == "response.failed"));
    assert!(!invalid.iter().any(|e| e["type"] == "response.completed"));
}
