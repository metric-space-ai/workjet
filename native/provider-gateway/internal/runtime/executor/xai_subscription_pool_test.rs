// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::internal::runtime::executor::xai_executor::{
    XaiHttpRequest, XaiHttpResponse, XaiHttpTransport, XaiTransportFuture,
};
use crate::internal::runtime::executor::xai_executor_auth::{
    XaiAuthClock, XaiRefreshTokens, XaiRefreshTransport,
};

struct FakeClock;
impl XaiAuthClock for FakeClock {
    fn now(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }
}

/// Answers 401 until a refreshed token arrives, then 200 with a completed
/// response — the exact shape of an expired subscription healing itself.
/// The 200 body is SSE (`data:` frames): Grok's `/responses` answers SSE
/// even without `stream`, and the executor aggregates those frames.
struct FlippingTransport {
    calls: AtomicUsize,
}
impl XaiHttpTransport for FlippingTransport {
    fn execute<'a>(
        &'a self,
        request: &'a XaiHttpRequest,
        _timeout: Duration,
    ) -> XaiTransportFuture<'a, XaiHttpResponse> {
        // Headers are a plain BTreeMap; the executor writes "Authorization".
        // Match case-insensitively like HTTP does, not like the map does.
        let authorized = request.headers.iter().any(|(name, values)| {
            name.eq_ignore_ascii_case("authorization")
                && values.iter().any(|value| value.contains("fresh-token"))
        });
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if authorized {
                Ok(XaiHttpResponse {
                    status: 200,
                    headers: Default::default(),
                    body:
                        b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n"
                            .to_vec()
                            .into(),
                })
            } else {
                Ok(XaiHttpResponse {
                    status: 401,
                    headers: Default::default(),
                    body: b"{}".to_vec().into(),
                })
            }
        })
    }
}

struct FakeRefresh;
impl XaiRefreshTransport for FakeRefresh {
    fn refresh<'a>(
        &'a self,
        _refresh_token: &'a str,
        _endpoint: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<XaiRefreshTokens, XaiAuthError>> + Send + 'a>,
    > {
        Box::pin(async {
            Ok(XaiRefreshTokens {
                access_token: "fresh-token".into(),
                refresh_token: Some("rotated-refresh".into()),
                id_token: None,
                token_type: None,
                expires_in: Some(3600),
                expires_at: None,
                email: None,
                subject: None,
            })
        })
    }
}

struct CapturePersist(std::sync::Mutex<Vec<(String, Option<String>)>>);
impl XaiAuthPersist for CapturePersist {
    fn persist(&self, account_id: &str, auth: &Auth) {
        self.0.lock().unwrap().push((
            account_id.to_owned(),
            auth.metadata
                .get("refresh_token")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
        ));
    }
}

fn pool_with(
    accounts: Vec<XaiSubscriptionPoolAccount>,
    transport: Arc<dyn XaiHttpTransport>,
) -> XaiSubscriptionAccountPool {
    let executor = XaiExecutor::new(transport, Duration::from_secs(5)).unwrap();
    // The default base URL matters: the refreshed Auth carries it, and an
    // empty one makes the retry die on InvalidTarget instead of succeeding.
    let auth = XaiSubscriptionAuth::new(
        Arc::new(FakeRefresh),
        Arc::new(FakeClock),
        crate::internal::runtime::executor::xai_executor::DEFAULT_XAI_API_BASE_URL,
    );
    XaiSubscriptionAccountPool::new(accounts, executor, auth).unwrap()
}

fn account(id: &str, models: &[&str], token: &str) -> XaiSubscriptionPoolAccount {
    XaiSubscriptionPoolAccount {
        id: id.into(),
        label: id.into(),
        models: models.iter().map(|entry| (*entry).to_owned()).collect(),
        priority: 0,
        disabled: false,
        auth: xai_subscription_auth_record(id, token, Some("refresh-1"), None),
    }
}

#[tokio::test]
async fn refreshes_once_on_unauthorized_and_persists_the_rotation() {
    // The upstream rejects the stale token, the pool refreshes EXACTLY once,
    // retries, and hands the rotated refresh token to the persist port —
    // losing that rotation on restart silently kills the account.
    let transport = Arc::new(FlippingTransport {
        calls: AtomicUsize::new(0),
    });
    let persist = Arc::new(CapturePersist(std::sync::Mutex::new(Vec::new())));
    let pool = pool_with(
        vec![account("acc-1", &[], "stale-token")],
        transport.clone(),
    )
    .with_persist(persist.clone());

    let payload = pool.execute("grok-4.6", b"{\"input\":[]}").await.unwrap();

    assert!(String::from_utf8_lossy(&payload).contains("response.completed"));
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    let persisted = persist.0.lock().unwrap();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].0, "acc-1");
    assert_eq!(persisted[0].1.as_deref(), Some("rotated-refresh"));
}

#[tokio::test]
async fn selects_by_model_with_the_shared_wildcard_semantics() {
    // A third matching dialect is how the last two routers came to disagree;
    // the pool must use the same anchored `*` rules as everyone else.
    let transport = Arc::new(FlippingTransport {
        calls: AtomicUsize::new(0),
    });
    let pool = pool_with(
        vec![account("only-grok", &["grok-*"], "fresh-token")],
        transport,
    );

    assert!(pool.execute("grok-4.6", b"{}").await.is_ok());
    assert_eq!(
        pool.execute("gpt-5.6-luna", b"{}").await.unwrap_err(),
        XaiPoolError::NoAccount
    );
}
