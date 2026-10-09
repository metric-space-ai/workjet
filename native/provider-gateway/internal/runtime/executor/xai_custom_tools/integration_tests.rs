use super::super::XaiCustomToolAdapter;
use crate::internal::runtime::executor::{
    xai_executor::{
        XaiHttpRequest, XaiHttpResponse, XaiHttpTransport, XaiStreamResponse,
        XaiStreamingTransport, XaiTransportFuture,
    },
    xai_executor_execute::XaiExecutor,
};
use crate::sdk::cliproxy::executor::{Headers, Options, Request};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

#[derive(Default)]
struct ToolEcho(Mutex<Vec<Value>>);

impl ToolEcho {
    fn frames(&self, request: &XaiHttpRequest) -> Vec<u8> {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["model"], "grok-4.7");
        assert_eq!(body["tools"][0]["type"], "function");
        assert!(body["tools"][0].get("format").is_none());
        let index = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .count()
            + 1;
        for call in body["input"]
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
        self.0.lock().unwrap().push(body);
        let input = format!("text(await tools.exec_command({{cmd:\"printf 'PROXY_MATRIX_{index:02}\\\\n'\"}})); // 東京");
        let arguments = json!({"input":input}).to_string();
        let item = json!({"id":format!("item-{index}"),"type":"function_call","call_id":format!("call-{index}"),"name":"exec","arguments":arguments});
        let mut added = item.clone();
        added["arguments"] = json!("");
        [
            json!({"type":"response.created","response":{"id":format!("response-{index}"),"model":"grok-4.7"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":added}),
            json!({"type":"response.function_call_arguments.delta","item_id":format!("item-{index}"),"delta":arguments}),
            json!({"type":"response.function_call_arguments.done","item_id":format!("item-{index}"),"arguments":arguments}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed","response":{"id":format!("response-{index}"),"status":"completed","output":[item]}}),
        ].iter().map(|event|format!("event: {}\r\ndata: {}\r\n\r\n",event["type"].as_str().unwrap(),event)).collect::<String>().into_bytes()
    }
}

impl XaiHttpTransport for ToolEcho {
    fn execute<'a>(
        &'a self,
        request: &'a XaiHttpRequest,
        _: Duration,
    ) -> XaiTransportFuture<'a, XaiHttpResponse> {
        Box::pin(async move {
            Ok(XaiHttpResponse {
                status: 200,
                headers: Headers::new(),
                body: self.frames(request).into(),
            })
        })
    }
}

impl XaiStreamingTransport for ToolEcho {
    fn execute_stream<'a>(
        &'a self,
        request: &'a XaiHttpRequest,
        _: Duration,
    ) -> XaiTransportFuture<'a, XaiStreamResponse> {
        Box::pin(async move {
            let wire = self.frames(request);
            let (sender, receiver) = mpsc::channel(8);
            tokio::spawn(async move {
                for fragment in wire.chunks(3) {
                    if sender.send(Ok(fragment.to_vec())).await.is_err() {
                        return;
                    }
                }
            });
            Ok(XaiStreamResponse {
                status: 200,
                headers: Headers::new(),
                chunks: receiver,
            })
        })
    }
}

#[tokio::test]
async fn twenty_freeform_tools_round_trip_through_actual_xai_executor_with_fragmented_transport() {
    let transport = Arc::new(ToolEcho::default());
    let executor = XaiExecutor::new(transport.clone(), Duration::from_secs(5))
        .unwrap()
        .with_stream_transport(transport.clone());
    let mut history = Vec::new();
    for index in 1..=20 {
        let request=Request {model:"grok-4.7".into(),payload:serde_json::to_vec(&json!({
            "model":"grok-4.7","input":history,"tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]
        })).unwrap(),..Request::default()};
        let mut response = executor
            .execute_stream(None, &request, &Options::default())
            .await
            .unwrap();
        let mut tool = None;
        let mut completed = false;
        let mut input = String::new();
        while let Some(frame) = response.chunks.recv().await {
            let frame = frame.unwrap();
            assert!(frame.ends_with(b"\n\n"));
            let data = frame
                .split(|byte| *byte == b'\n')
                .find_map(|line| line.strip_prefix(b"data: "))
                .unwrap();
            let event: Value = serde_json::from_slice(data).unwrap();
            if event["type"] == "response.custom_tool_call_input.delta" {
                input.push_str(event["delta"].as_str().unwrap());
            }
            if event["type"] == "response.output_item.done" {
                tool = Some(event["item"].clone());
            }
            if event["type"] == "response.completed" {
                completed = true;
            }
        }
        let tool = tool.unwrap();
        assert_eq!(tool["type"], "custom_tool_call");
        assert_eq!(tool["call_id"], format!("call-{index}"));
        assert_eq!(tool["input"], input);
        assert!(input.contains(&format!("PROXY_MATRIX_{index:02}")));
        assert!(completed);
        history.push(tool);
        history.push(json!({"type":"custom_tool_call_output","call_id":format!("call-{index}"),"output":format!("PROXY_MATRIX_{index:02}\n")}));
    }
    assert_eq!(transport.0.lock().unwrap().len(), 20);
    let request = Request {
        model: "grok-4.7".into(),
        payload: serde_json::to_vec(&json!({
            "input":[],"tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]
        }))
        .unwrap(),
        ..Request::default()
    };
    let buffered = executor
        .execute(None, &request, &Options::default())
        .await
        .unwrap();
    let event: Value = serde_json::from_slice(&buffered.payload).unwrap();
    assert_eq!(event["response"]["output"][0]["type"], "custom_tool_call");
    assert!(event["response"]["output"][0]["input"]
        .as_str()
        .unwrap()
        .contains("PROXY_MATRIX_01"));
}

#[test]
fn truncated_wrapper_produces_failure_instead_of_an_executable_tool() {
    let mut adapter = XaiCustomToolAdapter::new(std::collections::BTreeSet::from(["exec".into()]));
    let result=adapter.apply(json!({"type":"response.output_item.done","item":{"id":"item","type":"function_call","name":"exec","arguments":"{\"input\":\"truncated"}}));
    assert_eq!(result[0]["type"], "response.failed");
}
