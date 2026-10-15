#[cfg(test)]
mod account_failure_scope_tests {
    use super::*;
    use workjet_provider_gateway::sdk::cliproxy::auth::{
        conductor_execution::AccountPolicy, AccountExecutionResult, AccountSelectionError,
    };

    fn source(root: &std::path::Path) -> AccountHealthSource {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let store = Arc::new(WorkjetSecretStore::new(root.to_owned()).unwrap());
        let state = AccountState::open(store.clone()).unwrap();
        AccountHealthSource {
            state,
            store,
            accounts: vec![AccountCandidate {
                provider: "xai".into(),
                auth_id: "account".into(),
                supported_models: vec!["grok-4.7".into(), "grok-4.6-exact".into()],
                ..Default::default()
            }],
            probes: vec![],
            refresh: Mutex::new(RefreshState::default()),
            probe_status: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn record(source: &AccountHealthSource, model: Option<&str>, status: u16, at: i64) {
        let result = AccountExecutionResult {
            provider: "xai".into(),
            auth_id: "account".into(),
            model: model.map(str::to_owned),
            status,
            retry_delay_ms: None,
            observed_at_ms: at,
        };
        source.state.conductor().record(result.clone()).unwrap();
        source.state.observe_outcome(&result).unwrap();
    }

    #[test]
    fn model_404_preserves_account_health_and_other_model_routing_after_reopen() {
        let root = tempfile::tempdir().unwrap();
        let first = source(root.path());
        let now = now_ms();
        record(&first, Some("grok-4.7"), 404, now);
        drop(first);
        let reopened = source(root.path());
        let health = reopened.snapshot();
        assert_eq!(health["accounts"][0]["usable"], true);
        assert!(health["accounts"][0]["cooldownUntilMs"].is_null());
        assert_eq!(health["accounts"][0]["generationHttpStatus"], 404);
        assert_eq!(health["accounts"][0]["models"][0]["modelId"], "grok-4.7");
        assert_eq!(
            health["accounts"][0]["models"][0]["status"],
            "model-unavailable"
        );
        assert_eq!(health["accounts"][0]["models"][0]["httpStatus"], 404);
        assert_eq!(health["accounts"][0]["models"][1]["status"], "ready");
        let records = reopened.state.load().unwrap();
        assert_eq!(
            reopened
                .state
                .select(
                    "xai",
                    Some("grok-4.6-exact"),
                    now,
                    &reopened.accounts,
                    &records,
                    b"{}"
                )
                .unwrap()
                .auth_id,
            "account"
        );
        assert!(matches!(
            reopened.state.select(
                "xai",
                Some("grok-4.7"),
                now,
                &reopened.accounts,
                &records,
                b"{}"
            ),
            Err(AccountSelectionError::Unavailable)
        ));
    }

    #[test]
    fn model_quota_is_visible_even_when_account_remains_usable() {
        let root = tempfile::tempdir().unwrap();
        let source = source(root.path());
        let now = now_ms();
        source
            .state
            .observe_quota(
                "xai",
                "account",
                vec![QuotaWindow {
                    name: "model_bucket".into(),
                    model_pattern: Some("grok-4.7".into()),
                    remaining_percent: Some(0.0),
                    resets_at_ms: Some(now + 60_000),
                    observed_at_ms: now,
                    ..Default::default()
                }],
            )
            .unwrap();
        let health = source.snapshot();
        assert_eq!(health["accounts"][0]["usable"], true);
        assert_eq!(health["accounts"][0]["models"][0]["status"], "quota");
        assert_eq!(health["accounts"][0]["models"][1]["status"], "ready");
    }

    #[test]
    fn legacy_account_404_is_neutral_but_real_quota_and_auth_failures_remain_blocking() {
        for status in [401, 429] {
            let root = tempfile::tempdir().unwrap();
            let source = source(root.path());
            let now = now_ms();
            record(&source, None, 404, now);
            assert!(source.snapshot()["accounts"][0]["cooldownUntilMs"].is_null());
            assert!(source
                .state
                .select(
                    "xai",
                    Some("grok-4.6-exact"),
                    now,
                    &source.accounts,
                    &source.state.load().unwrap(),
                    b"{}"
                )
                .is_ok());
            record(&source, None, status, now + 1);
            let health = source.snapshot();
            assert_eq!(health["accounts"][0]["usable"], false);
            assert!(health["accounts"][0]["cooldownUntilMs"].as_i64().unwrap() > now);
            assert!(matches!(
                source.state.select(
                    "xai",
                    Some("grok-4.6-exact"),
                    now,
                    &source.accounts,
                    &source.state.load().unwrap(),
                    b"{}"
                ),
                Err(AccountSelectionError::Cooldown { .. })
            ));
        }
    }
}
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
        // Kimi Code (coding plan) keys; ref: MoonshotAI/kimi-code
        // packages/oauth/src/managed-usage.ts `kimiCodeUsageUrl`.
        ("kimi", "https://api.kimi.com/coding/v1") => Some("https://api.kimi.com/coding/v1/usages"),
        ("kimi", "https://api.kimi.ai/coding/v1") => Some("https://api.kimi.ai/coding/v1/usages"),
        _ => None,
    }
}
/// SuperGrok subscription credits, read with the OAuth token the subscription
/// chat proxy already receives; ref: xai-org/grok-build
/// crates/codegen/xai-grok-shell/src/extensions/billing.rs @2bdd1d6a.
pub const GROK_CREDITS_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/// Only the Moonshot platform balance endpoint returns money; every other
/// quota endpoint returns usage windows.
pub fn reads_balance(url: &str) -> bool {
    url.ends_with("/users/me/balance")
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
                    source: Some(QuotaSource {
                        field: percent.into(),
                        value: remaining,
                        window_seconds: item
                            .get(reset)
                            .and_then(|v| v.as_i64())
                            .zip(
                                item.get(if period == "weekly" {
                                    "weekly_start_time"
                                } else {
                                    "start_time"
                                })
                                .and_then(|v| v.as_i64()),
                            )
                            .and_then(|(end, start)| end.checked_sub(start))
                            .filter(|duration| *duration > 0 && duration % 1000 == 0)
                            .and_then(|duration| u64::try_from(duration / 1000).ok()),
                        status: item
                            .get(status)
                            .and_then(|v| v.as_u64())
                            .and_then(|v| u32::try_from(v).ok()),
                        ..Default::default()
                    }),
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
                source: Some(QuotaSource {
                    field: "percentage".into(),
                    value: used,
                    unit: item
                        .get("unit")
                        .and_then(|v| v.as_u64())
                        .and_then(|v| u32::try_from(v).ok()),
                    number: item
                        .get("number")
                        .and_then(|v| v.as_u64())
                        .and_then(|v| u32::try_from(v).ok()),
                    ..Default::default()
                }),
                tool_only: kind != "TOKENS_LIMIT",
                remaining_percent: used.map(|v| 100.0 - v),
                // Observed epoch-ms response and direct Date.now()/new Date use: docs/internals/gateway-api-quotas.md#zai-reset-unit-evidence.
                resets_at_ms: item
                    .get("nextResetTime")
                    .and_then(|v| v.as_i64())
                    .filter(|v| *v > 0),
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
        balance_is_exhausted, is_model_not_found_cooldown, quota_applies, quota_is_exhausted,
        AccountBalance, AccountState, QuotaSource, QuotaWindow,
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
        runtime::executor::{
            ApiKeyHttpClient, DEFAULT_XAI_API_BASE_URL, DEFAULT_XAI_CHAT_BASE_URL,
            XAI_CLIENT_VERSION_HEADER, XAI_CLIENT_VERSION_VALUE, XAI_TOKEN_AUTH_HEADER,
            XAI_TOKEN_AUTH_VALUE,
        },
    },
    sdk::{
        cliproxy::auth::{
            scheduler::canonical_model_key, AccountCandidate, CooldownStateRecord,
            CooldownStateStore,
        },
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
    pub models: Vec<AccountModelHealth>,
}
/// Route eligibility for an exact configured model. A successful account-wide
/// usage probe is not proof that this model can be selected for a real turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountModelHealth {
    pub model_id: String,
    pub status: &'static str,
    pub usable: bool,
    pub cooldown_until_ms: Option<i64>,
    pub error_code: Option<String>,
    pub http_status: Option<u16>,
    pub observed_at_ms: Option<i64>,
}

