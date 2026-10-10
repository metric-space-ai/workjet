// Origin: Workjet
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

#[cfg(test)]
mod boxed_tests;
#[cfg(test)]
mod integration_tests;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy)]
enum WrappedInput {
    Freeform,
    Json,
}

#[derive(Default)]
pub(super) struct XaiCustomToolAdapter {
    names: BTreeSet<String>,
    boxed_functions: BTreeSet<String>,
    arguments: BTreeMap<String, (WrappedInput, String)>,
}

impl XaiCustomToolAdapter {
    pub(super) fn new(names: BTreeSet<String>) -> Self {
        Self {
            names,
            ..Self::default()
        }
    }

    pub(super) fn with_boxed_functions(mut self, names: BTreeSet<String>) -> Self {
        self.boxed_functions = names;
        self
    }

    /// A wrapped argument must be complete before decoding. Ordinary function
    /// deltas pass through; only freeform and non-object schemas are buffered.
    pub(super) fn apply(&mut self, mut event: Value) -> Vec<Value> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let item_id = event
            .get("item_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if kind == "response.function_call_arguments.delta" && self.arguments.contains_key(&item_id)
        {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                self.arguments.get_mut(&item_id).unwrap().1.push_str(delta);
            }
            return Vec::new();
        }
        if kind == "response.function_call_arguments.done" && self.arguments.contains_key(&item_id)
        {
            let (input_kind, buffered) = &self.arguments[&item_id];
            let arguments = event
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or(buffered);
            let Some(input) = unwrap_input(arguments, *input_kind) else {
                return vec![failure()];
            };
            let mut delta = event.clone();
            delta.as_object_mut().unwrap().remove("arguments");
            delta["type"] = json!("response.function_call_arguments.delta");
            delta["delta"] = json!(input);
            match input_kind {
                WrappedInput::Freeform => {
                    delta["type"] = json!("response.custom_tool_call_input.delta");
                    event["type"] = json!("response.custom_tool_call_input.done");
                    event.as_object_mut().unwrap().remove("arguments");
                    event["input"] = json!(input);
                }
                WrappedInput::Json => event["arguments"] = json!(input),
            }
            return vec![delta, event];
        }
        if matches!(
            kind.as_str(),
            "response.output_item.added" | "response.output_item.done"
        ) {
            if let Some(item) = event.get_mut("item") {
                let added = kind == "response.output_item.added";
                if let Some(input_kind) = self.wrapped_input(item) {
                    if added {
                        if let Some(id) = item.get("id").and_then(Value::as_str) {
                            self.arguments
                                .insert(id.to_owned(), (input_kind, String::new()));
                        }
                    }
                    if !restore_item(item, added, input_kind) {
                        return vec![failure()];
                    }
                }
            }
        }
        if let Some(items) = event
            .pointer_mut("/response/output")
            .and_then(Value::as_array_mut)
        {
            for item in items {
                if let Some(input_kind) = self.wrapped_input(item) {
                    if !restore_item(item, false, input_kind) {
                        return vec![failure()];
                    }
                }
            }
        }
        vec![event]
    }

    fn wrapped_input(&self, item: &Value) -> Option<WrappedInput> {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return None;
        }
        let name = item.get("name")?.as_str()?;
        if self.names.contains(name) {
            Some(WrappedInput::Freeform)
        } else if self.boxed_functions.contains(name) {
            Some(WrappedInput::Json)
        } else {
            None
        }
    }

    pub(super) fn restore_buffered(&mut self, data: &[u8]) -> Vec<u8> {
        let Ok(event) = serde_json::from_slice(data) else {
            return data.to_vec();
        };
        serde_json::to_vec(&self.apply(event).into_iter().next().unwrap_or_else(failure))
            .unwrap_or_default()
    }
}

fn restore_item(item: &mut Value, added: bool, kind: WrappedInput) -> bool {
    let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");
    let input = if added && arguments.is_empty() {
        String::new()
    } else {
        let Some(input) = unwrap_input(arguments, kind) else {
            return false;
        };
        input
    };
    match kind {
        WrappedInput::Freeform => {
            item["type"] = json!("custom_tool_call");
            item.as_object_mut().unwrap().remove("arguments");
            item["input"] = json!(input);
        }
        WrappedInput::Json => item["arguments"] = json!(input),
    }
    true
}

fn unwrap_input(arguments: &str, kind: WrappedInput) -> Option<String> {
    let wrapper = serde_json::from_str::<Value>(arguments).ok()?;
    let input = wrapper.get("input")?;
    match kind {
        WrappedInput::Freeform => input.as_str().map(str::to_owned),
        WrappedInput::Json => Some(input.to_string()),
    }
}

