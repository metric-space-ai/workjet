use super::*;
use crate::internal::api::server::serve_provider_connection;
use crate::sdk::api::handlers::claude::code_handlers::{
    ClaudeMessagesHttpResponse, ClaudeMessagesRouteHandler,
};
use serde_json::json;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
struct ToolEcho(Arc<Mutex<Vec<Value>>>);
impl OpenAiResponsesRouteHandler for ToolEcho {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = OpenAiResponsesRouteResponse> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(provider, Some("claude"));
            let request: Value = serde_json::from_slice(body).unwrap();
            let index = request["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["type"] == "function_call_output")
                .count()
                + 1;
            self.0.lock().unwrap().push(request);
            OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::json(200, serde_json::to_vec(&json!({
                "id": format!("response-{index}"), "status": "completed", "model": "claude-opus-5-5",
                "output": [{"type":"function_call", "call_id":format!("call-{index}"), "name":"Bash", "arguments":json!({"command":format!("printf 'PROXY_MATRIX_{index:02}\\n'")}).to_string()}]
            })).unwrap()))
        })
    }
}

#[tokio::test]
async fn twenty_chat_tool_results_round_trip_through_shared_http_listener() {
    let handler = ToolEcho(Arc::new(Mutex::new(Vec::new())));
    let mut messages = vec![json!({"role":"user", "content":"Run the next sequential tool."})];
    for index in 1..=20 {
        let (mut client, mut server) = tokio::io::duplex(128 * 1024);
        let serving_handler = handler.clone();
        let catalog = ClaudeMessagesHttpResponse::json(
            200,
            serde_json::to_vec(&json!({"data":[{"id":"claude-opus-5-5","providers":["claude"]}]}))
                .unwrap(),
        );
        let serving = tokio::spawn(async move {
            serve_provider_connection(
                &mut server,
                &serving_handler,
                None::<&dyn ClaudeMessagesRouteHandler>,
                &catalog,
                None,
            )
            .await
            .unwrap();
        });
        let body = serde_json::to_vec(&json!({
            "model":"claude-opus-5-5", "messages":messages, "stream":false,
            "tools":[{"type":"function","function":{"name":"Bash","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]
        })).unwrap();
        client.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        client.write_all(&body).await.unwrap();
        let mut wire = Vec::new();
        client.read_to_end(&mut wire).await.unwrap();
        serving.await.unwrap();
        assert!(wire.starts_with(b"HTTP/1.1 200 "));
        let split = wire
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let response: Value = serde_json::from_slice(&wire[split + 4..]).unwrap();
        let call = &response["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["id"], format!("call-{index}"));
        assert_eq!(call["function"]["name"], "Bash");
        let arguments: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(
            arguments["command"],
            format!("printf 'PROXY_MATRIX_{index:02}\\n'")
        );
        messages.push(json!({"role":"assistant", "content":null, "tool_calls":[call]}));
        messages.push(json!({"role":"tool","tool_call_id":call["id"],"content":format!("PROXY_MATRIX_{index:02}\n")}));
    }
    let requests = handler.0.lock().unwrap();
    assert_eq!(requests.len(), 20);
    let last = requests.last().unwrap()["input"].as_array().unwrap();
    assert_eq!(
        last.iter()
            .filter(|item| item["type"] == "function_call_output")
            .count(),
        19
    );
    for item in last.iter().filter(|item| item["type"] == "function_call") {
        assert!(serde_json::from_str::<Value>(item["arguments"].as_str().unwrap()).is_ok());
    }
}

#[tokio::test]
async fn fragmented_chat_stream_restores_twenty_tool_calls_and_complete_sse_records() {
    let original =
        serde_json::to_vec(&json!({"tools":[{"type":"function","function":{"name":"Bash"}}]}))
            .unwrap();
    for index in 1..=20 {
        let arguments = json!({"command":format!("printf 'PROXY_MATRIX_{index:02}\\n'"), "literal":"mcp__opaque__Bash 東京"}).to_string();
        let events = [
            json!({"type":"response.created","response":{"id":format!("r-{index}"),"model":"claude-opus-5-5","created_at":1}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"id":"item","type":"function_call","call_id":format!("call-{index}"),"name":"Bash","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"item","delta":arguments}),
            json!({"type":"response.function_call_arguments.done","item_id":"item","arguments":arguments}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"id":"item","type":"function_call","call_id":format!("call-{index}"),"name":"Bash","arguments":arguments}}),
            json!({"type":"response.completed","response":{"status":"completed"}}),
        ];
        let wire = events
            .iter()
            .map(|event| {
                format!(
                    "event: {}\r\ndata: {}\r\n\r\n",
                    event["type"].as_str().unwrap(),
                    event
                )
            })
            .collect::<String>();
        let mut stream = ChatCompletionsResponsesStream {
            upstream: OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::error(
                500, "unused",
            )),
            decoder: SseDecoder::new(),
            state: CodexToChatStreamState::default(),
            model: "claude-opus-5-5".into(),
            original: original.clone(),
            request: Vec::new(),
            pending: VecDeque::new(),
            terminal: false,
        };
        for fragment in wire.as_bytes().chunks(3) {
            let events = stream.decoder.push(fragment);
            stream.translate(events);
        }
        let mut calls = Vec::new();
        let mut emitted_arguments = String::new();
        let mut finished = false;
        let mut done = 0;
        while let Some(frame) = stream.next_chunk().await {
            assert!(frame.starts_with(b"data: ") && frame.ends_with(b"\n\n"));
            let data = &frame[6..frame.len() - 2];
            if data == b"[DONE]" {
                done += 1;
                continue;
            }
            let value: Value = serde_json::from_slice(data).unwrap();
            if let Some(tools) = value
                .pointer("/choices/0/delta/tool_calls")
                .and_then(Value::as_array)
            {
                for tool in tools {
                    if tool.get("id").is_some() {
                        calls.push(tool["id"].clone());
                    }
                    emitted_arguments.push_str(
                        tool.pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    );
                }
            }
            finished |= value
                .pointer("/choices/0/finish_reason")
                .is_some_and(|reason| reason == "tool_calls");
        }
        assert_eq!(calls, vec![json!(format!("call-{index}"))]);
        assert_eq!(emitted_arguments, arguments);
        assert!(finished);
        assert_eq!(done, 1);
    }
}

#[tokio::test]
async fn chat_stream_failure_is_an_error_without_successful_done_sentinel() {
    let mut stream = ChatCompletionsResponsesStream {
        upstream: OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::error(
            500, "unused",
        )),
        decoder: SseDecoder::new(),
        state: CodexToChatStreamState::default(),
        model: "claude-opus-5-5".into(),
        original: Vec::new(),
        request: Vec::new(),
        pending: VecDeque::new(),
        terminal: false,
    };
    let events=stream.decoder.push(b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"private upstream detail\"}}}\n\n");
    stream.translate(events);
    let frame = stream.next_chunk().await.unwrap();
    assert!(String::from_utf8_lossy(&frame).contains("provider upstream stream failed"));
    assert!(!String::from_utf8_lossy(&frame).contains("private upstream detail"));
    assert!(stream.next_chunk().await.is_none());
}
