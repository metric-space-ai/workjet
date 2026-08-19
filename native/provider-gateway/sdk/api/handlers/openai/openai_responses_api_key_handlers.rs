// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

//! `/v1/responses` route for API-key provider accounts.
//!
//! Scope and wire shape (deliberately narrow, see
//! [`crate::internal::config::API_KEY_PROVIDERS`]):
//!
//! * inbound: OpenAI Responses, exactly like every other provider route;
//! * upstream: OpenAI Chat Completions at `{base_url}/chat/completions`,
//!   because the ported [`OpenAiCompatExecutor`] is the executor and the
//!   builtin translator registry already registers `openai-response -> openai`
//!   in both directions;
//! * credential: the pool's own resolved API key, set by the executor as
//!   `Authorization: Bearer <key>`.
//!
//! CREDENTIAL SUBSTITUTION. The route handler receives only the request
//! *body* — [`OpenAiResponsesRouteHandler::handle_provider_route`] has no
//! header parameter at all — and every upstream header is constructed here
//! and in the executor. There is therefore no path by which an inbound
//! `Authorization`, `x-api-key`, or cookie header reaches an upstream: the
//! gateway always substitutes its own credential. This is the structural form
//! of the recorded follow-up that a client's own provider JWT must never be
//! forwarded.
//!
//! NOT IMPLEMENTED, on purpose: the cooldown/failover state machine that the
//! OAuth pools carry. An API-key pool rotates over its enabled accounts and
//! reports a bounded error; it does not persist per-account cooldown records.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;
use zeroize::Zeroizing;

use crate::internal::runtime::executor::openai_compat_executor::{
    OpenAiCompatConfig, OpenAiCompatExecutor,
};
use crate::sdk::pluginapi::{
    ExecutorRequest, ExecutorStreamChunk, HostHttpClient, ProviderExecutor,
};
use crate::sdk::translator::Registry;

use super::openai_responses_handlers::{
    OpenAiResponsesHttpResponse, OpenAiResponsesRouteResponse,
};

/// One resolved API-key account. The key is held zeroizing and is never
/// rendered by `Debug`, logged, or returned on any route.
pub struct ApiKeyAccount {
    id: String,
    base_url: String,
    api_key: Zeroizing<String>,
    models: Vec<String>,
    priority: i32,
    disabled: bool,
    http_client: Arc<dyn HostHttpClient>,
}

