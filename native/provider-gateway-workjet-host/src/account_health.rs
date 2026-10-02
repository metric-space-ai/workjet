//! Bounded on-demand subscription usage reads. No periodic worker or CLI scraping.
use crate::{
    account_policy::{AccountState, QuotaWindow},
    secret_store::WorkjetSecretStore,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use workjet_provider_gateway::{
    internal::{
        config::{RuntimeSecretRef, ValidatedRuntimeConfig},
        runtime::executor::ApiKeyHttpClient,
    },
    sdk::{
        cliproxy::auth::{AccountCandidate, CooldownStateStore},
        pluginapi::{HostHttpClient, HttpRequest},
    },
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(i64::MAX)
}
#[derive(Clone)]
struct Probe {
    provider: String,
    id: String,
    access: RuntimeSecretRef,
    proxy: Option<RuntimeSecretRef>,
    url: &'static str,
    id_token: Option<RuntimeSecretRef>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHealth {
    pub account_id: String,
    pub provider: String,
    pub authentication: &'static str,
    pub disabled: bool,
    pub usable: bool,
    pub cooldown_until_ms: Option<i64>,
    pub error_code: Option<String>,
    pub http_status: Option<u16>,
    pub observed_at_ms: Option<i64>,
    pub quota: Vec<QuotaWindow>,
    pub quota_supported: bool,
    pub quota_refreshing: bool,
    pub quota_error: Option<&'static str>,
}
#[derive(Default)]
struct RefreshState {
    last_started: i64,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for RefreshState {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
pub struct AccountHealthSource {
    state: Arc<AccountState>,
    store: Arc<WorkjetSecretStore>,
    accounts: Vec<AccountCandidate>,
    probes: Vec<Probe>,
    refresh: Mutex<RefreshState>,
    probe_status: Arc<Mutex<BTreeMap<String, (u16, i64)>>>,
}
impl AccountHealthSource {
    pub fn new(
        state: Arc<AccountState>,
        store: Arc<WorkjetSecretStore>,
        config: &ValidatedRuntimeConfig,
    ) -> Arc<Self> {
        let mut accounts = config.claude_candidates();
        accounts.extend(config.codex_candidates());
        accounts.extend(config.antigravity_candidates());
        accounts.extend(config.api_key_accounts().iter().map(|a| AccountCandidate {
            auth_id: a.id.clone(),
            provider: a.provider.clone(),
            disabled: a.disabled,
            supported_models: a.models.clone(),
            priority: a.priority,
            ..Default::default()
        }));
        accounts.extend(config.xai_accounts().iter().map(|a| AccountCandidate {
            auth_id: a.id.clone(),
            provider: "xai".to_owned(),
            disabled: a.disabled,
            supported_models: a.models.clone(),
            priority: a.priority,
            ..Default::default()
        }));
        let probes = config
            .codex_accounts()
            .iter()
            .filter(|a| !a.disabled)
            .map(|a| Probe {
                provider: "codex".into(),
                id: a.id.clone(),
                access: a.access_token_secret.clone(),
                proxy: a.proxy_url_secret.clone(),
                url: "https://chatgpt.com/backend-api/wham/usage",
                id_token: Some(a.id_token_secret.clone()),
            })
            .chain(
                config
                    .claude_accounts()
                    .iter()
                    .filter(|a| !a.disabled)
                    .map(|a| Probe {
                        provider: "claude".into(),
                        id: a.id.clone(),
                        access: a.access_token_secret.clone(),
                        proxy: a.proxy_url_secret.clone(),
                        url: "https://api.anthropic.com/api/oauth/usage",
                        id_token: None,
                    }),
            )
            .collect();
        Arc::new(Self {
            state,
            store,
            accounts,
            probes,
            refresh: Mutex::new(RefreshState::default()),
            probe_status: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let now = now_ms();
        let refreshing = self.refresh_if_due(now);
        let records = self.state.load().ok();
        let statuses = self.probe_status.lock().ok();
        let accounts = self
            .accounts
            .iter()
            .map(|a| {
                let applicable = records
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .filter(|r| r.auth_id == a.auth_id && r.provider == a.provider)
                    .collect::<Vec<_>>();
                let latest = applicable.iter().max_by_key(|r| r.updated_at_ms);
                let cooldown = applicable
                    .iter()
                    .filter_map(|r| r.blocking_until_ms())
                    .filter(|t| *t > now)
                    .max();
                let probe = statuses
                    .as_ref()
                    .and_then(|s| s.get(&format!("{}:{}", a.provider, a.auth_id)))
                    .copied();
                let generation = self.state.observation(&a.provider, &a.auth_id);
                let status = generation
                    .into_iter()
                    .chain(probe)
                    .max_by_key(|o| o.1)
                    .map(|o| o.0)
                    .or(latest.and_then(|r| r.last_error.as_ref().and_then(|e| e.http_status)));
                let authentication = match status {
                    Some(401 | 403) => "rejected",
                    Some(200..=299) => "authenticated",
                    _ => "unknown",
                };
                let quotas = self.state.quotas(&a.provider, &a.auth_id);
                let exhausted = quotas.iter().any(|w| {
                    !matches!(w.name.as_str(), "seven_day_opus" | "seven_day_sonnet")
                        && now.saturating_sub(w.observed_at_ms) < 300_000
                        && w.remaining_percent == Some(0.0)
                        && w.resets_at_ms.is_none_or(|r| r > now)
                });
                AccountHealth {
                    account_id: a.auth_id.clone(),
                    provider: a.provider.clone(),
                    authentication,
                    disabled: a.disabled,
                    usable: records.is_some() && !a.disabled && cooldown.is_none() && !exhausted,
                    cooldown_until_ms: cooldown,
                    error_code: latest
                        .and_then(|r| r.last_error.as_ref())
                        .map(|e| e.code.clone()),
                    http_status: status,
                    observed_at_ms: latest
                        .map(|r| r.updated_at_ms)
                        .into_iter()
                        .chain(probe.map(|p| p.1))
                        .chain(generation.map(|p| p.1))
                        .max(),
                    quota: quotas,
                    quota_supported: matches!(a.provider.as_str(), "codex" | "claude"),
                    quota_refreshing: refreshing,
                    quota_error: match probe {
                        Some((200..=299, _)) | None => None,
                        Some((0, _)) => Some("unavailable"),
                        Some(_) => Some("provider-error"),
                    },
                }
            })
            .collect::<Vec<_>>();
        serde_json::json!({"schema":"workjet.provider-gateway.account-health.v1", "accounts":accounts})
    }
    fn refresh_if_due(&self, now: i64) -> bool {
        let Ok(mut refresh) = self.refresh.lock() else {
            return false;
        };
        if refresh.task.as_ref().is_some_and(|t| !t.is_finished()) {
            return true;
        }
        // Cache successful and failed reads for five minutes; account edits start
        // a new host. A usage endpoint 429 never blocks generation itself.
        if refresh.last_started != 0 && now.saturating_sub(refresh.last_started) < 300_000 {
            return false;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        refresh.last_started = now;
        let probes = self.probes.clone();
        let store = self.store.clone();
        let state = self.state.clone();
        let statuses = self.probe_status.clone();
        refresh.task = Some(handle.spawn(async move {
            // One owned task, sequential requests, three-second total bound per account.
            for probe in probes {
                let observed = now_ms();
                let response =
                    tokio::time::timeout(Duration::from_secs(3), probe_read(&probe, &store)).await;
                let status = match response {
                    Ok(Some(response)) => {
                        if response.status_code == 200 {
                            if let Some(windows) =
                                parse_usage(&probe.provider, &response.body, observed)
                            {
                                let _ = state.observe_quota(&probe.provider, &probe.id, windows);
                            }
                        }
                        response.status_code
                    }
                    _ => 0,
                };
                if let Ok(mut statuses) = statuses.lock() {
                    statuses.insert(
                        format!("{}:{}", probe.provider, probe.id),
                        (status, observed),
                    );
                }
            }
        }));
        true
    }
}
async fn probe_read(
    probe: &Probe,
    store: &WorkjetSecretStore,
) -> Option<workjet_provider_gateway::sdk::pluginapi::HttpResponse> {
    let token = store.resolve_text(&probe.access).ok()?;
    let proxy = probe
        .proxy
        .as_ref()
        .map(|r| store.resolve_text(r))
        .transpose()
        .ok()?;
    let client =
        ApiKeyHttpClient::new(proxy.as_deref().map(String::as_str), Duration::from_secs(3)).ok()?;
    let mut headers = BTreeMap::new();
    if let Some(reference) = &probe.id_token {
        let token = store.resolve_text(reference).ok()?;
        let claims =
            workjet_provider_gateway::internal::auth::codex::parse_jwt_token(&token).ok()?;
        if !claims.account_id().is_empty() {
            headers.insert(
                "ChatGPT-Account-Id".into(),
                vec![claims.account_id().to_owned()],
            );
        }
    }
    headers.insert(
        "Authorization".into(),
        vec![format!("Bearer {}", token.as_str())],
    );
    headers.insert("Accept".into(), vec!["application/json".into()]);
    if probe.provider == "claude" {
        headers.insert("anthropic-beta".into(), vec!["oauth-2025-04-20".into()]);
    }
    client
        .execute(HttpRequest {
            method: "GET".into(),
            url: probe.url.into(),
            headers,
            body: vec![],
        })
        .await
        .ok()
}
pub fn parse_usage(provider: &str, body: &[u8], observed: i64) -> Option<Vec<QuotaWindow>> {
    if body.len() > 256 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let mut windows = Vec::new();
    if provider == "codex" {
        for name in ["primary_window", "secondary_window"] {
            let Some(window) = value
                .pointer(&format!("/rate_limit/{name}"))
                .filter(|v| v.is_object())
            else {
                continue;
            };
            let used = window
                .get("used_percent")
                .and_then(|v| v.as_f64())
                .filter(|v| (0.0..=100.0).contains(v));
            let reset = window
                .get("reset_at")
                .and_then(|v| v.as_i64())
                .filter(|v| *v > 0)
                .and_then(|v| v.checked_mul(1000));
            windows.push(QuotaWindow {
                name: name.into(),
                remaining_percent: used.map(|v| 100.0 - v),
                resets_at_ms: reset,
                observed_at_ms: observed,
            });
        }
    } else if provider == "claude" {
        for name in [
            "five_hour",
            "seven_day",
            "seven_day_opus",
            "seven_day_sonnet",
        ] {
            let Some(window) = value.get(name).filter(|v| v.is_object()) else {
                continue;
            };
            let used = window
                .get("utilization")
                .and_then(|v| v.as_f64())
                .filter(|v| (0.0..=100.0).contains(v));
            let reset = window
                .get("resets_at")
                .and_then(|v| v.as_str())
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp_millis());
            windows.push(QuotaWindow {
                name: name.into(),
                remaining_percent: used.map(|v| 100.0 - v),
                resets_at_ms: reset,
                observed_at_ms: observed,
            });
        }
    } else {
        return None;
    }
    Some(windows)
}
