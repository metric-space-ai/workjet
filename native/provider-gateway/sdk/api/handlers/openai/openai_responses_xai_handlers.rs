// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

//! `/v1/responses` route for xAI subscription (OAuth) accounts.
//!
//! Wire shape, deliberately the thinnest of the provider routes: Grok's
//! upstream IS OpenAI Responses, so nothing is translated — the pool
//! prepares the body, substitutes the account's OAuth credential, and the
//! frames coming back are already the client's format. Non-stream answers
//! arrive as SSE regardless (`aggregate_responses_sse`), so the buffered
//! path unwraps the aggregated `response.completed` event into the response
//! object the client expects.
//!
//! CREDENTIAL SUBSTITUTION, same structural guarantee as the API-key route:
//! this handler receives only the request *body* — no header parameter
//! exists — and every upstream header is built by the executor from the
//! pool's own `Auth`. An inbound `Authorization` header has no path here.

use std::sync::Arc;

use crate::internal::runtime::executor::xai_executor_execute::XaiExecutionError;
use crate::internal::runtime::executor::xai_subscription_pool::{
    XaiPoolError, XaiSubscriptionAccountPool,
};

use super::openai_responses_handlers::{OpenAiResponsesHttpResponse, OpenAiResponsesRouteResponse};

/// SSE pump for an xAI subscription stream. The executor emits COMPLETE SSE
/// frames — `event:`/`data:` lines plus the blank-line terminator — so the
/// server writes them verbatim, without appending another delimiter.
pub struct OpenAiResponsesXaiStream {
    chunks: tokio::sync::mpsc::Receiver<Result<Vec<u8>, XaiExecutionError>>,
    terminal: bool,
    emitted_failure: bool,
}

impl OpenAiResponsesXaiStream {
    fn new(chunks: tokio::sync::mpsc::Receiver<Result<Vec<u8>, XaiExecutionError>>) -> Self {
        Self {
            chunks,
            terminal: false,
            emitted_failure: false,
        }
    }

    pub async fn next_chunk(&mut self) -> Option<Vec<u8>> {
        if self.terminal {
            return None;
        }
        match self.chunks.recv().await {
            Some(Ok(frame)) => {
                if frame.starts_with(b"event: response.completed\n")
                    || frame.starts_with(b"event: response.incomplete\n")
                    || frame.starts_with(b"event: response.failed\n")
                {
                    self.terminal = true;
                }
                Some(frame)
            }
            Some(Err(_)) => self.failure_chunk(),
            None => {
                self.terminal = true;
                None
            }
        }
    }

    /// One terminal event with fixed copy — never the upstream's own error
    /// text, which can carry account identifiers.
    fn failure_chunk(&mut self) -> Option<Vec<u8>> {
        if self.emitted_failure {
            self.terminal = true;
            return None;
        }
        self.emitted_failure = true;
        self.terminal = true;
        Some(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"upstream_stream_error\",\"message\":\"xAI upstream stream failed\"}}}\n\n"
                .to_vec(),
        )
    }
}

impl std::fmt::Debug for OpenAiResponsesXaiStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesXaiStream")
            .field("terminal", &self.terminal)
            .field("emitted_failure", &self.emitted_failure)
            .finish()
    }
}

pub struct OpenAiResponsesXaiHandler {
    pool: Arc<XaiSubscriptionAccountPool>,
}

impl OpenAiResponsesXaiHandler {
    pub fn new(pool: Arc<XaiSubscriptionAccountPool>) -> Self {
        Self { pool }
    }

    pub async fn handle_route(&self, body: &[u8]) -> OpenAiResponsesRouteResponse {
        let Some((model, stream)) = parse_model_and_stream(body) else {
            return OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::error(
                400,
                "model is required",
            ));
        };
        if stream {
            return match self.pool.execute_stream(&model, body).await {
                Ok(chunks) => OpenAiResponsesRouteResponse::XaiStream(Box::new(
                    OpenAiResponsesXaiStream::new(chunks),
                )),
                Err(error) => OpenAiResponsesRouteResponse::Buffered(pool_error(error)),
            };
        }
        match self.pool.execute(&model, body).await {
            Ok(completed) => match response_object_from_completed_event(&completed) {
                Some(response) => OpenAiResponsesRouteResponse::Buffered(
                    OpenAiResponsesHttpResponse::json(200, response),
                ),
                None => OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::error(
                    502,
                    "xAI upstream returned an invalid completed event",
                )),
            },
            Err(error) => OpenAiResponsesRouteResponse::Buffered(pool_error(error)),
        }
    }
}

impl std::fmt::Debug for OpenAiResponsesXaiHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesXaiHandler")
            .field("pool", &self.pool)
            .finish()
    }
}

/// The pool's non-stream answer is the aggregated `response.completed` EVENT
/// (`{"type":"response.completed","response":{…}}`); a buffered client wants
/// the response object itself.
fn response_object_from_completed_event(completed: &[u8]) -> Option<Vec<u8>> {
    let event = serde_json::from_slice::<serde_json::Value>(completed).ok()?;
    let response = event.get("response")?;
    if !response.is_object() {
        return None;
    }
    serde_json::to_vec(response).ok()
}

/// Bounded, provider-neutral error copy — upstream text is never echoed.
fn pool_error(error: XaiPoolError) -> OpenAiResponsesHttpResponse {
    match error {
        XaiPoolError::Configuration => {
            OpenAiResponsesHttpResponse::error(500, "xAI provider is not configured")
        }
        XaiPoolError::NoAccount => OpenAiResponsesHttpResponse::error(
            503,
            "no xAI account is currently available for this model",
        ),
        XaiPoolError::Auth => {
            OpenAiResponsesHttpResponse::error(502, "xAI credential refresh failed")
        }
        XaiPoolError::Upstream(_) | XaiPoolError::Execution => {
            OpenAiResponsesHttpResponse::error(502, "xAI upstream rejected the request")
        }
    }
}

fn parse_model_and_stream(body: &[u8]) -> Option<(String, bool)> {
    let root = serde_json::from_slice::<serde_json::Value>(body).ok()?;
    let object = root.as_object()?;
    let model = object
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())?;
    Some((
        model.to_owned(),
        object.get("stream").and_then(serde_json::Value::as_bool) == Some(true),
    ))
}

#[cfg(test)]
#[path = "openai_responses_xai_handlers_test.rs"]
mod tests;
