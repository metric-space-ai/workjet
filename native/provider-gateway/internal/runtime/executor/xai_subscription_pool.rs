// Origin: CTOX
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
//! Subscription-account pool for xAI (Grok), in the pattern of the other
//! CTOX pools — but sized like [`ApiKeyAccountPool`], not like the
//! Antigravity executor: xAI needs no credit ledger and no fingerprint
//! machinery, and mirroring those here would be dead weight around a live
//! credential path.
//!
//! The pieces below the pool already exist and are consumed as-is:
//! [`XaiExecutor`] speaks Grok's `/responses` natively (streaming included),
//! and [`XaiSubscriptionAuth`] refreshes an OAuth `Auth` record in place.
//! What the pool adds is exactly what a pool is for: account selection by
//! model (with the SAME anchored `*` semantics as the scheduler and the
//! app-side resolver — a third matching dialect is how the last two routers
//! came to disagree), rotation over eligible accounts, and a single
//! refresh-and-retry on an unauthorized upstream answer.
//!
//! Token persistence is a PORT, not a side effect: refresh rotates the
//! refresh token, and losing the rotation on restart silently kills the
//! account. The pool cannot reach the host's secret store, so it hands every
//! refreshed `Auth` to a [`XaiAuthPersist`] the host supplies.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};

use crate::sdk::cliproxy::auth::scheduler::{canonical_model_key, model_entry_matches};
use crate::sdk::cliproxy::auth::Auth;
use crate::sdk::cliproxy::executor::{Options, Request};
use crate::sdk::translator::Format;

use super::xai_executor_auth::{XaiAuthError, XaiSubscriptionAuth};
use super::xai_executor_execute::{XaiExecutionError, XaiExecutor};

/// Where a refreshed credential goes so it survives a restart.
pub trait XaiAuthPersist: Send + Sync {
    fn persist(&self, account_id: &str, auth: &Auth);
}

pub struct XaiSubscriptionPoolAccount {
    pub id: String,
    pub label: String,
    /// Model entries this account serves; empty serves everything, `*`
    /// wildcards match with the shared anchored semantics.
    pub models: Vec<String>,
    pub priority: i32,
    pub disabled: bool,
    pub auth: Auth,
}

struct PoolMember {
    id: String,
    models: Vec<String>,
    priority: i32,
    disabled: bool,
    auth: Mutex<Auth>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum XaiPoolError {
    Configuration,
    NoAccount,
    Auth,
    Upstream(u16),
    Execution,
}

pub struct XaiSubscriptionAccountPool {
    members: Vec<PoolMember>,
    executor: XaiExecutor,
    auth: XaiSubscriptionAuth,
    persist: Option<Arc<dyn XaiAuthPersist>>,
    cursor: AtomicUsize,
}

impl XaiSubscriptionAccountPool {
    pub fn new(
        accounts: Vec<XaiSubscriptionPoolAccount>,
        executor: XaiExecutor,
        auth: XaiSubscriptionAuth,
    ) -> Result<Self, XaiPoolError> {
        if accounts.is_empty() {
            return Err(XaiPoolError::Configuration);
        }
        Ok(Self {
            members: accounts
                .into_iter()
                .map(|account| PoolMember {
                    id: account.id,
                    models: account.models,
                    priority: account.priority,
                    disabled: account.disabled,
                    auth: Mutex::new(account.auth),
                })
                .collect(),
            executor,
            auth,
            persist: None,
            cursor: AtomicUsize::new(0),
        })
    }

    #[must_use]
    pub fn with_persist(mut self, persist: Arc<dyn XaiAuthPersist>) -> Self {
        self.persist = Some(persist);
        self
    }

    /// Highest priority first, round-robin within it. Same eligibility rule as
    /// everywhere else: an empty list serves anything, entries match with the
    /// shared anchored wildcard semantics.
    fn select(&self, model: &str) -> Option<&PoolMember> {
        let requested = canonical_model_key(model);
        let mut eligible: Vec<&PoolMember> = self
            .members
            .iter()
            .filter(|member| {
                !member.disabled
                    && (member.models.is_empty()
                        || member
                            .models
                            .iter()
                            .any(|entry| model_entry_matches(entry, &requested)))
            })
            .collect();
        if eligible.is_empty() {
            return None;
        }
        let top = eligible.iter().map(|member| member.priority).max()?;
        eligible.retain(|member| member.priority == top);
        let index = self.cursor.fetch_add(1, Ordering::Relaxed) % eligible.len();
        Some(eligible[index])
    }

    fn request(model: &str, body: &[u8]) -> Request {
        Request {
            model: model.to_owned(),
            payload: body.to_vec(),
            format: Format::new("openai-response"),
            metadata: Default::default(),
        }
    }

