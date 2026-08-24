// ref: sdk/api/handlers/claude/code_handlers.go @ a88197f845c979132c8978ea223c6af05cc81536
// Port-Status: adapted_to_ctox
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::internal::cache::SignatureKvStore;
use crate::internal::client::claude::models::{
    build_response, resolve_claude_model_id_prefix, ClaudeModel,
};
use crate::internal::runtime::executor::{
    AntigravityAccountPoolError, AntigravityExecutionError, AntigravitySubscriptionAccountPool,
    AntigravityTrackedResponsesStream, ClaudeAccountPoolError, ClaudeSubscriptionAccountPool,
    ClaudeTrackedMessagesStreamResponse,
};

pub type ClaudeAntigravityCapabilityResolver =
    Arc<dyn Fn(&str, &str) -> bool + Send + Sync + 'static>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeMessagesHttpResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl ClaudeMessagesHttpResponse {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn content_type(&self) -> &'static str {
        self.content_type
    }

    pub fn body(&self) -> &[u8] {
        &self.body
    }

    fn json(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: "application/json",
            body,
        }
    }

    pub(crate) fn error(status: u16, message: &str) -> Self {
        let payload = claude_error_response(status, Some(message));
        Self::json(
            status,
            serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec()),
        )
    }

    #[cfg(test)]
    fn upstream_error(status: u16, error_text: &str) -> Self {
        Self::error(status, error_text)
    }
}

// ref: sdk/api/handlers/claude/code_handlers.go:119-129
pub fn claude_models_response(
    available_models: &[ClaudeModel],
    disable_cloaking: bool,
) -> ClaudeMessagesHttpResponse {
    let response = build_response(available_models, disable_cloaking);
    ClaudeMessagesHttpResponse::json(
        200,
        serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec()),
    )
}

// ref: sdk/api/handlers/claude/code_handlers.go:334-449
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ClaudeErrorDetail {
    #[serde(rename = "type")]
    error_type: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ClaudeErrorResponse {
    #[serde(rename = "type")]
    response_type: &'static str,
    error: ClaudeErrorDetail,
}

fn claude_error_response(status: u16, error_text: Option<&str>) -> ClaudeErrorResponse {
    let fallback = status_text(status);
    let text = error_text
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(fallback);
    let (error_type, message) = claude_error_detail_from_text(status, text);
    ClaudeErrorResponse {
        response_type: "error",
        error: ClaudeErrorDetail {
            error_type,
            message,
        },
    }
}

fn claude_error_detail_from_text(status: u16, error_text: &str) -> (String, String) {
    let mut message = error_text.trim().to_owned();
    if message.is_empty() {
        message = status_text(status).to_owned();
    }
    let mut error_type = claude_error_type_from_status(status).to_owned();

    if let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(&message) {
        if let Some(Value::Object(error)) = payload.get("error") {
            if let Some(value) = non_empty_json_string(error.get("type")) {
                error_type = value.to_owned();
            }
            if let Some(value) = non_empty_json_string(error.get("message"))
                .or_else(|| non_empty_json_string(error.get("code")))
            {
                message = value.to_owned();
            }
        } else {
            if let Some(value) =
                non_empty_json_string(payload.get("type")).filter(|value| *value != "error")
            {
                error_type = value.to_owned();
            }
            if let Some(value) = non_empty_json_string(payload.get("message")) {
                message = value.to_owned();
            }
        }
    }

    (error_type, message)
}

fn non_empty_json_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn claude_error_type_from_status(status: u16) -> &'static str {
    match status {
        401 => "authentication_error",
        402 => "billing_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        504 => "timeout_error",
        529 => "overloaded_error",
        500.. => "api_error",
        _ => "invalid_request_error",
    }
}

fn status_text(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        529 => "Overloaded",
        _ if status >= 500 => "Internal Server Error",
        _ => "Bad Request",
    }
}

pub enum ClaudeMessagesRouteResponse {
    Buffered(ClaudeMessagesHttpResponse),
    Stream(Box<ClaudeMessagesAntigravityStream>),
    /// Passthrough stream from a Claude-subscription account. Unlike the
    /// Antigravity variant nothing is translated: the upstream already speaks
    /// the Messages SSE shape, which is exactly what the caller asked for.
    ClaudeStream(Box<ClaudeMessagesClaudeStream>),
}