fn model_health(
    account: &AccountCandidate,
    model: &str,
    records: Option<&[CooldownStateRecord]>,
    quotas: &[QuotaWindow],
    balance: Option<&AccountBalance>,
    now: i64,
) -> AccountModelHealth {
    let requested = canonical_model_key(model);
    let relevant = records
        .into_iter()
        .flatten()
        .filter(|record| {
            record.provider.eq_ignore_ascii_case(&account.provider)
                && record.auth_id == account.auth_id
                && !(record.model.is_none() && is_model_not_found_cooldown(record))
                && record
                    .model
                    .as_deref()
                    .is_none_or(|name| canonical_model_key(name) == requested)
        })
        .collect::<Vec<_>>();
    let latest = relevant.iter().max_by_key(|record| record.updated_at_ms);
    let blocked = relevant.iter().any(|record| !record.is_available_at(now));
    let cooldown_until_ms = relevant
        .iter()
        .filter(|record| !record.is_available_at(now))
        .filter_map(|record| record.blocking_until_ms())
        .filter(|until| *until > now)
        .max();
    let exhausted_windows = quotas
        .iter()
        .filter(|window| {
            quota_applies(window, &requested)
                && (window.name != "seven_day_opus"
                    || requested.to_ascii_lowercase().contains("opus"))
                && (window.name != "seven_day_sonnet"
                    || requested.to_ascii_lowercase().contains("sonnet"))
                && quota_is_exhausted(window, now)
        })
        .collect::<Vec<_>>();
    let exhausted = !exhausted_windows.is_empty();
    let retry_at_ms = cooldown_until_ms.max(
        exhausted_windows
            .iter()
            .filter_map(|window| window.resets_at_ms)
            .filter(|until| *until > now)
            .max(),
    );
    let status = if account.disabled {
        "disabled"
    } else if records.is_none() {
        "unknown"
    } else if relevant.iter().any(|record| {
        !record.is_available_at(now)
            && record
                .last_error
                .as_ref()
                .is_some_and(|error| error.http_status == Some(401))
    }) {
        "auth-required"
    } else if blocked
        && relevant
            .iter()
            .filter(|record| !record.is_available_at(now))
            .all(|record| record.model.is_some() && is_model_not_found_cooldown(record))
    {
        "model-unavailable"
    } else if blocked {
        "cooldown"
    } else if balance.is_some_and(|balance| balance_is_exhausted(balance, now)) {
        "balance"
    } else if exhausted {
        "quota"
    } else {
        "ready"
    };
    AccountModelHealth {
        model_id: model.to_owned(),
        status,
        usable: status == "ready",
        cooldown_until_ms: retry_at_ms,
        error_code: latest
            .and_then(|record| record.last_error.as_ref())
            .map(|error| error.code.clone()),
        http_status: latest
            .and_then(|record| record.last_error.as_ref())
            .and_then(|error| error.http_status),
        observed_at_ms: latest
            .map(|record| record.updated_at_ms)
            .into_iter()
            .chain(exhausted_windows.iter().map(|window| window.observed_at_ms))
            .max(),
    }
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
        // The OAuth token reaches the subscription chat proxy only for the
        // default upstream; a custom upstream never receives a credits read.
        for account in config.xai_accounts().iter().filter(|a| !a.disabled) {
            if account.base_url().is_ok_and(|base| {
                base == DEFAULT_XAI_API_BASE_URL || base == DEFAULT_XAI_CHAT_BASE_URL
            }) {
                probes.push(Probe {
                    provider: "xai".into(),
                    id: account.id.clone(),
                    access: account.access_token_secret.clone(),
                    proxy: account.proxy_url_secret.clone(),
                    url: GROK_CREDITS_URL,
                    id_token: None,
                });
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
                    .filter(|r| !is_model_not_found_cooldown(r))
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
                let models = a
                    .supported_models
                    .iter()
                    .filter(|model| !model.contains('*'))
                    .take(256)
                    .map(|model| {
                        model_health(a, model, records.as_deref(), &quotas, balance.as_ref(), now)
                    })
                    .collect();
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
                    models,
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
                        if response.status_code == 200 && reads_balance(probe.url) {
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
    if probe.url == GROK_CREDITS_URL {
        headers.insert(
            XAI_TOKEN_AUTH_HEADER.into(),
            vec![XAI_TOKEN_AUTH_VALUE.into()],
        );
        headers.insert(
            XAI_CLIENT_VERSION_HEADER.into(),
            vec![XAI_CLIENT_VERSION_VALUE.into()],
        );
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
    if provider == "kimi" {
        return parse_kimi_code_usage(&value, observed);
    }
    if provider == "xai" {
        return parse_grok_credits(&value, observed);
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
                source: Some(QuotaSource {
                    field: "used_percent".into(),
                    value: used,
                    window_seconds: window
                        .get("limit_window_seconds")
                        .and_then(|v| v.as_u64())
                        .filter(|v| *v > 0),
                    ..Default::default()
                }),
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
                source: Some(QuotaSource {
                    field: "utilization".into(),
                    value: used,
                    window_seconds: Some(if name == "five_hour" { 18_000 } else { 604_800 }),
                    ..Default::default()
                }),
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
/// The app contract (`WorkjetGatewayQuotaWindow.source.field`) accepts only
/// whitelisted names with a 0..100 value; an unknown name makes the app drop
/// every account's health. Kimi Code `used_ratio` (0..1) and SuperGrok
/// `creditUsagePercent` (0..100) are both a used share, carried as percent.
const KIMI_GROK_SOURCE_FIELD: &str = "used_percent";
fn rfc3339_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    value
        .and_then(|v| v.as_str())
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.timestamp_millis())
        .filter(|v| *v > 0)
}
/// The vendor accepts numbers and numeric strings for ratios and counts.
fn finite_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|v| v.is_finite())
}
/// Kimi Code `GET {base}/usages`. The current shape carries `usages.limit_5h`,
/// `limit_7d` and `limit_month_total` as `{used_ratio, reset_time}`;
/// `limit_month_code` is a sub-budget of the monthly total, not its own window.
/// ref: MoonshotAI/kimi-code packages/oauth/src/managed-usage.ts.
/// The older shape (`usage` plus `limits[]` with `detail{limit,used,remaining}`)
/// is read only when `usages` is absent; ref: MoonshotAI/kimi-cli
/// src/kimi_cli/ui/shell/usage.py.
fn parse_kimi_code_usage(value: &serde_json::Value, observed: i64) -> Option<Vec<QuotaWindow>> {
    let mut windows = Vec::new();
    if let Some(usages) = value.get("usages") {
        let usages = usages.as_object()?;
        for (name, seconds) in [
            ("limit_5h", Some(18_000)),
            ("limit_7d", Some(604_800)),
            ("limit_month_total", None),
        ] {
            let Some(entry) = usages.get(name).filter(|v| v.is_object()) else {
                continue;
            };
            let used = finite_number(entry.get("used_ratio"))
                .filter(|v| (0.0..=1.0).contains(v))
                .map(|v| v * 100.0);
            windows.push(QuotaWindow {
                name: name.into(),
                source: Some(QuotaSource {
                    field: KIMI_GROK_SOURCE_FIELD.into(),
                    value: used,
                    window_seconds: seconds,
                    ..Default::default()
                }),
                remaining_percent: used.map(|v| 100.0 - v),
                resets_at_ms: rfc3339_ms(entry.get("reset_time")),
                observed_at_ms: observed,
                ..Default::default()
            });
        }
        return Some(windows);
    }
    let legacy = |name: String, detail: &serde_json::Value, seconds: Option<u64>| {
        let limit = finite_number(detail.get("limit")).filter(|v| *v > 0.0);
        let used = finite_number(detail.get("used")).or_else(|| {
            finite_number(detail.get("remaining"))
                .zip(limit)
                .map(|(remaining, limit)| limit - remaining)
        });
        // Same clamp as the vendor CLI: remaining = min(max(limit - used, 0), limit).
        let used = limit
            .zip(used)
            .map(|(limit, used)| (used / limit).clamp(0.0, 1.0) * 100.0);
        let reset = ["resetTime", "reset_time", "resetAt", "reset_at"]
            .into_iter()
            .find_map(|key| rfc3339_ms(detail.get(key)));
        QuotaWindow {
            name,
            source: Some(QuotaSource {
                field: KIMI_GROK_SOURCE_FIELD.into(),
                value: used,
                window_seconds: seconds,
                ..Default::default()
            }),
            remaining_percent: used.map(|v| 100.0 - v),
            resets_at_ms: reset,
            observed_at_ms: observed,
            ..Default::default()
        }
    };
    let usage = value.get("usage").filter(|v| v.is_object());
    let limits = value.get("limits").and_then(|v| v.as_array());
    if usage.is_none() && limits.is_none() {
        return None;
    }
    if let Some(usage) = usage {
        windows.push(legacy("usage".into(), usage, None));
    }
    for (index, item) in limits.into_iter().flatten().enumerate() {
        let Some(detail) = item.get("detail").filter(|v| v.is_object()) else {
            continue;
        };
        let window = item.get("window").filter(|v| v.is_object());
        let duration = window
            .and_then(|w| w.get("duration"))
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0);
        let unit = window
            .and_then(|w| w.get("timeUnit"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let seconds = duration.and_then(|d| {
            if unit.contains("MINUTE") {
                d.checked_mul(60)
            } else if unit.contains("HOUR") {
                d.checked_mul(3_600)
            } else if unit.contains("DAY") {
                d.checked_mul(86_400)
            } else {
                None
            }
        });
        windows.push(legacy(format!("limit_{index}"), detail, seconds));
    }
    Some(windows)
}
/// SuperGrok credits (`GetGrokCreditsConfig`): one shared weekly or monthly
/// pool. `creditUsagePercent` is the used share; on-demand spend is a separate
/// money cap and never becomes a window.
fn parse_grok_credits(value: &serde_json::Value, observed: i64) -> Option<Vec<QuotaWindow>> {
    let config = value.get("config").filter(|v| v.is_object())?;
    let used = config
        .get("creditUsagePercent")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
    let period = config.get("currentPeriod").filter(|v| v.is_object());
    let start = rfc3339_ms(period.and_then(|p| p.get("start")))
        .or_else(|| rfc3339_ms(config.get("billingPeriodStart")));
    let end = rfc3339_ms(period.and_then(|p| p.get("end")))
        .or_else(|| rfc3339_ms(config.get("billingPeriodEnd")));
    let (name, seconds) = match period.and_then(|p| p.get("type")).and_then(|v| v.as_str()) {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => ("weekly", Some(604_800)),
        Some("USAGE_PERIOD_TYPE_MONTHLY") => (
            "monthly",
            // Calendar months differ in length; only the reported bounds qualify one.
            start
                .zip(end)
                .and_then(|(start, end)| end.checked_sub(start))
                .filter(|ms| *ms > 0 && ms % 1000 == 0)
                .and_then(|ms| u64::try_from(ms / 1000).ok()),
        ),
        _ => ("credits", None),
    };
    Some(vec![QuotaWindow {
        name: name.into(),
        source: Some(QuotaSource {
            field: KIMI_GROK_SOURCE_FIELD.into(),
            value: used,
            window_seconds: seconds,
            ..Default::default()
        }),
        remaining_percent: used.map(|v| 100.0 - v),
        resets_at_ms: end,
        observed_at_ms: observed,
        ..Default::default()
    }])
}
#[cfg(test)]
mod quota_probe_tests {
    use super::*;
    use workjet_provider_gateway::internal::config::{
        ApiKeyAccountConfig, CliproxyRuntimeConfig, XaiSubscriptionAccountConfig,
    };
    use workjet_provider_gateway::sdk::cliproxy::auth::SchedulerStrategy;

    fn secret(name: &str) -> RuntimeSecretRef {
        RuntimeSecretRef {
            scope: crate::config::ALLOWED_SECRET_SCOPE.to_owned(),
            name: name.to_owned(),
        }
    }

    fn xai(id: &str, base: &str, disabled: bool) -> XaiSubscriptionAccountConfig {
        XaiSubscriptionAccountConfig {
            id: id.into(),
            disabled,
            priority: 0,
            models: vec!["grok-4.7".into()],
            access_token_secret: secret(&format!("{id}.access")),
            refresh_token_secret: secret(&format!("{id}.refresh")),
            upstream_base_url: base.into(),
            token_endpoint: String::new(),
            proxy_url_secret: None,
        }
    }

    fn kimi(id: &str, base: &str) -> ApiKeyAccountConfig {
        ApiKeyAccountConfig {
            id: id.into(),
            provider: "kimi".into(),
            disabled: false,
            priority: 0,
            weight: 1,
            models: vec![],
            api_key_secret: secret(&format!("{id}.key")),
            upstream_base_url: base.into(),
            proxy_url_secret: None,
        }
    }

    #[test]
    fn subscription_and_coding_plan_accounts_get_exactly_one_vendor_quota_read() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let store = Arc::new(WorkjetSecretStore::new(root.path().to_owned()).unwrap());
        let state = AccountState::open(store.clone()).unwrap();
        let config = CliproxyRuntimeConfig {
            request_timeout_ms: 1_000,
            routing_strategy: SchedulerStrategy::RoundRobin,
            claude_accounts: Vec::new(),
            codex_accounts: Vec::new(),
            antigravity_accounts: Vec::new(),
            api_key_accounts: vec![
                kimi("kimi-code", "https://api.kimi.com/coding/v1"),
                kimi("kimi-platform", ""),
            ],
            xai_accounts: vec![
                xai("grok-default", "", false),
                xai("grok-proxy", "https://cli-chat-proxy.grok.com/v1", false),
                xai("grok-custom", "https://grok.example/v1", false),
                xai("grok-off", "", true),
            ],
        }
        .validate_for_extension_host()
        .unwrap();
        let source = AccountHealthSource::new(state, store, &config);
        let probes: Vec<_> = source
            .probes
            .iter()
            .map(|p| (p.provider.as_str(), p.id.as_str(), p.url))
            .collect();
        assert_eq!(
            probes,
            [
                ("kimi", "kimi-code", "https://api.kimi.com/coding/v1/usages"),
                (
                    "kimi",
                    "kimi-platform",
                    "https://api.moonshot.ai/v1/users/me/balance"
                ),
                ("xai", "grok-default", GROK_CREDITS_URL),
                ("xai", "grok-proxy", GROK_CREDITS_URL),
            ]
        );
        let health = source.snapshot();
        let supported = |id: &str| {
            health["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["accountId"] == id)
                .unwrap()["quotaSupported"]
                .clone()
        };
        assert_eq!(supported("grok-default"), true);
        assert_eq!(supported("grok-custom"), false);
        assert_eq!(supported("kimi-code"), true);
    }
}