    fn options(stream: bool) -> Options {
        Options {
            stream,
            source_format: Format::new("openai-response"),
            response_format: Format::new("openai-response"),
            ..Options::default()
        }
    }

    async fn refreshed(&self, member: &PoolMember) -> Result<Auth, XaiPoolError> {
        let current = member.auth.lock().await.clone();
        let next = self
            .auth
            .refresh(Some(&current))
            .await
            .map_err(|error: XaiAuthError| match error {
                XaiAuthError::MissingAuth => XaiPoolError::Configuration,
                _ => XaiPoolError::Auth,
            })?;
        *member.auth.lock().await = next.clone();
        if let Some(persist) = self.persist.as_deref() {
            persist.persist(&member.id, &next);
        }
        Ok(next)
    }

    /// Non-streaming Grok `/responses` call. One refresh-and-retry on an
    /// unauthorized answer — the executor never refreshes on its own, and
    /// looping refreshes against a revoked account would hammer the token
    /// endpoint for nothing.
    pub async fn execute(&self, model: &str, body: &[u8]) -> Result<Vec<u8>, XaiPoolError> {
        let member = self.select(model).ok_or(XaiPoolError::NoAccount)?;
        let request = Self::request(model, body);
        let options = Self::options(false);
        let auth = member.auth.lock().await.clone();
        match self.executor.execute(Some(&auth), &request, &options).await {
            Ok(response) => Ok(response.payload),
            Err(XaiExecutionError::Status(status)) if status.status == 401 => {
                let refreshed = self.refreshed(member).await?;
                self.executor
                    .execute(Some(&refreshed), &request, &options)
                    .await
                    .map(|response| response.payload)
                    .map_err(map_execution_error)
            }
            Err(error) => Err(map_execution_error(error)),
        }
    }

    /// Streaming Grok `/responses` call; chunks are the upstream SSE frames.
    pub async fn execute_stream(
        &self,
        model: &str,
        body: &[u8],
    ) -> Result<mpsc::Receiver<Result<Vec<u8>, XaiExecutionError>>, XaiPoolError> {
        let member = self.select(model).ok_or(XaiPoolError::NoAccount)?;
        let request = Self::request(model, body);
        let options = Self::options(true);
        let auth = member.auth.lock().await.clone();
        match self
            .executor
            .execute_stream(Some(&auth), &request, &options)
            .await
        {
            Ok(stream) => Ok(stream.chunks),
            Err(XaiExecutionError::Status(status)) if status.status == 401 => {
                let refreshed = self.refreshed(member).await?;
                self.executor
                    .execute_stream(Some(&refreshed), &request, &options)
                    .await
                    .map(|stream| stream.chunks)
                    .map_err(map_execution_error)
            }
            Err(error) => Err(map_execution_error(error)),
        }
    }

    /// The summary rows the management surface renders: id, enabled, models.
    #[must_use]
    pub fn account_summmaries(&self) -> Vec<(String, bool, Vec<String>)> {
        self.members
            .iter()
            .map(|member| (member.id.clone(), !member.disabled, member.models.clone()))
            .collect()
    }
}

fn map_execution_error(error: XaiExecutionError) -> XaiPoolError {
    match error {
        XaiExecutionError::Status(status) => XaiPoolError::Upstream(status.status),
        _ => XaiPoolError::Execution,
    }
}

impl std::fmt::Debug for XaiSubscriptionAccountPool {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("XaiSubscriptionAccountPool")
            .field("members", &self.members.len())
            .finish()
    }
}

/// Convenience used by hosts: seed an `Auth` from resolved secret values.
#[must_use]
pub fn xai_subscription_auth_record(
    account_id: &str,
    access_token: &str,
    refresh_token: Option<&str>,
    base_url: Option<&str>,
) -> Auth {
    let mut metadata: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    metadata.insert("type".into(), serde_json::Value::String("xai".into()));
    metadata.insert(
        "auth_kind".into(),
        serde_json::Value::String("oauth".into()),
    );
    metadata.insert(
        "access_token".into(),
        serde_json::Value::String(access_token.to_owned()),
    );
    if let Some(refresh) = refresh_token {
        metadata.insert(
            "refresh_token".into(),
            serde_json::Value::String(refresh.to_owned()),
        );
    }
    if let Some(base_url) = base_url {
        metadata.insert(
            "base_url".into(),
            serde_json::Value::String(base_url.to_owned()),
        );
    }
    let mut auth = Auth::default();
    auth.id = account_id.to_owned();
    auth.provider = "xai".into();
    auth.metadata = metadata;
    auth
}

#[cfg(test)]
#[path = "xai_subscription_pool_test.rs"]
mod tests;
