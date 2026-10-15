// Origin: Workjet
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

use super::openai_responses_handlers::{
    OpenAiResponsesHttpResponse, OpenAiResponsesRouteHandler, OpenAiResponsesRouteResponse,
};
use crate::internal::translator::codex::openai::chat_completions::{
    convert_codex_response_to_openai_chat_non_stream, convert_codex_response_to_openai_chat_stream,
    convert_openai_chat_request_to_codex, CodexToChatStreamState,
};
use crate::internal::translator::common::{SseDecoder, SseEvent};
use serde_json::Value;
use std::collections::VecDeque;

pub enum ChatCompletionsRouteResponse {
    Buffered(OpenAiResponsesHttpResponse),
    Stream(Box<ChatCompletionsResponsesStream>),
}

/// Chat Completions is a client protocol. Account selection belongs to the
/// shared Responses router, including subscription and API-key accounts.
pub async fn route_chat_completions<H: OpenAiResponsesRouteHandler + ?Sized>(
    handler: &H,
    provider: Option<&str>,
    body: &[u8],
) -> ChatCompletionsRouteResponse {
    let original: Value = match serde_json::from_slice(body) {
        Ok(Value::Object(object)) => Value::Object(object),
        _ => return error(400, "invalid JSON request body"),
    };
    let Some(model) = original
        .get("model")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
    else {
        return error(400, "model must be a non-empty string");
    };
    if !original.get("messages").is_some_and(Value::is_array) {
        return error(400, "messages must be an array");
    }
    let stream = match original.get("stream") {
        None => false,
        Some(Value::Bool(stream)) => *stream,
        _ => return error(400, "stream must be a boolean"),
    };
    let mut request: Value =
        match serde_json::from_slice(&convert_openai_chat_request_to_codex(model, body, stream)) {
            Ok(request) => request,
            Err(_) => return error(500, "Chat Completions request translation failed"),
        };
    for (source, target) in [
        ("max_tokens", "max_output_tokens"),
        ("max_completion_tokens", "max_output_tokens"),
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("parallel_tool_calls", "parallel_tool_calls"),
    ] {
        if let Some(value) = original.get(source) {
            request[target] = value.clone();
        }
    }
    let request = match serde_json::to_vec(&request) {
        Ok(request) => request,
        Err(_) => return error(500, "Chat Completions request translation failed"),
    };
    match handler.handle_provider_route(provider, &request).await {
        OpenAiResponsesRouteResponse::Buffered(response) => {
            if !(200..300).contains(&response.status()) {
                return ChatCompletionsRouteResponse::Buffered(response);
            }
            if stream {
                return error(502, "provider did not return the requested stream");
            }
            let value: Value = match serde_json::from_slice(response.body()) {
                Ok(value) => value,
                Err(_) => return error(502, "provider returned an invalid response"),
            };
            let wrapped = if value.get("response").is_some() {
                value
            } else {
                let kind = match value.get("status").and_then(Value::as_str) {
                    Some("completed") => "response.completed",
                    Some("incomplete") => "response.incomplete",
                    _ => return error(502, "provider did not return a completed response"),
                };
                serde_json::json!({"type": kind, "response": value})
            };
            let translated = convert_codex_response_to_openai_chat_non_stream(
                body,
                &request,
                &serde_json::to_vec(&wrapped).unwrap_or_default(),
            );
            if !serde_json::from_slice::<Value>(&translated)
                .is_ok_and(|value| value.get("choices").is_some_and(Value::is_array))
            {
                return error(502, "provider response translation failed");
            }
            ChatCompletionsRouteResponse::Buffered(OpenAiResponsesHttpResponse::json(
                response.status(),
                translated,
            ))
        }
        upstream if stream => {
            ChatCompletionsRouteResponse::Stream(Box::new(ChatCompletionsResponsesStream {
                upstream,
                decoder: SseDecoder::new(),
                state: CodexToChatStreamState::default(),
                model: model.to_owned(),
                original: body.to_vec(),
                request,
                pending: VecDeque::new(),
                terminal: false,
            }))
        }
        _ => error(502, "provider returned an unexpected stream"),
    }
}

fn error(status: u16, message: &str) -> ChatCompletionsRouteResponse {
    ChatCompletionsRouteResponse::Buffered(OpenAiResponsesHttpResponse::error(status, message))
}

pub struct ChatCompletionsResponsesStream {
    upstream: OpenAiResponsesRouteResponse,
    decoder: SseDecoder,
    state: CodexToChatStreamState,
    model: String,
    original: Vec<u8>,
    request: Vec<u8>,
    pending: VecDeque<Vec<u8>>,
    terminal: bool,
}

impl ChatCompletionsResponsesStream {
    pub async fn next_chunk(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some(chunk) = self.pending.pop_front() {
                return Some(chunk);
            }
            if self.terminal {
                return None;
            }
            let (chunk, separator) = match &mut self.upstream {
                OpenAiResponsesRouteResponse::Stream(stream) => (stream.next_chunk().await, true),
                OpenAiResponsesRouteResponse::AntigravityStream(stream) => {
                    (stream.next_chunk().await, true)
                }
                OpenAiResponsesRouteResponse::ApiKeyStream(stream) => {
                    (stream.next_chunk().await, true)
                }
                OpenAiResponsesRouteResponse::CodexStream(stream) => {
                    (stream.next_chunk().await, false)
                }
                OpenAiResponsesRouteResponse::XaiStream(stream) => {
                    (stream.next_chunk().await, false)
                }
                OpenAiResponsesRouteResponse::Buffered(_) => (None, false),
            };
            if let Some(mut chunk) = chunk {
                if separator {
                    chunk.extend_from_slice(b"\n\n");
                }
                let events = self.decoder.push(&chunk);
                self.translate(events);
            } else {
                let events = self.decoder.finish();
                self.translate(events);
                if !self.terminal {
                    self.fail("provider stream ended before completion");
                }
            }
        }
    }

    fn translate(&mut self, events: Vec<SseEvent>) {
        for event in events {
            if self.terminal {
                break;
            }
            if event.data == b"[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&event.data) else {
                self.fail("provider returned an invalid stream event");
                break;
            };
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(kind, "response.failed" | "error") {
                self.fail("provider upstream stream failed");
                break;
            }
            let mut line = b"data: ".to_vec();
            line.extend_from_slice(&event.data);
            for chunk in convert_codex_response_to_openai_chat_stream(
                &self.model,
                &self.original,
                &self.request,
                &line,
                &mut self.state,
            ) {
                // The translator returns JSON payloads, not complete SSE frames.
                let mut frame = b"data: ".to_vec();
                frame.extend_from_slice(&chunk);
                frame.extend_from_slice(b"\n\n");
                self.pending.push_back(frame);
            }
            if matches!(kind, "response.completed" | "response.incomplete") {
                self.terminal = true;
                self.pending.push_back(b"data: [DONE]\n\n".to_vec());
            }
        }
    }

    fn fail(&mut self, message: &str) {
        self.terminal = true;
        let mut frame = b"data: ".to_vec();
        frame.extend_from_slice(OpenAiResponsesHttpResponse::error(502, message).body());
        frame.extend_from_slice(b"\n\n");
        self.pending.push_back(frame);
    }
}

#[cfg(test)]
mod tests;
