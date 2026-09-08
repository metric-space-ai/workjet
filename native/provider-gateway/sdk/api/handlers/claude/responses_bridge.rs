// Origin: Workjet
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

use std::{collections::VecDeque, future::Future, pin::Pin, sync::Arc};

use serde_json::Value;

use super::code_handlers::{
    parse_messages_request, ClaudeMessagesHttpResponse, ClaudeMessagesRouteHandler,
    ClaudeMessagesRouteResponse,
};
use crate::internal::translator::codex::claude::{
    convert_claude_request_to_codex, convert_codex_response_to_claude_non_stream,
    convert_codex_response_to_claude_stream, deterministic_claude_message_id,
    CodexToClaudeStreamState,
};
use crate::internal::translator::common::{SseDecoder, SseEvent};
use crate::sdk::api::handlers::openai::openai_responses_handlers::{
    OpenAiResponsesRouteHandler, OpenAiResponsesRouteResponse,
};
use crate::sdk::translator::TranslationContext;

/// Messages is a client protocol, not an instruction to select a Claude account.
/// Keep native subscription routes and share the Responses router for other providers.
pub struct ClaudeMessagesProviderRouter {
    default_provider: String,
    claude: Option<Arc<dyn ClaudeMessagesRouteHandler>>,
    antigravity: Option<Arc<dyn ClaudeMessagesRouteHandler>>,
    responses: Arc<dyn OpenAiResponsesRouteHandler>,
}

impl ClaudeMessagesProviderRouter {
    pub fn new(
        default_provider: &str,
        claude: Option<Arc<dyn ClaudeMessagesRouteHandler>>,
        antigravity: Option<Arc<dyn ClaudeMessagesRouteHandler>>,
        responses: Arc<dyn OpenAiResponsesRouteHandler>,
    ) -> Self {
        Self {
            default_provider: default_provider.trim().to_ascii_lowercase(),
            claude,
            antigravity,
            responses,
        }
    }

    async fn route(&self, provider: Option<&str>, body: &[u8]) -> ClaudeMessagesRouteResponse {
        let provider = provider
            .unwrap_or(&self.default_provider)
            .trim()
            .to_ascii_lowercase();
        let native = match provider.as_str() {
            "claude" => self.claude.as_ref(),
            "antigravity" => self.antigravity.as_ref(),
            _ => None,
        };
        if let Some(native) = native {
            return native.handle_provider_route(Some(&provider), body).await;
        }
        let shape = match parse_messages_request(body) {
            Ok(shape) => shape,
            Err(message) => return buffered_error(400, message),
        };
        let original: Value = match serde_json::from_slice(body) {
            Ok(original) => original,
            Err(_) => return buffered_error(400, "invalid JSON request body"),
        };
        if !original.get("messages").is_some_and(Value::is_array) {
            return buffered_error(400, "messages must be an array");
        }
        let mut request: Value = match serde_json::from_slice(&convert_claude_request_to_codex(
            &shape.model,
            body,
            shape.stream,
        )) {
            Ok(request) => request,
            Err(_) => return buffered_error(500, "Messages request translation failed"),
        };
        // The shared Codex translator defaults to streaming; the route must honor
        // the actual Messages caller, including buffered API clients.
        request["stream"] = Value::Bool(shape.stream);
        for (source, target) in [
            ("max_tokens", "max_output_tokens"),
            ("temperature", "temperature"),
            ("top_p", "top_p"),
        ] {
            if let Some(value) = original.get(source) {
                request[target] = value.clone();
            }
        }
        let request = match serde_json::to_vec(&request) {
            Ok(request) => request,
            Err(_) => return buffered_error(500, "Messages request translation failed"),
        };
        let response = self
            .responses
            .handle_provider_route(Some(&provider), &request)
            .await;
        match response {
            OpenAiResponsesRouteResponse::Buffered(response) => {
                if !(200..300).contains(&response.status()) {
                    // Responses handlers already return bounded, credential-free errors.
                    return buffered_error(
                        response.status(),
                        &String::from_utf8_lossy(response.body()),
                    );
                }
                if shape.stream {
                    return buffered_error(502, "provider did not return the requested stream");
                }
                let valid_response =
                    serde_json::from_slice::<Value>(response.body()).is_ok_and(|value| {
                        let response = value.get("response").unwrap_or(&value);
                        response.get("output").is_some_and(Value::is_array)
                            && matches!(
                                response.get("status").and_then(Value::as_str),
                                Some("completed" | "incomplete")
                            )
                    });
                if !valid_response {
                    return buffered_error(502, "provider did not return a completed response");
                }
                let translated = convert_codex_response_to_claude_non_stream(
                    &TranslationContext::default(),
                    &shape.model,
                    body,
                    &request,
                    response.body(),
                );
                let valid = serde_json::from_slice::<Value>(&translated).is_ok_and(|value| {
                    value.get("type").and_then(Value::as_str) == Some("message")
                        && value.get("content").is_some_and(Value::is_array)
                });
                if !valid {
                    return buffered_error(502, "provider response translation failed");
                }
                ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::json(
                    response.status(),
                    translated,
                ))
            }
            upstream if shape.stream => ClaudeMessagesRouteResponse::ResponsesStream(Box::new(
                ClaudeMessagesResponsesStream::new(upstream, shape.model, body.to_vec(), request),
            )),
            _ => buffered_error(502, "provider returned an unexpected stream"),
        }
    }
}

impl ClaudeMessagesRouteHandler for ClaudeMessagesProviderRouter {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>> {
        Box::pin(self.route(provider, body))
    }
}

fn buffered_error(status: u16, message: &str) -> ClaudeMessagesRouteResponse {
    ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::error(status, message))
}

pub struct ClaudeMessagesResponsesStream {
    upstream: OpenAiResponsesRouteResponse,
    decoder: SseDecoder,
    state: CodexToClaudeStreamState,
    model: String,
    original: Vec<u8>,
    request: Vec<u8>,
    pending: VecDeque<Vec<u8>>,
    terminal: bool,
}

impl ClaudeMessagesResponsesStream {
    fn new(
        upstream: OpenAiResponsesRouteResponse,
        model: String,
        original: Vec<u8>,
        request: Vec<u8>,
    ) -> Self {
        let identity = deterministic_claude_message_id(&model, &original, &request);
        Self {
            upstream,
            decoder: SseDecoder::new(),
            state: CodexToClaudeStreamState::with_identity(identity),
            model,
            original,
            request,
            pending: VecDeque::new(),
            terminal: false,
        }
    }

    pub async fn next_chunk(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some(chunk) = self.pending.pop_front() {
                return Some(chunk);
            }
            if self.terminal {
                return None;
            }
            let (chunk, needs_separator) = match &mut self.upstream {
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
                // Match the framing contract used by the Responses HTTP writer.
                if needs_separator {
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
                // A transport sentinel is not a successful response receipt.
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
            let translated = convert_codex_response_to_claude_stream(
                &TranslationContext::default(),
                &self.model,
                &self.original,
                &self.request,
                &event.data,
                &mut self.state,
            );
            self.pending.extend(translated);
            if matches!(kind, "response.completed" | "response.incomplete") {
                self.terminal = true;
            }
        }
    }

    fn fail(&mut self, message: &str) {
        self.terminal = true;
        let error = ClaudeMessagesHttpResponse::error(502, message);
        let mut frame = b"event: error\ndata: ".to_vec();
        frame.extend_from_slice(error.body());
        frame.extend_from_slice(b"\n\n");
        self.pending.push_back(frame);
    }
}

#[cfg(test)]
mod tests;