impl ApiKeyAccount {
    pub fn new(
        id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: Zeroizing<String>,
        models: Vec<String>,
        priority: i32,
        disabled: bool,
        http_client: Arc<dyn HostHttpClient>,
    ) -> Result<Self, ApiKeyPoolError> {
        let id = id.into().trim().to_owned();
        let base_url = base_url.into().trim().to_owned();
        if id.is_empty() || base_url.is_empty() || api_key.trim().is_empty() {
            return Err(ApiKeyPoolError::Configuration);
        }
        // A credential with control characters could split the outgoing
        // request line; refuse it rather than smuggle a header.
        if api_key.chars().any(char::is_control) || base_url.chars().any(char::is_control) {
            return Err(ApiKeyPoolError::Configuration);
        }
        Ok(Self {
            id,
            base_url,
            api_key,
            models,
            priority,
            disabled,
            http_client,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn serves(&self, model: &str) -> bool {
        self.models.is_empty() || self.models.iter().any(|candidate| candidate == model)
    }
}

impl std::fmt::Debug for ApiKeyAccount {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ApiKeyAccount")
            .field("id", &self.id)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("models", &self.models.len())
            .field("priority", &self.priority)
            .field("disabled", &self.disabled)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyPoolError {
    Configuration,
    NoAccount,
    Upstream(u16),
}

/// A provider's API-key accounts plus the shared OpenAI-compat executor.
pub struct ApiKeyAccountPool {
    provider: String,
    accounts: Vec<ApiKeyAccount>,
    executor: OpenAiCompatExecutor,
    cursor: AtomicUsize,
}

impl ApiKeyAccountPool {
    pub fn new(
        provider: impl Into<String>,
        accounts: Vec<ApiKeyAccount>,
        registry: Arc<Registry>,
    ) -> Result<Self, ApiKeyPoolError> {
        let provider = provider.into().trim().to_ascii_lowercase();
        if provider.is_empty() || accounts.is_empty() {
            return Err(ApiKeyPoolError::Configuration);
        }
        let executor = OpenAiCompatExecutor::new(
            provider.clone(),
            Arc::new(OpenAiCompatConfig::default()),
            registry,
        );
        Ok(Self {
            provider,
            accounts,
            executor,
            cursor: AtomicUsize::new(0),
        })
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    /// Round-robin over the enabled accounts that serve `model`, highest
    /// configured priority first. Returns `None` when the provider has no
    /// usable account for the requested model.
    fn select(&self, model: &str) -> Option<&ApiKeyAccount> {
        let mut eligible: Vec<&ApiKeyAccount> = self
            .accounts
            .iter()
            .filter(|account| !account.disabled && account.serves(model))
            .collect();
        if eligible.is_empty() {
            return None;
        }
        eligible.sort_by_key(|account| std::cmp::Reverse(account.priority));
        let index = self.cursor.fetch_add(1, Ordering::Relaxed) % eligible.len();
        Some(eligible[index])
    }

    /// Builds the executor request. Every field is constructed here: nothing
    /// is copied from the inbound HTTP request except the JSON body itself.
    fn executor_request(
        &self,
        account: &ApiKeyAccount,
        model: &str,
        body: &[u8],
        stream: bool,
    ) -> ExecutorRequest {
        let mut auth_attributes = BTreeMap::new();
        auth_attributes.insert("base_url".to_owned(), account.base_url.clone());
        auth_attributes.insert("api_key".to_owned(), account.api_key.to_string());
        ExecutorRequest {
            auth_id: account.id.clone(),
            auth_provider: self.provider.clone(),
            model: model.to_owned(),
            format: "openai-response".to_owned(),
            stream,
            headers: Default::default(),
            query: Default::default(),
            original_request: body.to_vec(),
            source_format: "openai-response".to_owned(),
            payload: body.to_vec(),
            auth_attributes,
            http_client: Some(account.http_client.clone()),
            ..ExecutorRequest::default()
        }
    }

    pub async fn execute(&self, model: &str, body: &[u8]) -> Result<Vec<u8>, ApiKeyPoolError> {
        let account = self.select(model).ok_or(ApiKeyPoolError::NoAccount)?;
        let request = self.executor_request(account, model, body, false);
        self.executor
            .execute(request)
            .await
            .map(|response| response.payload)
            .map_err(|_| ApiKeyPoolError::Upstream(502))
    }

    pub async fn execute_stream(
        &self,
        model: &str,
        body: &[u8],
    ) -> Result<mpsc::Receiver<ExecutorStreamChunk>, ApiKeyPoolError> {
        let account = self.select(model).ok_or(ApiKeyPoolError::NoAccount)?;
        let request = self.executor_request(account, model, body, true);
        self.executor
            .execute_stream(request)
            .await
            .map(|response| response.chunks)
            .map_err(|_| ApiKeyPoolError::Upstream(502))
    }
}

impl std::fmt::Debug for ApiKeyAccountPool {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ApiKeyAccountPool")
            .field("provider", &self.provider)
            .field("accounts", &self.accounts.len())
            .finish()
    }
}

/// SSE pump for an API-key provider stream. The executor already translated
/// the upstream chunks back into the client's OpenAI Responses format, so this
/// only forwards them and turns a transport failure into one terminal event
/// with a fixed message (never the upstream's own text).
pub struct OpenAiResponsesApiKeyStream {
    chunks: mpsc::Receiver<ExecutorStreamChunk>,
    terminal: bool,
    emitted_failure: bool,
}

impl OpenAiResponsesApiKeyStream {
    fn new(chunks: mpsc::Receiver<ExecutorStreamChunk>) -> Self {
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
            Some(chunk) if chunk.error.is_none() => {
                if chunk.payload.starts_with(b"event: response.completed\n")
                    || chunk.payload.starts_with(b"event: response.incomplete\n")
                {
                    self.terminal = true;
                }
                Some(chunk.payload)
            }
            Some(_) => self.failure_chunk(),
            None => {
                self.terminal = true;
                None
            }
        }
    }

    fn failure_chunk(&mut self) -> Option<Vec<u8>> {
        if self.emitted_failure {
            self.terminal = true;
            return None;
        }
        self.emitted_failure = true;
        self.terminal = true;
        Some(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"upstream_stream_error\",\"message\":\"API-key provider upstream stream failed\"}}}\n\n"
                .to_vec(),
        )
    }
}

impl std::fmt::Debug for OpenAiResponsesApiKeyStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesApiKeyStream")
            .field("terminal", &self.terminal)
            .field("emitted_failure", &self.emitted_failure)
            .finish()
    }
}

pub struct OpenAiResponsesApiKeyHandler {
    pool: Arc<ApiKeyAccountPool>,
}

impl OpenAiResponsesApiKeyHandler {
    pub fn new(pool: Arc<ApiKeyAccountPool>) -> Self {
        Self { pool }
    }

