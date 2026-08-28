// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

//! Host HTTP transport for xAI subscription accounts.
//!
//! Grok's `/responses` upstream is an ordinary HTTPS endpoint — no browser
//! fingerprint is inspected — so this stays as plain as the API-key
//! transport: no emulation profile, no redirects, no retry, no ambient
//! proxy. One struct serves all three ports the runtime needs: buffered
//! execution, streaming execution, and the OAuth token refresh.
//!
//! The transport NEVER adds an authorization header of its own; the single
//! credential on the wire is the one [`super::xai_executor_request`] sets
//! from the pool's `Auth`. The refresh call carries no credential at all
//! beyond the refresh token in its form body.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XaiTransportBuildError {
    InvalidProxy,
    Client,
}

impl std::fmt::Display for XaiTransportBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("xAI subscription transport could not be built")
    }
}

impl std::error::Error for XaiTransportBuildError {}

/// Upper bound on a buffered xAI response, matching the API-key transport's
/// bound: a misbehaving upstream must not exhaust host memory.
pub const XAI_MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

#[cfg(feature = "xai-http-transport")]
mod native {
    use std::time::Duration;

    use futures_util::StreamExt;
    use tokio::sync::mpsc;
    use wreq::{Client, Proxy};

    use super::super::xai_executor::{
        XaiHttpRequest, XaiHttpResponse, XaiHttpTransport, XaiStreamResponse,
        XaiStreamingTransport, XaiTransportFailure, XaiTransportFuture,
    };
    use super::super::xai_executor_auth::{XaiAuthError, XaiRefreshTokens, XaiRefreshTransport};
    use super::{XaiTransportBuildError, XAI_MAX_RESPONSE_BYTES};
    use crate::internal::auth::xai::{CLIENT_ID, DISCOVERY_URL};

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
    const STREAM_CHANNEL_CAPACITY: usize = 16;

    #[derive(Clone)]
    pub struct XaiSubscriptionHttpTransport {
        client: Client,
    }

    impl XaiSubscriptionHttpTransport {
        pub fn new(proxy_url: Option<&str>) -> Result<Self, XaiTransportBuildError> {
            let mut builder = Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .retry(wreq::retry::Policy::never())
                .redirect(wreq::redirect::Policy::none());
            match proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
                Some(proxy_url) => {
                    let proxy =
                        Proxy::all(proxy_url).map_err(|_| XaiTransportBuildError::InvalidProxy)?;
                    builder = builder.proxy(proxy);
                }
                None => builder = builder.no_proxy(),
            }
            Ok(Self {
                client: builder
                    .build()
                    .map_err(|_| XaiTransportBuildError::Client)?,
            })
        }

