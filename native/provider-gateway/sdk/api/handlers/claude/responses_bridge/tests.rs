use super::*;
use crate::sdk::api::handlers::openai::openai_responses_api_key_handlers::{
    ApiKeyAccount, ApiKeyAccountPool, OpenAiResponsesApiKeyHandler,
};
use crate::sdk::api::handlers::openai::openai_responses_handlers::{
    OpenAiResponsesHttpResponse, OpenAiResponsesProviderRouter,
};
use crate::sdk::pluginapi::{
    HostHttpClient, HttpRequest, HttpResponse, HttpStreamChunk, HttpStreamResponse, PluginFuture,
};
use serde_json::json;
use std::{collections::BTreeMap, sync::Mutex};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

struct RecordingClient {
    requests: Mutex<Vec<HttpRequest>>,
    body: Vec<u8>,
    chunks: Vec<Vec<u8>>,
}

impl HostHttpClient for RecordingClient {
    fn execute<'a>(&'a self, request: HttpRequest) -> PluginFuture<'a, HttpResponse> {
        self.requests.lock().unwrap().push(request);
        Box::pin(async {
            Ok(HttpResponse {
                status_code: 200,
                headers: BTreeMap::new(),
                body: self.body.clone(),
            })
        })
    }

    fn execute_stream<'a>(&'a self, request: HttpRequest) -> PluginFuture<'a, HttpStreamResponse> {
        self.requests.lock().unwrap().push(request);
        Box::pin(async {
            let (sender, receiver) = mpsc::channel(self.chunks.len().max(1));
            for payload in &self.chunks {
                sender
                    .send(HttpStreamChunk {
                        payload: payload.clone(),
                        error: None,
                    })
                    .await
                    .unwrap();
            }
            Ok(HttpStreamResponse {
                status_code: 200,
                headers: BTreeMap::new(),
                chunks: receiver,
            })
        })
    }
}

fn router(client: Arc<RecordingClient>, provider: &str) -> ClaudeMessagesProviderRouter {
    let account = ApiKeyAccount::new(
        "fixture-account",
        "https://provider.invalid/v1",
        Zeroizing::new("fixture-secret".into()),
        Vec::new(),
        0,
        false,
        client,
    )
    .unwrap();
    let pool = ApiKeyAccountPool::new(
        provider,
        vec![account],
        crate::sdk::translator::builtin::registry(),
    )
    .unwrap();
    let handler = Arc::new(OpenAiResponsesApiKeyHandler::new(Arc::new(pool)));
    let responses = OpenAiResponsesProviderRouter::with_all_handlers(
        provider,
        None,
        None,
        None,
        BTreeMap::from([(provider.into(), handler)]),
        None,
    )
    .unwrap();
    ClaudeMessagesProviderRouter::new(
        provider,
        Some(Arc::new(Native)),
        Some(Arc::new(Native)),
        Arc::new(responses),
    )
}

struct Native;
impl ClaudeMessagesRouteHandler for Native {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>> {
        Box::pin(async move {
            assert!(matches!(provider, Some("claude" | "antigravity")));
            ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::json(
                200,
                body.to_vec(),
            ))
        })
    }
}