    pub fn provider(&self) -> &str {
        self.pool.provider()
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
                Ok(chunks) => OpenAiResponsesRouteResponse::ApiKeyStream(Box::new(
                    OpenAiResponsesApiKeyStream::new(chunks),
                )),
                Err(error) => OpenAiResponsesRouteResponse::Buffered(pool_error(error)),
            };
        }
        match self.pool.execute(&model, body).await {
            Ok(payload) if !payload.is_empty() => {
                OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::json(200, payload))
            }
            Ok(_) => OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::error(
                502,
                "API-key provider response translation failed",
            )),
            Err(error) => OpenAiResponsesRouteResponse::Buffered(pool_error(error)),
        }
    }
}

impl std::fmt::Debug for OpenAiResponsesApiKeyHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesApiKeyHandler")
            .field("pool", &self.pool)
            .finish()
    }
}

/// Bounded, provider-neutral error copy. The upstream's own error text is
/// deliberately not echoed: it can carry account identifiers.
fn pool_error(error: ApiKeyPoolError) -> OpenAiResponsesHttpResponse {
    match error {
        ApiKeyPoolError::Configuration => {
            OpenAiResponsesHttpResponse::error(500, "API-key provider is not configured")
        }
        ApiKeyPoolError::NoAccount => OpenAiResponsesHttpResponse::error(
            503,
            "no API-key account is currently available for this model",
        ),
        ApiKeyPoolError::Upstream(_) => {
            OpenAiResponsesHttpResponse::error(502, "API-key provider upstream rejected the request")
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
mod tests {
    use super::*;
    use crate::sdk::pluginapi::{
        HttpRequest, HttpResponse, HttpStreamChunk, HttpStreamResponse, PluginFuture,
    };
    use std::sync::Mutex;

    /// Records the request the gateway actually put on the wire.
    #[derive(Default)]
    struct RecordingClient {
        seen: Mutex<Vec<HttpRequest>>,
        body: Vec<u8>,
    }

    impl HostHttpClient for RecordingClient {
        fn execute<'a>(&'a self, request: HttpRequest) -> PluginFuture<'a, HttpResponse> {
            self.seen.lock().unwrap().push(request);
            let body = self.body.clone();
            Box::pin(async move {
                Ok(HttpResponse {
                    status_code: 200,
                    headers: Default::default(),
                    body,
                })
            })
        }

        fn execute_stream<'a>(
            &'a self,
            request: HttpRequest,
        ) -> PluginFuture<'a, HttpStreamResponse> {
            self.seen.lock().unwrap().push(request);
            Box::pin(async move {
                let (sender, receiver) = mpsc::channel(1);
                drop(sender.send(HttpStreamChunk {
                    payload: Vec::new(),
                    error: None,
                }));
                Ok(HttpStreamResponse {
                    status_code: 200,
                    headers: Default::default(),
                    chunks: receiver,
                })
            })
        }
    }

    fn pool(
        provider: &str,
        base_url: &str,
        client: Arc<RecordingClient>,
    ) -> Arc<ApiKeyAccountPool> {
        let account = ApiKeyAccount::new(
            format!("{provider}-a"),
            base_url,
            // Obviously fake, never a real credential.
            Zeroizing::new("test-not-a-real-key".to_owned()),
            Vec::new(),
            0,
            false,
            client,
        )
        .unwrap();
        Arc::new(
            ApiKeyAccountPool::new(
                provider,
                vec![account],
                crate::sdk::translator::builtin::registry(),
            )
            .unwrap(),
        )
    }

    fn header(request: &HttpRequest, name: &str) -> Option<String> {
        request
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .and_then(|(_, values)| values.first().cloned())
    }

    #[tokio::test]
    async fn each_provider_routes_to_its_base_url_with_its_own_bearer_credential() {
        for (provider, base_url) in [
            ("zai", "https://api.z.ai/api/paas/v4"),
            ("minimax", "https://api.minimax.io/v1"),
            ("xai", "https://api.x.ai/v1"),
            ("kimi", "https://api.moonshot.ai/v1"),
        ] {
            let client = Arc::new(RecordingClient {
                seen: Mutex::new(Vec::new()),
                body: br#"{"id":"chatcmpl","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#.to_vec(),
            });
            let handler = OpenAiResponsesApiKeyHandler::new(pool(provider, base_url, client.clone()));
            let response = handler
                .handle_route(br#"{"model":"test-model","input":"hi"}"#)
                .await;
            assert!(matches!(response, OpenAiResponsesRouteResponse::Buffered(_)));
            let seen = client.seen.lock().unwrap();
            let request = seen.first().expect("an upstream request");
            assert_eq!(request.url, format!("{base_url}/chat/completions"));
            assert_eq!(
                header(request, "Authorization").as_deref(),
                Some("Bearer test-not-a-real-key")
            );
        }
    }

    #[tokio::test]
    async fn an_inbound_authorization_header_can_never_reach_the_upstream() {
        let client = Arc::new(RecordingClient {
            seen: Mutex::new(Vec::new()),
            body: br#"{"id":"chatcmpl","object":"chat.completion","choices":[]}"#.to_vec(),
        });
        let handler =
            OpenAiResponsesApiKeyHandler::new(pool("xai", "https://api.x.ai/v1", client.clone()));
        // The route contract passes only the body, so a client credential
        // placed anywhere in the request has no path to the upstream. The
        // assertion below is the observable form of that guarantee.
        let _ = handler
            .handle_route(br#"{"model":"grok-test","input":"hi","authorization":"Bearer client-jwt-not-real"}"#)
            .await;
        let seen = client.seen.lock().unwrap();
        let request = seen.first().expect("an upstream request");
        assert_eq!(
            header(request, "Authorization").as_deref(),
            Some("Bearer test-not-a-real-key")
        );
        assert!(header(request, "x-api-key").is_none());
        assert!(header(request, "Cookie").is_none());
        assert!(!String::from_utf8_lossy(&request.body).contains("client-jwt-not-real"));
    }

    #[tokio::test]
    async fn a_model_no_account_serves_is_refused_without_an_upstream_call() {
        let client = Arc::new(RecordingClient {
            seen: Mutex::new(Vec::new()),
            body: Vec::new(),
        });
        let account = ApiKeyAccount::new(
            "zai-a",
            "https://api.z.ai/api/paas/v4",
            Zeroizing::new("test-not-a-real-key".to_owned()),
            vec!["glm-only".to_owned()],
            0,
            false,
            client.clone(),
        )
        .unwrap();
        let handler = OpenAiResponsesApiKeyHandler::new(Arc::new(
            ApiKeyAccountPool::new(
                "zai",
                vec![account],
                crate::sdk::translator::builtin::registry(),
            )
            .unwrap(),
        ));
        let response = handler
            .handle_route(br#"{"model":"some-other-model","input":"hi"}"#)
            .await;
        let OpenAiResponsesRouteResponse::Buffered(buffered) = response else {
            panic!("expected a buffered refusal");
        };
        assert_eq!(buffered.status(), 503);
        assert!(client.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn an_account_refuses_an_empty_or_control_character_credential() {
        let client: Arc<dyn HostHttpClient> = Arc::new(RecordingClient::default());
        for key in ["", "   ", "test-key\r\nX-Evil: yes"] {
            assert_eq!(
                ApiKeyAccount::new(
                    "zai-a",
                    "https://api.z.ai/api/paas/v4",
                    Zeroizing::new(key.to_owned()),
                    Vec::new(),
                    0,
                    false,
                    client.clone(),
                )
                .err(),
                Some(ApiKeyPoolError::Configuration)
            );
        }
    }

    #[test]
    fn debug_output_never_renders_the_credential() {
        let client: Arc<dyn HostHttpClient> = Arc::new(RecordingClient::default());
        let account = ApiKeyAccount::new(
            "zai-a",
            "https://api.z.ai/api/paas/v4",
            Zeroizing::new("test-not-a-real-key".to_owned()),
            Vec::new(),
            0,
            false,
            client,
        )
        .unwrap();
        let rendered = format!("{account:?}");
        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains("test-not-a-real-key"));
    }
}
