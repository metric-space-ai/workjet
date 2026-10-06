/// A successful quota HTTP response is useful only after its reading is durable.
/// Zero is the existing unavailable probe sentinel, never a generation status.
pub fn observe_usage(
    state: &AccountState,
    provider: &str,
    account: &str,
    body: &[u8],
    observed: i64,
) -> u16 {
    parse_usage(provider, body, observed)
        .filter(|windows| {
            state
                .observe_quota(provider, account, windows.clone())
                .is_ok()
        })
        .map_or(0, |_| 200)
}
fn quota_authorization(provider: &str, token: &str) -> String {
    if provider == "zai" {
        token.to_owned()
    } else {
        format!("Bearer {token}")
    }
}
/// Only recognized vendor origins receive the account credential.
pub fn api_quota_endpoint(provider: &str, base: &str) -> Option<&'static str> {
    match (provider, base.trim_end_matches('/')) {
        ("minimax", "https://api.minimax.io/v1") => {
            Some("https://www.minimax.io/v1/token_plan/remains")
        }
        ("minimax", "https://api.minimax.cn/v1") => {
            Some("https://api.minimax.cn/v1/token_plan/remains")
        }
        ("zai", "https://api.z.ai/api/coding/paas/v4" | "https://api.z.ai/api/paas/v4") => {
            Some("https://api.z.ai/api/monitor/usage/quota/limit")
        }
        (
            "zai",
            "https://open.bigmodel.cn/api/coding/paas/v4" | "https://open.bigmodel.cn/api/paas/v4",
        ) => Some("https://open.bigmodel.cn/api/monitor/usage/quota/limit"),
        ("kimi", "https://api.moonshot.ai/v1") => {
            Some("https://api.moonshot.ai/v1/users/me/balance")
        }
        ("kimi", "https://api.moonshot.cn/v1") => {
            Some("https://api.moonshot.cn/v1/users/me/balance")
        }
        _ => None,
    }
}
/// Currency comes from the exact regional destination, never from exchange-rate inference.
pub fn parse_balance(url: &str, body: &[u8], observed: i64) -> Option<AccountBalance> {
    let currency = match url {
        "https://api.moonshot.ai/v1/users/me/balance" => "USD",
        "https://api.moonshot.cn/v1/users/me/balance" => "CNY",
        _ => return None,
    };
    if body.len() > 256 * 1024 || observed < 0 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if value.get("code").and_then(|v| v.as_i64()) != Some(0)
        || value.get("status").and_then(|v| v.as_bool()) != Some(true)
        || value.get("scode").and_then(|v| v.as_str()) != Some("0x0")
    {
        return None;
    }
    let number = |field: &str| {
        value
            .pointer(field)
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
    };
    Some(AccountBalance {
        available_balance: number("/data/available_balance")?,
        currency: currency.into(),
        cash_balance: number("/data/cash_balance"),
        voucher_balance: number("/data/voucher_balance").filter(|v| *v >= 0.0),
        observed_at_ms: observed,
    })
}
pub fn observe_balance(
    state: &AccountState,
    account: &str,
    url: &str,
    body: &[u8],
    observed: i64,
) -> u16 {
    parse_balance(url, body, observed)
        .filter(|balance| {
            state
                .observe_balance("kimi", account, balance.clone())
                .is_ok()
        })
        .map_or(0, |_| 200)
}
fn parse_api_quota(
    provider: &str,
    value: &serde_json::Value,
    observed: i64,
) -> Option<Vec<QuotaWindow>> {
    let mut result = Vec::new();
    if provider == "minimax" {
        if value
            .pointer("/base_resp/status_code")
            .and_then(|v| v.as_i64())
            .is_some_and(|v| v != 0)
        {
            return None;
        }
        for item in value.get("model_remains")?.as_array()? {
            let Some(model) = item
                .get("model_name")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            let llm = model == "general" || model.starts_with("MiniMax-M");
            for (period, percent, reset, status) in [
                (
                    "interval",
                    "current_interval_remaining_percent",
                    "end_time",
                    "current_interval_status",
                ),
                (
                    "weekly",
                    "current_weekly_remaining_percent",
                    "weekly_end_time",
                    "current_weekly_status",
                ),
            ] {
                // usage_count is ambiguous across provider versions; never infer a percentage.
                let remaining = item
                    .get(percent)
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
                let unlimited = item.get(status).and_then(|v| v.as_i64()) == Some(3);
                let no_bucket = item
                    .get("current_interval_total_count")
                    .and_then(|v| v.as_i64())
                    == Some(0)
                    && item
                        .get("current_weekly_total_count")
                        .and_then(|v| v.as_i64())
                        == Some(0)
                    && item.get("current_interval_status").and_then(|v| v.as_i64()) == Some(3)
                    && item.get("current_weekly_status").and_then(|v| v.as_i64()) == Some(3);
                let boost = (period == "weekly")
                    .then(|| {
                        item.get("weekly_boost_permille")
                            .and_then(|v| v.as_u64())
                            .and_then(|v| u32::try_from(v).ok())
                    })
                    .flatten();
                result.push(QuotaWindow {
                    name: format!("{model}_{period}"),
                    model_pattern: (model != "general").then(|| model.to_owned()),
                    tool_only: !llm,
                    not_in_plan: no_bucket,
                    unlimited: unlimited && !no_bucket,
                    boost_permille: boost,
                    remaining_percent: if no_bucket || unlimited {
                        None
                    } else {
                        remaining.map(|v| v * f64::from(boost.unwrap_or(1000)) / 1000.0)
                    },
                    resets_at_ms: item.get(reset).and_then(|v| v.as_i64()).filter(|v| *v > 0),
                    observed_at_ms: observed,
                });
            }
        }
    } else if provider == "zai" {
        if value.get("success").and_then(|v| v.as_bool()) == Some(false)
            || value
                .get("code")
                .and_then(|v| v.as_i64())
                .is_some_and(|v| v != 200)
        {
            return None;
        }
        for (index, item) in value
            .pointer("/data/limits")?
            .as_array()?
            .iter()
            .enumerate()
        {
            let Some(kind) = item.get("type").and_then(|v| v.as_str()) else {
                continue;
            };
            // The vendor plugin identifies TOKENS_LIMIT as LLM, TIME_LIMIT as MCP.
            let used = item
                .get("percentage")
                .and_then(|v| v.as_f64())
                .filter(|v| (0.0..=100.0).contains(v));
            result.push(QuotaWindow {
                name: format!("{kind}_{index}"),
                tool_only: kind != "TOKENS_LIMIT",
                remaining_percent: used.map(|v| 100.0 - v),
                // Vendor contract does not establish reset timestamp semantics.
                resets_at_ms: None,
                observed_at_ms: observed,
                ..Default::default()
            });
        }
    } else {
        return None;
    }
    Some(result)
}
fn authentication(generation: Option<(u16, i64)>, probe: Option<(u16, i64)>) -> &'static str {
    // Usage permission failures do not establish inference credential rejection.
    match generation
        .map(|o| o.0)
        .or_else(|| probe.filter(|p| (200..=299).contains(&p.0)).map(|p| p.0))
    {
        Some(401) => "rejected",
        Some(200..=299) => "authenticated",
        _ => "unknown",
    }
}
#[cfg(test)]
mod provenance_tests {
    #[test]
    fn quota_authorization_uses_vendor_credential_contract() {
        assert_eq!(
            super::quota_authorization("zai", "fixture.key"),
            "fixture.key"
        );
        assert_eq!(
            super::quota_authorization("minimax", "fixture-key"),
            "Bearer fixture-key"
        );
    }