        fn outgoing(&self, request: &XaiHttpRequest, timeout: Duration) -> wreq::RequestBuilder {
            let mut outgoing = self
                .client
                .post(request.url.clone())
                .timeout(timeout)
                .body(request.body.to_vec());
            for (name, values) in &request.headers {
                for value in values {
                    outgoing = outgoing.header(name.as_str(), value.as_str());
                }
            }
            outgoing
        }
    }

    impl std::fmt::Debug for XaiSubscriptionHttpTransport {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("XaiSubscriptionHttpTransport")
                .finish()
        }
    }

    /// One typed transport failure; the upstream's own error text can carry
    /// account identifiers and is never surfaced.
    fn failure(error: &wreq::Error) -> XaiTransportFailure {
        if error.is_timeout() {
            XaiTransportFailure::Timeout
        } else if error.is_connect() {
            XaiTransportFailure::Connect
        } else {
            XaiTransportFailure::Protocol
        }
    }

    fn collect_headers(response: &wreq::Response) -> crate::sdk::cliproxy::executor::Headers {
        let mut headers = crate::sdk::cliproxy::executor::Headers::new();
        for (name, value) in response.headers() {
            if let Ok(value) = value.to_str() {
                headers
                    .entry(name.as_str().to_owned())
                    .or_default()
                    .push(value.to_owned());
            }
        }
        headers
    }

    impl XaiHttpTransport for XaiSubscriptionHttpTransport {
        fn execute<'a>(
            &'a self,
            request: &'a XaiHttpRequest,
            timeout: Duration,
        ) -> XaiTransportFuture<'a, XaiHttpResponse> {
            Box::pin(async move {
                let response = self
                    .outgoing(request, timeout)
                    .send()
                    .await
                    .map_err(|error| failure(&error))?;
                let status = response.status().as_u16();
                let headers = collect_headers(&response);
                let body = response
                    .bytes()
                    .await
                    .map_err(|error| failure(&error))?
                    .to_vec();
                if body.len() > XAI_MAX_RESPONSE_BYTES {
                    return Err(XaiTransportFailure::MessageTooBig);
                }
                Ok(XaiHttpResponse {
                    status,
                    headers,
                    body: body.into(),
                })
            })
        }
    }

    impl XaiStreamingTransport for XaiSubscriptionHttpTransport {
        fn execute_stream<'a>(
            &'a self,
            request: &'a XaiHttpRequest,
            timeout: Duration,
        ) -> XaiTransportFuture<'a, XaiStreamResponse> {
            Box::pin(async move {
                let response = self
                    .outgoing(request, timeout)
                    .send()
                    .await
                    .map_err(|error| failure(&error))?;
                let status = response.status().as_u16();
                let headers = collect_headers(&response);
                let (sender, receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
                let mut body = response.bytes_stream();
                tokio::spawn(async move {
                    while let Some(chunk) = body.next().await {
                        let message = match chunk {
                            Ok(bytes) => Ok(bytes.to_vec()),
                            Err(error) => Err(failure(&error)),
                        };
                        let terminal = message.is_err();
                        if sender.send(message).await.is_err() || terminal {
                            return;
                        }
                    }
                });
                Ok(XaiStreamResponse {
                    status,
                    headers,
                    chunks: receiver,
                })
            })
        }
    }

    #[derive(serde::Deserialize)]
    struct DiscoveryDocument {
        token_endpoint: String,
    }

    #[derive(serde::Deserialize, Default)]
    #[serde(default)]
    struct RefreshResponse {
        error: String,
        access_token: String,
        refresh_token: String,
        id_token: String,
        token_type: String,
        expires_in: i64,
    }

    impl XaiSubscriptionHttpTransport {
        /// Token endpoint: the stored one when the login recorded it,
        /// otherwise xAI's OpenID discovery document — the same order
        /// `XaiAuth` uses.
        async fn token_endpoint(&self, stored: Option<&str>) -> Result<String, XaiAuthError> {
            if let Some(endpoint) = stored.map(str::trim).filter(|value| !value.is_empty()) {
                return Ok(endpoint.to_owned());
            }
            let response = self
                .client
                .get(DISCOVERY_URL)
                .timeout(REFRESH_TIMEOUT)
                .send()
                .await
                .map_err(|error| XaiAuthError::Transport(format!("{:?}", failure(&error))))?;
            if response.status().as_u16() != 200 {
                return Err(XaiAuthError::Transport("discovery failed".into()));
            }
            let body = response
                .bytes()
                .await
                .map_err(|_| XaiAuthError::Transport("discovery invalid".into()))?;
            let document: DiscoveryDocument = serde_json::from_slice(&body)
                .map_err(|_| XaiAuthError::Transport("discovery invalid".into()))?;
            let endpoint = document.token_endpoint.trim().to_owned();
            let parsed = url::Url::parse(&endpoint)
                .map_err(|_| XaiAuthError::Transport("token endpoint invalid".into()))?;
            if parsed.scheme() != "https" {
                return Err(XaiAuthError::Transport("token endpoint insecure".into()));
            }
            Ok(endpoint)
        }
    }

    impl XaiRefreshTransport for XaiSubscriptionHttpTransport {
        fn refresh<'a>(
            &'a self,
            refresh_token: &'a str,
            token_endpoint: Option<&'a str>,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<XaiRefreshTokens, XaiAuthError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                let endpoint = self.token_endpoint(token_endpoint).await?;
                let body = [
                    ("grant_type", "refresh_token"),
                    ("client_id", CLIENT_ID),
                    ("refresh_token", refresh_token),
                ]
                .iter()
                .fold(
                    url::form_urlencoded::Serializer::new(String::new()),
                    |mut form, (key, value)| {
                        form.append_pair(key, value);
                        form
                    },
                )
                .finish();
                let response = self
                    .client
                    .post(endpoint)
                    .timeout(REFRESH_TIMEOUT)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .header("Accept", "application/json")
                    .body(body)
                    .send()
                    .await
                    .map_err(|error| XaiAuthError::Transport(format!("{:?}", failure(&error))))?;
                let status = response.status().as_u16();
                let payload = response
                    .bytes()
                    .await
                    .map_err(|_| XaiAuthError::Transport("refresh response invalid".into()))?;
                let payload: RefreshResponse = serde_json::from_slice(&payload)
                    .map_err(|_| XaiAuthError::Transport("refresh response invalid".into()))?;
                if status != 200 || !payload.error.is_empty() || payload.access_token.is_empty() {
                    return Err(XaiAuthError::Transport("refresh rejected".into()));
                }
                Ok(XaiRefreshTokens {
                    access_token: payload.access_token,
                    refresh_token: (!payload.refresh_token.is_empty())
                        .then_some(payload.refresh_token),
                    id_token: (!payload.id_token.is_empty()).then_some(payload.id_token),
                    token_type: (!payload.token_type.is_empty()).then_some(payload.token_type),
                    expires_in: u64::try_from(payload.expires_in)
                        .ok()
                        .filter(|value| *value > 0),
                    expires_at: None,
                    email: None,
                    subject: None,
                })
            })
        }
    }
}

#[cfg(feature = "xai-http-transport")]
pub use native::XaiSubscriptionHttpTransport;