pub struct ClaudeMessagesAntigravityStream {
    upstream: AntigravityTrackedResponsesStream,
    terminal: bool,
    emitted_failure: bool,
}

impl ClaudeMessagesAntigravityStream {
    fn new(upstream: AntigravityTrackedResponsesStream) -> Self {
        Self {
            upstream,
            terminal: false,
            emitted_failure: false,
        }
    }

    pub async fn next_chunk(&mut self) -> Option<Vec<u8>> {
        if self.terminal {
            return None;
        }
        match self.upstream.next_event().await {
            Some(Ok(chunk)) => {
                if chunk.starts_with(b"event: message_stop\n") {
                    self.terminal = true;
                }
                Some(chunk)
            }
            Some(Err(_)) if !self.emitted_failure => {
                self.emitted_failure = true;
                self.terminal = true;
                Some(b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Antigravity upstream stream failed\"}}\n\n".to_vec())
            }
            Some(Err(_)) | None => {
                self.terminal = true;
                None
            }
        }
    }
}

impl std::fmt::Debug for ClaudeMessagesAntigravityStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClaudeMessagesAntigravityStream")
            .field("upstream", &"[REDACTED]")
            .field("terminal", &self.terminal)
            .field("emitted_failure", &self.emitted_failure)
            .finish()
    }
}

/// Claude Messages SSE relay from a Claude-subscription account.
///
/// The tracked response already yields complete Anthropic SSE frames (tool
/// names restored, usage published), so the relay only forwards frames and
/// terminates cleanly on `message_stop` — mirroring the Antigravity relay
/// above, without its translation layer.
pub struct ClaudeMessagesClaudeStream {
    upstream: ClaudeTrackedMessagesStreamResponse,
    terminal: bool,
    emitted_failure: bool,
}

impl ClaudeMessagesClaudeStream {
    fn new(upstream: ClaudeTrackedMessagesStreamResponse) -> Self {
        Self {
            upstream,
            terminal: false,
            emitted_failure: false,
        }
    }

    pub async fn next_chunk(&mut self) -> Option<Vec<u8>> {
        if self.terminal {
            return None;
        }
        match self.upstream.next_chunk().await {
            Some(Ok(chunk)) => {
                if chunk.starts_with(b"event: message_stop\n") {
                    self.terminal = true;
                }
                Some(chunk)
            }
            Some(Err(_)) if !self.emitted_failure => {
                self.emitted_failure = true;
                self.terminal = true;
                Some(b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Claude upstream stream failed\"}}\n\n".to_vec())
            }
            Some(Err(_)) | None => {
                self.terminal = true;
                None
            }
        }
    }
}

impl std::fmt::Debug for ClaudeMessagesClaudeStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClaudeMessagesClaudeStream")
            .field("upstream", &"[REDACTED]")
            .field("terminal", &self.terminal)
            .field("emitted_failure", &self.emitted_failure)
            .finish()
    }
}

fn claude_pool_error_response(error: ClaudeAccountPoolError) -> ClaudeMessagesHttpResponse {
    // Coarse on purpose: the pool error carries account identity and auth
    // internals a provider response must not leak. 503 says "not this
    // request's fault", 502 says "upstream broke", and that is all a caller
    // can act on.
    let (status, message) = match error {
        ClaudeAccountPoolError::Configuration | ClaudeAccountPoolError::Routing(_) => {
            (503, "no Claude account is currently available")
        }
        ClaudeAccountPoolError::Execution(_) => (502, "Claude upstream request failed"),
        ClaudeAccountPoolError::OutcomePersistence => (502, "Claude outcome persistence failed"),
    };
    ClaudeMessagesHttpResponse::error(status, message)
}

/// Claude Messages route backed by the CLAUDE subscription pool.
///
/// This is the route a gateway-routed Claude Code CLI actually calls
/// (`ANTHROPIC_BASE_URL` + `/v1/messages`). Until it existed the host served
/// Claude accounts only through the OpenAI Responses shape, so a routed CLI
/// got 404 and reported it as a model problem — measured 2026-08-24.
pub struct ClaudeMessagesClaudeHandler {
    pool: Arc<ClaudeSubscriptionAccountPool>,
}

impl ClaudeMessagesClaudeHandler {
    pub fn new(pool: Arc<ClaudeSubscriptionAccountPool>) -> Self {
        Self { pool }
    }