    #[test]
    fn usage_permission_failure_does_not_reject_inference_authentication() {
        assert_eq!(
            super::authentication(Some((200, 1)), Some((401, 2))),
            "authenticated"
        );
        for status in [401, 403, 429] {
            assert_eq!(super::authentication(None, Some((status, 2))), "unknown");
        }
        assert_eq!(
            super::authentication(Some((401, 1)), Some((200, 2))),
            "rejected"
        );
    }
}
// Bounded on-demand subscription usage reads. No periodic worker or CLI scraping.
use crate::{
    account_policy::{
        balance_is_exhausted, quota_is_exhausted, AccountBalance, AccountState, QuotaWindow,
    },
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
    pub generation_http_status: Option<u16>,
    pub observed_at_ms: Option<i64>,
    pub quota: Vec<QuotaWindow>,
    pub balance: Option<AccountBalance>,
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
        let mut probes: Vec<Probe> = config
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
        for account in config.api_key_accounts().iter().filter(|a| !a.disabled) {
            if let Ok(base) = account.base_url() {
                if let Some(url) = api_quota_endpoint(&account.provider, &base) {
                    probes.push(Probe {
                        provider: account.provider.clone(),
                        id: account.id.clone(),
                        access: account.api_key_secret.clone(),
                        proxy: account.proxy_url_secret.clone(),
                        url,
                        id_token: None,
                    });
                }
            }
        }
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
                let authentication = authentication(generation, probe);
                let quotas = self.state.quotas(&a.provider, &a.auth_id);
                let balance = self.state.balance(&a.provider, &a.auth_id);
                let exhausted = balance
                    .as_ref()
                    .is_some_and(|b| balance_is_exhausted(b, now))
                    || quotas.iter().any(|w| {
                        !w.tool_only
                            && w.model_pattern.is_none()
                            && !matches!(w.name.as_str(), "seven_day_opus" | "seven_day_sonnet")
                            && quota_is_exhausted(w, now)
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
                    http_status: status.filter(|status| (100..=599).contains(status)),
                    generation_http_status: generation
                        .map(|o| o.0)
                        .filter(|s| (100..=599).contains(s)),
                    observed_at_ms: latest
                        .map(|r| r.updated_at_ms)
                        .into_iter()
                        .chain(probe.map(|p| p.1))
                        .chain(generation.map(|p| p.1))
                        .max(),
                    quota: quotas,
                    balance,
                    quota_supported: matches!(a.provider.as_str(), "codex" | "claude")
                        || self
                            .probes
                            .iter()
                            .any(|p| p.provider == a.provider && p.id == a.auth_id),
                    quota_refreshing: refreshing
                        && !a.disabled
                        && self
                            .probes
                            .iter()
                            .any(|p| p.provider == a.provider && p.id == a.auth_id),
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
                        if response.status_code == 200 && probe.provider == "kimi" {
                            observe_balance(&state, &probe.id, probe.url, &response.body, observed)
                        } else if response.status_code == 200 {
                            observe_usage(
                                &state,
                                &probe.provider,
                                &probe.id,
                                &response.body,
                                observed,
                            )
                        } else {
                            response.status_code
                        }
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
        vec![quota_authorization(&probe.provider, token.as_str())],
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
    if matches!(provider, "minimax" | "zai") {
        return parse_api_quota(provider, &value, observed);
    }
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
                ..Default::default()
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
                ..Default::default()
            });
        }
    } else {
        return None;
    }
    Some(windows)
}
