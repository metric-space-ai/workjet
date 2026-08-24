// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::internal::runtime::executor::xai_executor::{
    XaiHttpRequest, XaiHttpResponse, XaiHttpTransport, XaiStreamResponse, XaiStreamingTransport,
    XaiTransportFuture, DEFAULT_XAI_API_BASE_URL,
};
use crate::internal::runtime::executor::xai_executor_auth::{
    XaiAuthClock, XaiAuthError, XaiRefreshTokens, XaiRefreshTransport, XaiSubscriptionAuth,
};
use crate::internal::runtime::executor::xai_executor_execute::XaiExecutor;
use crate::internal::runtime::executor::xai_subscription_pool::{
    xai_subscription_auth_record, XaiSubscriptionAccountPool, XaiSubscriptionPoolAccount,
};

struct FakeClock;
impl XaiAuthClock for FakeClock {
    fn now(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }
}

struct NeverRefresh;
impl XaiRefreshTransport for NeverRefresh {
    fn refresh<'a>(
        &'a self,
        _refresh_token: &'a str,
        _endpoint: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<XaiRefreshTokens, XaiAuthError>> + Send + 'a>,
    > {
        Box::pin(async { Err(XaiAuthError::MissingAuth) })
    }
}

/// Answers Grok's `/responses` the way the real upstream does: SSE frames,
/// for the non-stream aggregation path as well as the streaming one.
struct SseTransport {
    calls: AtomicUsize,
}
impl XaiHttpTransport for SseTransport {
    fn execute<'a>(
        &'a self,
        _request: &'a XaiHttpRequest,
        _timeout: Duration,
    ) -> XaiTransportFuture<'a, XaiHttpResponse> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(XaiHttpResponse {
                status: 200,
                headers: Default::default(),
                body: b"data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"object\":\"response\"}}\n\n"
                    .to_vec()
                    .into(),
            })
        })
    }
}

impl XaiStreamingTransport for SseTransport {
    fn execute_stream<'a>(
        &'a self,
        _request: &'a XaiHttpRequest,
        _timeout: Duration,
    ) -> XaiTransportFuture<'a, XaiStreamResponse> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let (sender, receiver) = tokio::sync::mpsc::channel(4);
            drop(
                sender
                    .send(Ok(b"data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"object\":\"response\"}}\n\n".to_vec()))
                    .await,
            );
            Ok(XaiStreamResponse {
                status: 200,
                headers: Default::default(),
                chunks: receiver,
            })
        })
    }
}

fn handler(transport: Arc<SseTransport>) -> OpenAiResponsesXaiHandler {
    let executor = XaiExecutor::new(transport.clone(), Duration::from_secs(5))
        .unwrap()
        .with_stream_transport(transport);
    let auth = XaiSubscriptionAuth::new(
        Arc::new(NeverRefresh),
        Arc::new(FakeClock),
        DEFAULT_XAI_API_BASE_URL,
    );
    let account = XaiSubscriptionPoolAccount {
        id: "xai-a".into(),
        label: "xai-a".into(),
        models: vec!["grok-*".into()],
        priority: 0,
        disabled: false,
        // Obviously fake, never a real credential.
        auth: xai_subscription_auth_record("xai-a", "test-not-a-real-token", None, None),
    };
    OpenAiResponsesXaiHandler::new(Arc::new(
        XaiSubscriptionAccountPool::new(vec![account], executor, auth).unwrap(),
    ))
}