    pub async fn handle_route(&self, body: &[u8]) -> ClaudeMessagesRouteResponse {
        let request = match parse_messages_request(body) {
            Ok(request) => request,
            Err(message) => {
                return ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::error(
                    400, message,
                ));
            }
        };
        if request.stream {
            let outcome = self
                .pool
                .execute_stream_configured(&request.model, body.to_vec())
                .await;
            return match outcome {
                Ok(outcome) => ClaudeMessagesRouteResponse::ClaudeStream(Box::new(
                    ClaudeMessagesClaudeStream::new(outcome.into_outcome().into_response()),
                )),
                Err(error) => {
                    ClaudeMessagesRouteResponse::Buffered(claude_pool_error_response(error))
                }
            };
        }
        match self
            .pool
            .execute_configured(&request.model, body.to_vec(), false)
            .await
        {
            Ok(outcome) => {
                let upstream = outcome.outcome().response();
                ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::json(
                    upstream.status(),
                    upstream.body().to_vec(),
                ))
            }
            Err(error) => ClaudeMessagesRouteResponse::Buffered(claude_pool_error_response(error)),
        }
    }
}

impl std::fmt::Debug for ClaudeMessagesClaudeHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClaudeMessagesClaudeHandler")
            .field("pool", &"ClaudeSubscriptionAccountPool")
            .finish()
    }
}

impl ClaudeMessagesRouteHandler for ClaudeMessagesClaudeHandler {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>> {
        Box::pin(async move {
            if provider.is_some_and(|provider| !provider.eq_ignore_ascii_case("claude")) {
                return ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::error(
                    400,
                    "requested provider is not configured",
                ));
            }
            self.handle_route(body).await
        })
    }
}

pub trait ClaudeMessagesRouteHandler: Send + Sync {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>>;
}

impl<T> ClaudeMessagesRouteHandler for Arc<T>
where
    T: ClaudeMessagesRouteHandler + ?Sized,
{
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>> {
        (**self).handle_provider_route(provider, body)
    }
}

/// Claude Messages route backed by the Antigravity subscription pool. Model
/// and provider remain separate inputs; capability and credential selection
/// stay behind the account-scoped pool boundary.
pub struct ClaudeMessagesAntigravityHandler {
    pool: Arc<AntigravitySubscriptionAccountPool>,
    signature_store: Option<Arc<dyn SignatureKvStore>>,
    capabilities: ClaudeAntigravityCapabilityResolver,
}

impl ClaudeMessagesAntigravityHandler {
    pub fn new(
        pool: Arc<AntigravitySubscriptionAccountPool>,
        signature_store: Option<Arc<dyn SignatureKvStore>>,
        capabilities: ClaudeAntigravityCapabilityResolver,
    ) -> Self {
        Self {
            pool,
            signature_store,
            capabilities,
        }
    }

    pub async fn handle_route(&self, body: &[u8]) -> ClaudeMessagesRouteResponse {
        let rewritten_body = rewrite_claude_dd_model_in_body(body);
        let body = rewritten_body.as_slice();
        let request = match parse_messages_request(body) {
            Ok(request) => request,
            Err(message) => {
                return ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::error(
                    400, message,
                ));
            }
        };
        let capabilities = Arc::clone(&self.capabilities);
        if request.stream {
            let outcome = self
                .pool
                .execute_claude_stream_configured(
                    &request.model,
                    body.to_vec(),
                    self.signature_store.clone(),
                    move |auth_id, model| capabilities(auth_id, model),
                )
                .await;
            return match outcome {
                Ok(outcome) => ClaudeMessagesRouteResponse::Stream(Box::new(
                    ClaudeMessagesAntigravityStream::new(outcome.into_response()),
                )),
                Err(error) => ClaudeMessagesRouteResponse::Buffered(pool_error_response(error)),
            };
        }
        let outcome = self
            .pool
            .execute_claude_non_stream_configured(
                &request.model,
                body.to_vec(),
                self.signature_store.as_deref(),
                move |auth_id, model| capabilities(auth_id, model),
            )
            .await;
        match outcome {
            Ok(outcome) => ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::json(
                200,
                outcome.outcome().payload().to_vec(),
            )),
            Err(error) => ClaudeMessagesRouteResponse::Buffered(pool_error_response(error)),
        }
    }
}

impl ClaudeMessagesRouteHandler for ClaudeMessagesAntigravityHandler {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>> {
        Box::pin(async move {
            if provider.is_some_and(|provider| !provider.eq_ignore_ascii_case("antigravity")) {
                return ClaudeMessagesRouteResponse::Buffered(ClaudeMessagesHttpResponse::error(
                    400,
                    "requested provider is not configured",
                ));
            }
            self.handle_route(body).await
        })
    }
}