fn message(stream: bool) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "model":"MiniMax-M3", "stream":stream, "max_tokens":2048,
        "system":"Work only in the selected project.",
        "messages":[
            {"role":"user","content":"Read sum.js and run its tests."},
            {"role":"assistant","content":[{"type":"tool_use","id":"call_old","name":"read_file","input":{"path":"sum.js"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_old","content":"export const sum = (a,b) => a+b;"}]}
        ],
        "tools":[{"name":"read_file","description":"Read a project file","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]
    })).unwrap()
}

fn client(body: Value, chunks: Vec<Vec<u8>>) -> Arc<RecordingClient> {
    Arc::new(RecordingClient {
        requests: Mutex::new(Vec::new()),
        body: serde_json::to_vec(&body).unwrap(),
        chunks,
    })
}

fn buffered(response: ClaudeMessagesRouteResponse) -> ClaudeMessagesHttpResponse {
    match response {
        ClaudeMessagesRouteResponse::Buffered(response) => response,
        _ => panic!("expected buffered Messages response"),
    }
}

fn events(bytes: &[u8]) -> Vec<Value> {
    let mut decoder = SseDecoder::new();
    let mut frames = decoder.push(bytes);
    frames.extend(decoder.finish());
    frames
        .into_iter()
        .map(|event| serde_json::from_slice(&event.data).unwrap())
        .collect()
}

#[tokio::test]
async fn messages_reaches_each_explicit_api_provider_with_tools_and_usage() {
    for provider in ["minimax", "zai", "kimi", "xai"] {
        let client = client(
            json!({
                "id":"completion", "object":"chat.completion", "model":"MiniMax-M3",
                "choices":[{"index":0,"message":{"role":"assistant","content":"I will inspect the file.","tool_calls":[{"id":"call_next","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"sum.test.js\"}"}}]},"finish_reason":"tool_calls"}],
                "usage":{"prompt_tokens":30,"completion_tokens":12,"total_tokens":42}
            }),
            vec![],
        );
        let router = router(client.clone(), provider);
        let result = buffered(
            router
                .handle_provider_route(Some(provider), &message(false))
                .await,
        );
        assert_eq!(
            result.status(),
            200,
            "{provider}: {}",
            String::from_utf8_lossy(result.body())
        );
        let output: Value = serde_json::from_slice(result.body()).unwrap();
        assert_eq!(output["type"], "message");
        assert_eq!(output["stop_reason"], "tool_use", "{output}");
        let tool = output["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|part| part["type"] == "tool_use")
            .unwrap();
        assert_eq!(tool["name"], "read_file");
        assert_eq!(tool["id"], "call_next");
        assert_eq!(tool["input"]["path"], "sum.test.js");
        assert_eq!(output["usage"]["input_tokens"], 30);
        assert_eq!(output["usage"]["output_tokens"], 12);
        assert!(!String::from_utf8_lossy(result.body()).contains("fixture-secret"));
        let requests = client.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].url,
            "https://provider.invalid/v1/chat/completions"
        );
        let wire: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(wire["model"], "MiniMax-M3");
        assert_eq!(wire["stream"], false);
        assert_eq!(wire["max_tokens"], 2048);
        assert_eq!(wire["tools"][0]["function"]["name"], "read_file");
        let messages = wire["messages"].as_array().unwrap();
        assert!(messages.iter().any(|part| part
            .to_string()
            .contains("Work only in the selected project.")));
        assert!(messages
            .iter()
            .any(|part| part["role"] == "tool" && part["tool_call_id"] == "call_old"));
    }
}

#[tokio::test]
async fn native_routes_are_unchanged_and_unconfigured_provider_does_not_fall_back() {
    let client = client(json!({}), vec![]);
    let router = router(client.clone(), "minimax");
    for provider in ["claude", "antigravity"] {
        let body = message(false);
        assert_eq!(
            buffered(router.handle_provider_route(Some(provider), &body).await).body(),
            body
        );
    }
    let unavailable = buffered(
        router
            .handle_provider_route(Some("not-configured"), &message(false))
            .await,
    );
    assert_eq!(unavailable.status(), 400);
    assert!(String::from_utf8_lossy(unavailable.body())
        .contains("requested provider is not configured"));
    assert!(client.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn fragmented_stream_round_trip_finishes_tool_calls_and_usage() {
    let mut wire = Vec::new();
    for payload in [
        json!({"id":"completion","model":"MiniMax-M3","choices":[{"index":0,"delta":{"role":"assistant","content":"Inspecting."},"finish_reason":null}]}),
        json!({"id":"completion","model":"MiniMax-M3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_next","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]},"finish_reason":null}]}),
        json!({"id":"completion","model":"MiniMax-M3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"sum.test.js\"}"}}]},"finish_reason":null}]}),
        json!({"id":"completion","model":"MiniMax-M3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":30,"completion_tokens":12,"total_tokens":42}}),
    ] {
        wire.extend_from_slice(format!("data: {payload}\r\n\r\n").as_bytes());
    }
    wire.extend_from_slice(b"data: [DONE]\r\n\r\n");
    let client = client(json!({}), wire.chunks(17).map(<[u8]>::to_vec).collect());
    let router = router(client.clone(), "minimax");
    // No explicit provider: the configured default also needs this bridge.
    let result = router.handle_provider_route(None, &message(true)).await;
    let ClaudeMessagesRouteResponse::ResponsesStream(mut stream) = result else {
        panic!("expected stream")
    };
    let mut out = Vec::new();
    while let Some(chunk) = stream.next_chunk().await {
        out.extend(chunk);
    }
    let events = events(&out);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "message_start")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "message_stop")
            .count(),
        1,
        "{}",
        String::from_utf8_lossy(&out)
    );
    assert!(!events.iter().any(|event| event["type"] == "error"));
    assert!(events
        .iter()
        .any(|event| event["content_block"]["type"] == "tool_use"
            && event["content_block"]["id"] == "call_next"));
    let arguments: String = events
        .iter()
        .filter_map(|event| event["delta"]["partial_json"].as_str())
        .collect();
    assert_eq!(
        serde_json::from_str::<Value>(&arguments).unwrap()["path"],
        "sum.test.js"
    );
    assert!(events
        .iter()
        .any(|event| event["delta"]["stop_reason"] == "tool_use"));
    assert!(events
        .iter()
        .any(|event| event["usage"]["output_tokens"] == 12));
}

