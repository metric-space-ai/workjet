// Origin: Workjet
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

use super::*;
use crate::internal::runtime::executor::xai_executor_request::{
    prepare_xai_responses_body, XaiRequestPolicy,
};
use crate::internal::runtime::executor::xai_executor_response::restore_namespace_tool_calls;

fn guide() -> Value {
    json!({"type":"namespace","name":"mcp__workjet","tools":[{
        "type":"function","name":"workjet_collective_guide","strict":false,
        "parameters":{"properties":{},"anyOf":[
            {"type":"object","properties":{}},
            {"type":"array","items":{"type":"string"}}
        ]}
    }]})
}

#[test]
fn twenty_union_calls_preserve_original_argument_types_history_and_namespace() {
    let mut history = Vec::new();
    for index in 1..=20 {
        let input = if index % 2 == 0 {
            json!(["東京", format!("call-{index}")])
        } else {
            json!({"input":format!("quoted \"{index}\""),"empty":{}})
        };
        let original = guide();
        let prepared = prepare_xai_responses_body(
            &json!({"tools":[original], "input":history})
                .to_string()
                .into_bytes(),
            XaiRequestPolicy {
                model: "grok-4.7",
                stream: true,
                ..Default::default()
            },
        )
        .unwrap();
        let request: Value = serde_json::from_slice(&prepared.body).unwrap();
        assert_eq!(
            request["tools"][0]["parameters"]["properties"]["input"],
            original["tools"][0]["parameters"]
        );
        assert_eq!(
            prepared.boxed_functions,
            BTreeSet::from(["mcp__workjet__workjet_collective_guide".into()])
        );
        let reference = &prepared.namespace_tools["mcp__workjet__workjet_collective_guide"];
        assert_eq!(reference.namespace, "mcp__workjet");
        assert_eq!(reference.name, "workjet_collective_guide");
        for (expected, replay) in history
            .iter()
            .filter(|item| item["type"] == "function_call")
            .zip(
                request["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|item| item["type"] == "function_call"),
            )
        {
            let raw: Value = serde_json::from_str(expected["arguments"].as_str().unwrap()).unwrap();
            let wrapped: Value =
                serde_json::from_str(replay["arguments"].as_str().unwrap()).unwrap();
            assert_eq!(wrapped, json!({"input":raw}));
            assert!(replay.get("namespace").is_none());
        }
        let arguments = json!({"input":input}).to_string();
        let item = json!({"type":"function_call","id":format!("item-{index}"),"call_id":format!("call-{index}"),
            "name":"mcp__workjet__workjet_collective_guide","arguments":arguments});
        let mut adapter = XaiCustomToolAdapter::new(prepared.custom_tools)
            .with_boxed_functions(prepared.boxed_functions);
        let mut added = item.clone();
        added["arguments"] = json!("");
        assert_eq!(
            adapter.apply(json!({"type":"response.output_item.added","item":added}))[0]["item"]
                ["type"],
            "function_call"
        );
        for fragment in arguments.chars() {
            assert!(adapter.apply(json!({"type":"response.function_call_arguments.delta","item_id":format!("item-{index}"),"delta":fragment.to_string()})).is_empty());
        }
        let done = adapter.apply(json!({"type":"response.function_call_arguments.done","item_id":format!("item-{index}"),"arguments":arguments}));
        assert_eq!(done[0]["type"], "response.function_call_arguments.delta");
        assert_eq!(
            serde_json::from_str::<Value>(done[0]["delta"].as_str().unwrap()).unwrap(),
            input
        );
        assert_eq!(
            serde_json::from_str::<Value>(done[1]["arguments"].as_str().unwrap()).unwrap(),
            input
        );
        let completed = adapter.restore_buffered(
            &json!({"type":"response.completed","response":{"output":[item]}})
                .to_string()
                .into_bytes(),
        );
        let restored: Value = serde_json::from_slice(&restore_namespace_tool_calls(
            &completed,
            &prepared.namespace_tools,
        ))
        .unwrap();
        let call = &restored["response"]["output"][0];
        assert_eq!(call["namespace"], "mcp__workjet");
        assert_eq!(call["name"], "workjet_collective_guide");
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            input
        );
        history.push(call.clone());
        history.push(json!({"type":"function_call_output","call_id":format!("call-{index}"),"output":format!("RESULT_{index}")}));
    }
}

#[test]
fn namespace_separators_inside_declared_names_are_not_guessed() {
    let prepared=prepare_xai_responses_body(&json!({"tools":[guide(),{
        "type":"function","name":"mcp__literal__name","parameters":{"type":"object","properties":{}}
    }]}).to_string().into_bytes(), XaiRequestPolicy {model:"grok-4.7",..Default::default()}).unwrap();
    assert_eq!(prepared.namespace_tools.len(), 1);
    let item = json!({"type":"function_call","name":"mcp__literal__name","arguments":"{}"});
    assert_eq!(
        serde_json::from_slice::<Value>(&restore_namespace_tool_calls(
            &item.to_string().into_bytes(),
            &prepared.namespace_tools
        ))
        .unwrap(),
        item
    );
}

#[test]
fn online_web_search_translates_without_widening_explicit_offline_access() {
    let prepared=prepare_xai_responses_body(br#"{"tools":[{"type":"web_search","external_web_access":true},{"type":"web_search","external_web_access":false}]}"#,
        XaiRequestPolicy {model:"grok-4.7",..Default::default()}).unwrap();
    let body: Value = serde_json::from_slice(&prepared.body).unwrap();
    assert_eq!(body["tools"][0], json!({"type":"web_search"}));
    assert_eq!(body["tools"][1]["external_web_access"], false);
}

#[test]
fn invalid_wrapped_arguments_fail_instead_of_reaching_a_harness() {
    let mut adapter =
        XaiCustomToolAdapter::default().with_boxed_functions(BTreeSet::from(["guide".into()]));
    assert_eq!(adapter.apply(json!({"type":"response.output_item.done","item":{"type":"function_call","name":"guide","arguments":"{}"}}))[0]["type"],"response.failed");
}

#[test]
fn twenty_codex_reasoning_replays_omit_only_null_optional_content() {
    let mut history = Vec::new();
    for index in 1..=20 {
        history.push(json!({"type":"reasoning","id":format!("rs-{index}"),
            "summary":[],"content":null,"encrypted_content":format!("opaque-reasoning-{index}")}));
        history.push(json!({"type":"function_call","id":format!("fc-{index}"),
            "name":"exec_command","call_id":format!("call-{index}"),"arguments":"{\"cmd\":\"date\"}"}));
        history.push(
            json!({"type":"function_call_output","id":format!("out-{index}"),
            "call_id":format!("call-{index}"),"output":"successful command result"}),
        );
        let prepared = prepare_xai_responses_body(
            &json!({"input":history}).to_string().into_bytes(),
            XaiRequestPolicy {
                model: "grok-4.7",
                stream: true,
                ..Default::default()
            },
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&prepared.body).unwrap();
        for (expected, actual) in history.iter().zip(body["input"].as_array().unwrap()) {
            let mut normalized = expected.clone();
            if expected["type"] == "reasoning" {
                normalized.as_object_mut().unwrap().remove("content");
            }
            assert_eq!(actual, &normalized);
        }
    }
    let preserved = json!({"type":"reasoning","content":[],"encrypted_content":"opaque"});
    let prepared = prepare_xai_responses_body(
        &json!({"input":[preserved]}).to_string().into_bytes(),
        XaiRequestPolicy {
            model: "grok-4.7",
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&prepared.body).unwrap()["input"][0],
        preserved
    );
}