impl std::fmt::Debug for ClaudeMessagesAntigravityHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClaudeMessagesAntigravityHandler")
            .field("pool", &"AntigravitySubscriptionAccountPool")
            .field(
                "signature_store",
                &self.signature_store.as_ref().map(|_| "attached"),
            )
            .field("capabilities", &"account-scoped resolver")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaudeMessagesRequestShape {
    model: String,
    stream: bool,
}

fn parse_messages_request(body: &[u8]) -> Result<ClaudeMessagesRequestShape, &'static str> {
    let root = serde_json::from_slice::<Value>(body).map_err(|_| "invalid JSON request body")?;
    let object = root
        .as_object()
        .ok_or("request body must be a JSON object")?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .ok_or("model is required")?;
    let stream = match object.get("stream") {
        Some(Value::Bool(stream)) => *stream,
        Some(_) => return Err("stream must be a boolean"),
        None => false,
    };
    Ok(ClaudeMessagesRequestShape {
        model: model.to_owned(),
        stream,
    })
}

// ref: sdk/api/handlers/claude/code_handlers.go:105-117
fn rewrite_claude_dd_model_in_body(body: &[u8]) -> Vec<u8> {
    let Ok(mut root) = serde_json::from_slice::<Value>(body) else {
        return body.to_vec();
    };
    let Some(model) = root.get("model").and_then(Value::as_str) else {
        return body.to_vec();
    };
    let resolved = resolve_claude_model_id_prefix(model);
    if resolved == model {
        return body.to_vec();
    }
    let Some(object) = root.as_object_mut() else {
        return body.to_vec();
    };
    object.insert("model".to_owned(), Value::String(resolved));
    serde_json::to_vec(&root).unwrap_or_else(|_| body.to_vec())
}

fn pool_error_response(error: AntigravityAccountPoolError) -> ClaudeMessagesHttpResponse {
    let (status, message) = match error {
        AntigravityAccountPoolError::Routing(_)
        | AntigravityAccountPoolError::CapabilityUnavailable => {
            (503, "no Antigravity account is currently available")
        }
        AntigravityAccountPoolError::Translation(_) => {
            (503, "Antigravity request dependency is unavailable")
        }
        AntigravityAccountPoolError::Execution(AntigravityExecutionError::Http {
            status, ..
        }) => (
            if (400..600).contains(&status) {
                status
            } else {
                502
            },
            "Antigravity upstream rejected the request",
        ),
        AntigravityAccountPoolError::Execution(_) => (502, "Antigravity upstream transport failed"),
        AntigravityAccountPoolError::OutcomePersistence => {
            (503, "Antigravity account outcome could not be persisted")
        }
        AntigravityAccountPoolError::Configuration => {
            (500, "Antigravity runtime is not configured")
        }
    };
    ClaudeMessagesHttpResponse::error(status, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_shape_requires_model_and_boolean_stream() {
        assert_eq!(
            parse_messages_request(br#"{"model":" claude-sonnet ","stream":true}"#).unwrap(),
            ClaudeMessagesRequestShape {
                model: "claude-sonnet".to_owned(),
                stream: true,
            }
        );
        assert_eq!(
            parse_messages_request(br#"{"model":"x","stream":"yes"}"#),
            Err("stream must be a boolean")
        );
        assert_eq!(
            parse_messages_request(br#"{"messages":[]}"#),
            Err("model is required")
        );
    }

    #[test]
    fn errors_use_redacted_claude_envelope() {
        let response = pool_error_response(AntigravityAccountPoolError::Execution(
            AntigravityExecutionError::Http {
                status: 429,
                retry_after: Some("provider-secret".to_owned()),
            },
        ));
        assert_eq!(response.status(), 429);
        let body: Value = serde_json::from_slice(response.body()).unwrap();
        assert_eq!(body["type"], "error");
        assert_eq!(body["error"]["type"], "rate_limit_error");
        assert!(!String::from_utf8_lossy(response.body()).contains("provider-secret"));
    }
}

#[cfg(test)]
#[path = "code_handlers_error_test.rs"]
mod code_handlers_error_test;

#[cfg(test)]
#[path = "code_handlers_model_test.rs"]
mod code_handlers_model_test;