#[tokio::test]
async fn truncated_stream_is_an_error_not_a_successful_empty_message() {
    let client = client(json!({}), vec![]);
    let router = router(client, "minimax");
    let result = router.handle_provider_route(None, &message(true)).await;
    let ClaudeMessagesRouteResponse::ResponsesStream(mut stream) = result else {
        panic!("expected stream")
    };
    let mut out = Vec::new();
    while let Some(chunk) = stream.next_chunk().await {
        out.extend(chunk);
    }
    let events = events(&out);
    assert!(
        events.iter().any(|event| event["type"] == "error"),
        "{}",
        String::from_utf8_lossy(&out)
    );
    assert!(!events.iter().any(|event| event["type"] == "message_stop"));
}

#[tokio::test]
async fn failed_response_event_is_redacted_and_does_not_emit_success() {
    let upstream =
        OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::json(200, vec![]));
    let mut stream = ClaudeMessagesResponsesStream::new(upstream, "model".into(), vec![], vec![]);
    let frames = stream.decoder.push(b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"fixture-secret\"}}}\n\n");
    stream.translate(frames);
    let out = stream.next_chunk().await.unwrap();
    assert_eq!(events(&out)[0]["type"], "error");
    assert!(!String::from_utf8_lossy(&out).contains("fixture-secret"));
    assert!(stream.next_chunk().await.is_none());
}

struct BufferedProvider {
    status: u16,
    body: Vec<u8>,
}
impl OpenAiResponsesRouteHandler for BufferedProvider {
    fn handle_provider_route<'a>(
        &'a self,
        _: Option<&'a str>,
        _: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = OpenAiResponsesRouteResponse> + Send + 'a>> {
        Box::pin(async move {
            OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::json(
                self.status,
                self.body.clone(),
            ))
        })
    }
}

#[tokio::test]
async fn invalid_or_failed_buffered_responses_cannot_become_empty_success() {
    for body in [
        json!({}),
        json!({"status":"failed","output":[],"error":{"message":"fixture-secret"}}),
        json!({"status":"in_progress","output":[]}),
    ] {
        let router = ClaudeMessagesProviderRouter::new(
            "codex",
            None,
            None,
            Arc::new(BufferedProvider {
                status: 200,
                body: serde_json::to_vec(&body).unwrap(),
            }),
        );
        let response = buffered(router.handle_provider_route(None, &message(false)).await);
        assert_eq!(response.status(), 502);
        let output: Value = serde_json::from_slice(response.body()).unwrap();
        assert_eq!(output["type"], "error");
        assert!(!String::from_utf8_lossy(response.body()).contains("fixture-secret"));
    }
}

#[tokio::test]
async fn unavailable_account_keeps_its_status_and_actionable_error() {
    let router = ClaudeMessagesProviderRouter::new(
        "codex",
        None,
        None,
        Arc::new(BufferedProvider {
            status: 401,
            body: serde_json::to_vec(
                &json!({"error":{"message":"Codex account requires sign-in"}}),
            )
            .unwrap(),
        }),
    );
    let response = buffered(router.handle_provider_route(None, &message(false)).await);
    assert_eq!(response.status(), 401);
    let output: Value = serde_json::from_slice(response.body()).unwrap();
    assert_eq!(output["error"]["type"], "authentication_error");
    assert_eq!(output["error"]["message"], "Codex account requires sign-in");
}

#[tokio::test]
async fn invalid_messages_never_reach_provider() {
    let client = client(json!({}), vec![]);
    let router = router(client.clone(), "minimax");
    for request in [
        br#"{"model":"test","stream":"true","messages":[]}"#.as_slice(),
        br#"{"model":"test"}"#,
        br#"{}"#,
    ] {
        assert_eq!(
            buffered(router.handle_provider_route(None, request).await).status(),
            400
        );
    }
    assert!(client.requests.lock().unwrap().is_empty());
}