#[tokio::test]
async fn a_buffered_request_gets_the_response_object_not_the_event_wrapper() {
    let transport = Arc::new(SseTransport {
        calls: AtomicUsize::new(0),
    });
    let handler = handler(transport.clone());

    let response = handler
        .handle_route(br#"{"model":"grok-4.6","input":"hi"}"#)
        .await;

    let OpenAiResponsesRouteResponse::Buffered(buffered) = response else {
        panic!("expected a buffered response");
    };
    assert_eq!(buffered.status(), 200);
    let body = String::from_utf8_lossy(buffered.body()).into_owned();
    assert!(body.contains("\"object\":\"response\""), "{body}");
    assert!(!body.contains("response.completed"), "{body}");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_stream_request_pumps_complete_frames_to_the_terminal_event() {
    let transport = Arc::new(SseTransport {
        calls: AtomicUsize::new(0),
    });
    let handler = handler(transport);

    let response = handler
        .handle_route(br#"{"model":"grok-4.6","input":"hi","stream":true}"#)
        .await;

    let OpenAiResponsesRouteResponse::XaiStream(mut stream) = response else {
        panic!("expected a stream response");
    };
    let mut frames = Vec::new();
    while let Some(frame) = stream.next_chunk().await {
        // Every frame arrives complete, terminator included.
        assert!(frame.ends_with(b"\n\n"));
        frames.push(frame);
    }
    let joined = String::from_utf8_lossy(&frames.concat()).into_owned();
    assert!(joined.contains("response.completed"), "{joined}");
}

#[tokio::test]
async fn a_model_no_account_serves_is_refused_without_an_upstream_call() {
    let transport = Arc::new(SseTransport {
        calls: AtomicUsize::new(0),
    });
    let handler = handler(transport.clone());

    let response = handler
        .handle_route(br#"{"model":"gpt-5.6-luna","input":"hi"}"#)
        .await;

    let OpenAiResponsesRouteResponse::Buffered(buffered) = response else {
        panic!("expected a buffered refusal");
    };
    assert_eq!(buffered.status(), 503);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_router_serves_xai_through_the_subscription_handler() {
    use super::super::openai_responses_handlers::OpenAiResponsesProviderRouter;
    use super::super::openai_responses_handlers::OpenAiResponsesRouteHandler as _;

    let transport = Arc::new(SseTransport {
        calls: AtomicUsize::new(0),
    });
    // The router still needs a valid default provider; a minimal API-key
    // handler for another provider fills that role.
    let claude_free_router = OpenAiResponsesProviderRouter::with_api_key_handlers(
        "zai",
        None,
        None,
        None,
        std::collections::BTreeMap::from([("zai".to_owned(), Arc::new(zai_api_key_handler()))]),
    )
    .unwrap()
    .with_xai(Arc::new(handler(transport.clone())));

    let response = claude_free_router
        .handle_provider_route(Some("xai"), br#"{"model":"grok-4.6","input":"hi"}"#)
        .await;

    let OpenAiResponsesRouteResponse::Buffered(buffered) = response else {
        panic!("expected a buffered response");
    };
    assert_eq!(buffered.status(), 200);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

fn zai_api_key_handler(
) -> super::super::openai_responses_api_key_handlers::OpenAiResponsesApiKeyHandler {
    use super::super::openai_responses_api_key_handlers::{
        ApiKeyAccount, ApiKeyAccountPool, OpenAiResponsesApiKeyHandler,
    };
    use crate::sdk::pluginapi::{
        HostHttpClient, HttpRequest, HttpResponse, HttpStreamResponse, PluginFuture,
    };

    struct DeadClient;
    impl HostHttpClient for DeadClient {
        fn execute<'a>(&'a self, _request: HttpRequest) -> PluginFuture<'a, HttpResponse> {
            Box::pin(async { Err(Arc::new(std::io::Error::other("unused")) as _) })
        }
        fn execute_stream<'a>(
            &'a self,
            _request: HttpRequest,
        ) -> PluginFuture<'a, HttpStreamResponse> {
            Box::pin(async { Err(Arc::new(std::io::Error::other("unused")) as _) })
        }
    }

    let account = ApiKeyAccount::new(
        "zai-a",
        "https://api.z.ai/api/paas/v4",
        zeroize::Zeroizing::new("test-not-a-real-key".to_owned()),
        Vec::new(),
        0,
        false,
        Arc::new(DeadClient),
    )
    .unwrap();
    OpenAiResponsesApiKeyHandler::new(Arc::new(
        ApiKeyAccountPool::new(
            "zai",
            vec![account],
            crate::sdk::translator::builtin::registry(),
        )
        .unwrap(),
    ))
}
