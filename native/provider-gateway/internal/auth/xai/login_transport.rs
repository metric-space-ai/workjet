// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

//! Production HTTP transport for the xAI device-code login flow.
//!
//! The flow talks to three plain HTTPS endpoints (OpenID discovery, device
//! authorization, token) — no browser fingerprint is inspected, so this
//! stays as plain as the API-key transport: no redirects, no retry, no
//! ambient proxy. A per-request `proxy_url` (set by [`super::XaiAuth`] when
//! it carries one) builds a one-off proxied client for that request.

use std::time::Duration;

use wreq::{Client, Proxy};

use super::{
    XaiHttpFuture, XaiHttpRequest, XaiHttpResponse, XaiHttpTransport, XaiTransportFailure,
};
use crate::sdk::auth::LoginCancellation;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct XaiLoginHttpTransport {
    client: Client,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XaiLoginTransportBuildError {
    Client,
}

impl std::fmt::Display for XaiLoginTransportBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("xAI login transport could not be built")
    }
}

impl std::error::Error for XaiLoginTransportBuildError {}

fn base_builder() -> wreq::ClientBuilder {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .retry(wreq::retry::Policy::never())
        .redirect(wreq::redirect::Policy::none())
}

impl XaiLoginHttpTransport {
    pub fn new() -> Result<Self, XaiLoginTransportBuildError> {
        Ok(Self {
            client: base_builder()
                .no_proxy()
                .build()
                .map_err(|_| XaiLoginTransportBuildError::Client)?,
        })
    }

    async fn send(
        &self,
        request: &XaiHttpRequest,
        timeout: Duration,
    ) -> Result<XaiHttpResponse, XaiTransportFailure> {
        let client = match request.proxy_url.as_deref().map(str::trim) {
            Some(proxy_url) if !proxy_url.is_empty() => {
                let proxy = Proxy::all(proxy_url).map_err(|_| XaiTransportFailure::Protocol)?;
                base_builder()
                    .proxy(proxy)
                    .build()
                    .map_err(|_| XaiTransportFailure::Protocol)?
            }
            _ => self.client.clone(),
        };
        let method = match request.method {
            super::XaiHttpMethod::Get => wreq::Method::GET,
            super::XaiHttpMethod::Post => wreq::Method::POST,
        };
        let mut outgoing = client
            .request(method, request.url.clone())
            .timeout(timeout)
            .body(request.body.to_vec());
        for (name, value) in &request.headers {
            outgoing = outgoing.header(name.as_str(), value.as_str());
        }
        let response = outgoing.send().await.map_err(|error| {
            if error.is_timeout() {
                XaiTransportFailure::Timeout
            } else if error.is_connect() {
                XaiTransportFailure::Connect
            } else {
                XaiTransportFailure::Protocol
            }
        })?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|_| XaiTransportFailure::Protocol)?
            .to_vec();
        Ok(XaiHttpResponse::new(status, body))
    }
}

impl std::fmt::Debug for XaiLoginHttpTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("XaiLoginHttpTransport").finish()
    }
}

impl XaiHttpTransport for XaiLoginHttpTransport {
    fn execute<'a>(
        &'a self,
        request: &'a XaiHttpRequest,
        timeout: Duration,
        cancellation: &'a LoginCancellation,
    ) -> XaiHttpFuture<'a> {
        Box::pin(async move {
            tokio::select! {
                response = self.send(request, timeout) => response,
                () = cancellation.cancelled() => Err(XaiTransportFailure::Cancelled),
            }
        })
    }
}