fn failure() -> Value {
    json!({"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_tool_input","message":"xAI returned invalid wrapped tool input"}}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::internal::runtime::executor::xai_executor_request::{
        prepare_xai_responses_body, XaiRequestPolicy,
    };

    #[test]
    fn twenty_freeform_calls_preserve_declarations_inputs_and_replayed_history() {
        let mut history = Vec::new();
        for index in 1..=20 {
            let input=format!("const r = await tools.exec_command({{cmd:\"printf 'PROXY_MATRIX_{index:02}\\\\n'\"}}); text(r); // 東京 \"quoted\"");
            let prepared=prepare_xai_responses_body(&serde_json::to_vec(&json!({
                "tools":[{"type":"custom","name":"exec","description":"Execute JavaScript","format":{"type":"text"}}],
                "input":history
            })).unwrap(), XaiRequestPolicy {model:"grok-4.7",stream:true,..Default::default()}).unwrap();
            let request: Value = serde_json::from_slice(&prepared.body).unwrap();
            assert_eq!(request["tools"][0]["type"], "function");
            assert!(request["tools"][0].get("format").is_none());
            assert_eq!(
                request["tools"][0]["parameters"]["required"],
                json!(["input"])
            );
            assert_eq!(prepared.custom_tools, BTreeSet::from(["exec".into()]));
            for call in request["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["type"] == "function_call")
            {
                assert!(
                    serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap()
                        ["input"]
                        .is_string()
                );
            }
            let arguments = json!({"input":input}).to_string();
            let item = json!({"id":format!("item-{index}"),"type":"function_call","call_id":format!("call-{index}"),"name":"exec","arguments":arguments});
            let mut adapter = XaiCustomToolAdapter::new(prepared.custom_tools);
            let mut added = item.clone();
            added["arguments"] = json!("");
            assert_eq!(
                adapter.apply(json!({"type":"response.output_item.added","item":added}))[0]["item"]
                    ["type"],
                "custom_tool_call"
            );
            for fragment in arguments.chars() {
                assert!(adapter.apply(json!({"type":"response.function_call_arguments.delta","item_id":format!("item-{index}"),"delta":fragment.to_string()})).is_empty());
            }
            let events=adapter.apply(json!({"type":"response.function_call_arguments.done","item_id":format!("item-{index}"),"arguments":arguments}));
            assert_eq!(events[0]["type"], "response.custom_tool_call_input.delta");
            assert_eq!(events[0]["delta"], input);
            assert_eq!(events[1]["input"], input);
            let done = adapter.apply(json!({"type":"response.output_item.done","item":item}));
            assert_eq!(done[0]["item"]["input"], input);
            assert!(done[0]["item"].get("arguments").is_none());
            let buffered: Value = serde_json::from_slice(
                &adapter.restore_buffered(
                    &serde_json::to_vec(
                        &json!({"type":"response.completed","response":{"output":[item]}}),
                    )
                    .unwrap(),
                ),
            )
            .unwrap();
            assert_eq!(buffered["response"]["output"][0]["input"], input);
            history.push(buffered["response"]["output"][0].clone());
            history.push(json!({"type":"custom_tool_call_output","call_id":format!("call-{index}"),"output":format!("PROXY_MATRIX_{index:02}\n")}));
        }
    }

    #[test]
    fn namespace_custom_tools_are_remembered_and_ordinary_functions_remain_untouched() {
        let prepared=prepare_xai_responses_body(br#"{\"tools\":[{\"type\":\"namespace\",\"name\":\"functions\",\"tools\":[{\"type\":\"custom\",\"name\":\"exec\",\"format\":{\"type\":\"text\"}},{\"type\":\"function\",\"name\":\"exec_command\",\"parameters\":{\"type\":\"object\"}}]}],\"input\":[]}"#,XaiRequestPolicy {model:"grok-4.7",..Default::default()}).unwrap();
        assert_eq!(
            prepared.custom_tools,
            BTreeSet::from(["functions__exec".into()])
        );
        let mut adapter = XaiCustomToolAdapter::new(prepared.custom_tools);
        let normal = json!({"type":"response.output_item.done","item":{"type":"function_call","name":"functions__exec_command","arguments":"{\"cmd\":\"mcp__opaque__Bash\"}"}});
        assert_eq!(adapter.apply(normal.clone()), vec![normal]);
        let bad = json!({"type":"response.output_item.done","item":{"type":"function_call","name":"functions__exec","arguments":"invalid"}});
        assert_eq!(adapter.apply(bad)[0]["type"], "response.failed");
    }
}
