use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use workjet_provider_gateway::internal::api::server_management::{
    ManagementProviderConfigSummary, ManagementRuntimeConfigError, ManagementRuntimeConfigMutation,
    ManagementRuntimeConfigSource, ManagementRuntimeConfigSummary, ManagementRuntimeEndpoint,
    ManagementRuntimePhase, ManagementRuntimeStatus, ManagementRuntimeStatusSource,
};
use workjet_provider_gateway::internal::api::server_routes::{
    AuxiliaryRouteChain, AuxiliaryRouteHandler, ClaudeCountTokensRouteHandler,
};
use workjet_provider_gateway::internal::auth::antigravity::{
    AntigravityHttpTransport, AntigravityOAuthClientCredentials, AntigravityRefreshCoordinator,
};
use workjet_provider_gateway::internal::auth::claude::{
    AnthropicHttpTransport, ClaudeRefreshCoordinator, SystemRefreshClock,
};
use workjet_provider_gateway::internal::auth::codex::{
    CodexHttpTransport, SystemRefreshClock as CodexSystemRefreshClock,
};
use workjet_provider_gateway::internal::client::claude::models::ClaudeModel;
use workjet_provider_gateway::internal::config::{RuntimeSecretRef, ValidatedRuntimeConfig};
use workjet_provider_gateway::internal::runtime::executor::{
    AccountStateClock, AntigravityGenerateHttpTransport, AntigravitySubscriptionAccountPool,
    AntigravitySubscriptionAuth, AntigravitySubscriptionExecutor, ClaudeCloakPolicy,
    ClaudeMessagesHttpTransport, ClaudeSubscriptionAccountPool, ClaudeSubscriptionAuth,
    ClaudeSubscriptionMessagesExecutor, CodexResponsesHttpTransport, CodexSubscriptionAccountPool,
    CodexSubscriptionAuth, CodexSubscriptionResponsesExecutor, SystemAntigravityAuthClock,
};
use workjet_provider_gateway::sdk::api::handlers::claude::code_handlers::{
    claude_models_response, ClaudeMessagesAntigravityHandler, ClaudeMessagesClaudeHandler,
    ClaudeMessagesHttpResponse, ClaudeMessagesRouteHandler,
};
use zeroize::Zeroizing;

use workjet_provider_gateway::internal::runtime::executor::xai_subscription_pool::{
    xai_subscription_auth_record, XaiAuthPersist, XaiSubscriptionAccountPool,
    XaiSubscriptionPoolAccount,
};
use workjet_provider_gateway::internal::runtime::executor::{
    ApiKeyHttpClient, XaiAuthClock, XaiExecutor, XaiSubscriptionAuth, XaiSubscriptionHttpTransport,
};
use workjet_provider_gateway::sdk::api::handlers::openai::openai_responses_api_key_handlers::{
    ApiKeyAccount, ApiKeyAccountPool, OpenAiResponsesApiKeyHandler,
};
use workjet_provider_gateway::sdk::api::handlers::openai::openai_responses_handlers::{
    OpenAiResponsesAntigravityHandler, OpenAiResponsesClaudeHandler, OpenAiResponsesCodexHandler,
    OpenAiResponsesProviderRouter,
};
use workjet_provider_gateway::sdk::api::handlers::openai::openai_responses_xai_handlers::OpenAiResponsesXaiHandler;
use workjet_provider_gateway::sdk::cliproxy::auth::Auth;
use workjet_provider_gateway::sdk::cliproxy::auth::{
    AccountRouter, CooldownConductor, CooldownStateRecord, CooldownStateStore, CooldownStoreError,
};
use workjet_provider_gateway::sdk::pluginapi::HostHttpClient;
use workjet_provider_gateway::sdk::translator::builtin::registry as builtin_registry;

use crate::secret_store::{SecretResolveError, WorkjetSecretStore};

#[derive(Default)]
struct MemoryCooldownStore(Mutex<Vec<CooldownStateRecord>>);

impl CooldownStateStore for MemoryCooldownStore {
    fn load(&self) -> Result<Vec<CooldownStateRecord>, CooldownStoreError> {
        Ok(self.0.lock().map_err(|_| CooldownStoreError::Read)?.clone())
    }

    fn save(&self, records: &[CooldownStateRecord]) -> Result<(), CooldownStoreError> {
        *self.0.lock().map_err(|_| CooldownStoreError::Write)? = records.to_vec();
        Ok(())
    }
}

#[derive(Debug)]
struct SystemAccountClock;

impl AccountStateClock for SystemAccountClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or(i64::MAX)
    }
}

#[derive(Debug)]
struct SystemXaiAuthClock;

impl XaiAuthClock for SystemXaiAuthClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// Writes a rotated xAI credential back into the secret files the account's
/// configuration references. A failed write is not fatal to the running
/// request — the refreshed token stays live in the pool — but the next
/// restart would resume from the previous refresh token.
struct XaiSecretPersist {
    store: Arc<WorkjetSecretStore>,
    refs: HashMap<String, (RuntimeSecretRef, RuntimeSecretRef)>,
}

impl XaiAuthPersist for XaiSecretPersist {
    fn persist(&self, account_id: &str, auth: &Auth) {
        let Some((access_ref, refresh_ref)) = self.refs.get(account_id) else {
            return;
        };
        if let Some(access) = auth.metadata.get("access_token").and_then(|v| v.as_str()) {
            let _ = self.store.write_text(access_ref, access);
        }
        if let Some(refresh) = auth.metadata.get("refresh_token").and_then(|v| v.as_str()) {
            let _ = self.store.write_text(refresh_ref, refresh);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeBuildError {
    Secret,
    Transport,
    Configuration,
}

impl fmt::Display for RuntimeBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider runtime could not be assembled")
    }
}

impl std::error::Error for RuntimeBuildError {}

pub struct ProviderRoutes {
    pub responses: Arc<OpenAiResponsesProviderRouter>,
    pub messages: Option<Arc<dyn ClaudeMessagesRouteHandler>>,
    pub auxiliary: Option<Arc<dyn AuxiliaryRouteHandler>>,
    pub models: ClaudeMessagesHttpResponse,
}

fn state_authorities(
    config: &ValidatedRuntimeConfig,
) -> (Arc<AccountRouter>, Arc<CooldownConductor>) {
    let store = Arc::new(MemoryCooldownStore::default());
    (
        Arc::new(AccountRouter::with_strategy(
            store.clone(),
            config.routing_strategy(),
        )),
        Arc::new(CooldownConductor::new(store)),
    )
}

fn proxy_url(
    store: &WorkjetSecretStore,
    reference: Option<&RuntimeSecretRef>,
) -> Result<Option<zeroize::Zeroizing<String>>, RuntimeBuildError> {
    reference
        .map(|reference| {
            store
                .resolve_text(reference)
                .map_err(|_| RuntimeBuildError::Secret)
        })
        .transpose()
}

/// Assembles the provider routing surface. Returns `Ok(None)` for a host that
/// has no provider account at all - a bootstrap host whose provider endpoint
/// has nothing to route to yet, but whose management surface must still run.
pub fn build_provider_routes(
    config: &ValidatedRuntimeConfig,
    default_provider: Option<&str>,
    store: Arc<WorkjetSecretStore>,
    antigravity_oauth: Option<(RuntimeSecretRef, RuntimeSecretRef)>,
) -> Result<Option<ProviderRoutes>, RuntimeBuildError> {
    let Some(default_provider) = default_provider else {
        return Ok(None);
    };
    let account_clock: Arc<dyn AccountStateClock> = Arc::new(SystemAccountClock);
    let mut auxiliary_handlers: Vec<Arc<dyn AuxiliaryRouteHandler>> = Vec::new();

    let mut claude_messages: Option<Arc<dyn ClaudeMessagesRouteHandler>> = None;
    let claude = if config.claude_accounts().is_empty() {
        None
    } else {
        let (router, conductor) = state_authorities(config);
        let mut executors = HashMap::new();
        let mut targets = HashMap::new();
        for account in config.claude_accounts() {
            let configured_proxy = proxy_url(&store, account.proxy_url_secret.as_ref())?;
            let refresh = Arc::new(
                AnthropicHttpTransport::new(configured_proxy.as_deref().map(String::as_str))
                    .map_err(|_| RuntimeBuildError::Transport)?,
            );
            let messages = Arc::new(
                ClaudeMessagesHttpTransport::new(configured_proxy.as_deref().map(String::as_str))
                    .map_err(|_| RuntimeBuildError::Transport)?,
            );
            let auth = Arc::new(ClaudeSubscriptionAuth::new(
                account
                    .credential_handles()
                    .map_err(|_| RuntimeBuildError::Configuration)?,
                store.clone(),
                refresh,
                Arc::new(SystemRefreshClock),
                Arc::new(ClaudeRefreshCoordinator::default()),
            ));
            let mut executor = ClaudeSubscriptionMessagesExecutor::new(
                auth,
                messages.clone(),
                config.request_timeout(),
            )
            .with_account_state_clock(account.id.clone(), conductor.clone(), account_clock.clone())
            .map_err(|_| RuntimeBuildError::Configuration)?
            .with_cloak_policy(
                ClaudeCloakPolicy::oauth_default().with_timezone(
                    account
                        .timezone()
                        .map_err(|_| RuntimeBuildError::Configuration)?,
                ),
            )
            .with_stream_transport(messages);
            if let Some(profile) = account.device_profile.clone() {
                executor = executor.with_device_profile(
                    profile
                        .into_profile()
                        .map_err(|_| RuntimeBuildError::Configuration)?,
                );
            }
            executors.insert(account.id.clone(), Arc::new(executor));
            targets.insert(
                account.id.clone(),
                account
                    .upstream_target()
                    .map_err(|_| RuntimeBuildError::Configuration)?,
            );
        }
        let pool = Arc::new(
            ClaudeSubscriptionAccountPool::with_clock(
                router,
                config.claude_candidates(),
                executors,
                account_clock.clone(),
            )
            .and_then(|pool| pool.with_targets(targets))
            .map_err(|_| RuntimeBuildError::Configuration)?,
        );
        auxiliary_handlers.push(Arc::new(ClaudeCountTokensRouteHandler::new(pool.clone())));
        // The Messages route is what a gateway-routed Claude Code CLI calls
        // (`ANTHROPIC_BASE_URL` + `/v1/messages`). Serving Claude accounts
        // only through the Responses shape left that CLI a 404 — measured
        // 2026-08-24 — which it reported as a model problem.
        claude_messages = Some(Arc::new(ClaudeMessagesClaudeHandler::new(pool.clone()))
            as Arc<dyn ClaudeMessagesRouteHandler>);
        Some(Arc::new(OpenAiResponsesClaudeHandler::new(pool)))
    };

    let codex = if config.codex_accounts().is_empty() {
        None
    } else {
        let (router, conductor) = state_authorities(config);
        let mut executors = HashMap::new();
        let mut targets = HashMap::new();
        for account in config.codex_accounts() {
            let configured_proxy = proxy_url(&store, account.proxy_url_secret.as_ref())?;
            let refresh = Arc::new(
                CodexHttpTransport::new(configured_proxy.as_deref().map(String::as_str))
                    .map_err(|_| RuntimeBuildError::Transport)?,
            );
            let responses = Arc::new(
                CodexResponsesHttpTransport::new(configured_proxy.as_deref().map(String::as_str))
                    .map_err(|_| RuntimeBuildError::Transport)?,
            );
            let auth = Arc::new(CodexSubscriptionAuth::new(
                account
                    .credential_handles()
                    .map_err(|_| RuntimeBuildError::Configuration)?,
                store.clone(),
                refresh,
                Arc::new(CodexSystemRefreshClock),
                Arc::new(Default::default()),
            ));
            let executor = CodexSubscriptionResponsesExecutor::new(
                auth,
                responses.clone(),
                config.request_timeout(),
            )
            .map_err(|_| RuntimeBuildError::Configuration)?
            .with_plan_type(account.plan_type.clone())
            .with_stream_transport(responses);
            executors.insert(account.id.clone(), Arc::new(executor));
            targets.insert(
                account.id.clone(),
                account
                    .upstream_target()
                    .map_err(|_| RuntimeBuildError::Configuration)?,
            );
        }
        let pool = CodexSubscriptionAccountPool::with_clock(
            router,
            conductor,
            config.codex_candidates(),
            executors,
            targets,
            account_clock.clone(),
        )
        .map_err(|_| RuntimeBuildError::Configuration)?;
        Some(Arc::new(OpenAiResponsesCodexHandler::new(Arc::new(pool))))
    };

    let mut messages: Option<Arc<dyn ClaudeMessagesRouteHandler>> = None;
    let antigravity = if config.antigravity_accounts().is_empty() {
        None
    } else {
        let (client_id_ref, client_secret_ref) =
            antigravity_oauth.ok_or(RuntimeBuildError::Configuration)?;
        let client_id = store
            .resolve_text(&client_id_ref)
            .map_err(|_| RuntimeBuildError::Secret)?;
        let client_secret = store
            .resolve_text(&client_secret_ref)
            .map_err(|_| RuntimeBuildError::Secret)?;
        let coordinator = Arc::new(AntigravityRefreshCoordinator::new(Arc::new(
            AntigravityOAuthClientCredentials::new(
                client_id.to_string(),
                client_secret.to_string(),
            )
            .map_err(|_| RuntimeBuildError::Configuration)?,
        )));
        let (router, conductor) = state_authorities(config);
        let mut executors = HashMap::new();
        let mut targets = HashMap::new();
        for account in config.antigravity_accounts() {
            let configured_proxy = proxy_url(&store, account.proxy_url_secret.as_ref())?;
            let refresh = Arc::new(
                AntigravityHttpTransport::new(configured_proxy.as_deref().map(String::as_str))
                    .map_err(|_| RuntimeBuildError::Transport)?,
            );
            let generate = Arc::new(
                AntigravityGenerateHttpTransport::new(
                    configured_proxy.as_deref().map(String::as_str),
                )
                .map_err(|_| RuntimeBuildError::Transport)?,
            );
            let auth = Arc::new(AntigravitySubscriptionAuth::new(
                account
                    .credential_handles()
                    .map_err(|_| RuntimeBuildError::Configuration)?,
                store.clone(),
                refresh,
                Arc::new(SystemAntigravityAuthClock),
                coordinator.clone(),
            ));
            let executor = AntigravitySubscriptionExecutor::new(
                auth,
                generate.clone(),
                config.request_timeout(),
            )
            .map_err(|_| RuntimeBuildError::Configuration)?
            .with_stream_transport(generate);
            executors.insert(account.id.clone(), Arc::new(executor));
            targets.insert(
                account.id.clone(),
                account
                    .upstream_target()
                    .map_err(|_| RuntimeBuildError::Configuration)?,
            );
        }
        let pool = Arc::new(
            AntigravitySubscriptionAccountPool::with_clock(
                router,
                conductor,
                config.antigravity_candidates(),
                executors,
                targets,
                account_clock,
            )
            .map_err(|_| RuntimeBuildError::Configuration)?,
        );
        messages = Some(Arc::new(ClaudeMessagesAntigravityHandler::new(
            pool.clone(),
            None,
            Arc::new(|_, _| false),
        )) as Arc<dyn ClaudeMessagesRouteHandler>);
        Some(Arc::new(OpenAiResponsesAntigravityHandler::new(pool)))
    };

    // API-key providers. Each provider gets its own pool, so a request routed
    // to `zai` can only ever be signed with a zai account's key.
    let mut api_key_handlers: BTreeMap<String, Arc<OpenAiResponsesApiKeyHandler>> = BTreeMap::new();
    if !config.api_key_accounts().is_empty() {
        let registry = builtin_registry();
        for provider in config.api_key_providers() {
            let mut accounts = Vec::new();
            for account in config.api_key_accounts_for(provider) {
                let configured_proxy = proxy_url(&store, account.proxy_url_secret.as_ref())?;
                let http_client: Arc<dyn HostHttpClient> = Arc::new(
                    ApiKeyHttpClient::new(
                        configured_proxy.as_deref().map(String::as_str),
                        config.request_timeout(),
                    )
                    .map_err(|_| RuntimeBuildError::Transport)?,
                );
                let api_key = store
                    .resolve_text(&account.api_key_secret)
                    .map_err(|_| RuntimeBuildError::Secret)?;
                accounts.push(
                    ApiKeyAccount::new(
                        account.id.clone(),
                        account
                            .base_url()
                            .map_err(|_| RuntimeBuildError::Configuration)?,
                        Zeroizing::new(api_key.to_string()),
                        account.models.clone(),
                        account.priority,
                        account.disabled,
                        http_client,
                    )
                    .map_err(|_| RuntimeBuildError::Configuration)?,
                );
            }
            let pool = ApiKeyAccountPool::new(provider, accounts, registry.clone())
                .map_err(|_| RuntimeBuildError::Configuration)?;
            api_key_handlers.insert(
                provider.to_owned(),
                Arc::new(OpenAiResponsesApiKeyHandler::new(Arc::new(pool))),
            );
        }
    }

    // xAI subscription accounts. The pool carries ONE executor, so a proxy
    // must be pool-wide: differing per-account proxies are refused rather
    // than silently routing some accounts through the wrong egress.
    let xai = if config.xai_accounts().is_empty() {
        None
    } else {
        let mut pool_proxy: Option<Option<zeroize::Zeroizing<String>>> = None;
        let mut accounts = Vec::new();
        let mut persist_refs = HashMap::new();
        for account in config.xai_accounts() {
            let configured_proxy = proxy_url(&store, account.proxy_url_secret.as_ref())?;
            match &pool_proxy {
                None => pool_proxy = Some(configured_proxy),
                Some(existing) => {
                    if existing.as_deref().map(String::as_str)
                        != configured_proxy.as_deref().map(String::as_str)
                    {
                        return Err(RuntimeBuildError::Configuration);
                    }
                }
            }
            let access = store
                .resolve_text(&account.access_token_secret)
                .map_err(|_| RuntimeBuildError::Secret)?;
            let refresh = store
                .resolve_text(&account.refresh_token_secret)
                .map_err(|_| RuntimeBuildError::Secret)?;
            let base_url = account
                .base_url()
                .map_err(|_| RuntimeBuildError::Configuration)?;
            let mut auth =
                xai_subscription_auth_record(&account.id, &access, Some(&refresh), Some(&base_url));
            let token_endpoint = account.token_endpoint.trim();
            if !token_endpoint.is_empty() {
                auth.metadata.insert(
                    "token_endpoint".into(),
                    serde_json::Value::String(token_endpoint.to_owned()),
                );
            }
            persist_refs.insert(
                account.id.clone(),
                (
                    account.access_token_secret.clone(),
                    account.refresh_token_secret.clone(),
                ),
            );
            accounts.push(XaiSubscriptionPoolAccount {
                id: account.id.clone(),
                label: account.id.clone(),
                models: account.models.clone(),
                priority: account.priority,
                disabled: account.disabled,
                auth,
            });
        }
        let proxy = pool_proxy.flatten();
        let transport = Arc::new(
            XaiSubscriptionHttpTransport::new(proxy.as_deref().map(String::as_str))
                .map_err(|_| RuntimeBuildError::Transport)?,
        );
        let executor = XaiExecutor::new(transport.clone(), config.request_timeout())
            .map_err(|_| RuntimeBuildError::Configuration)?
            .with_stream_transport(transport.clone());
        let auth = XaiSubscriptionAuth::new(
            transport,
            Arc::new(SystemXaiAuthClock),
            workjet_provider_gateway::internal::runtime::executor::DEFAULT_XAI_API_BASE_URL,
        );
        let pool = XaiSubscriptionAccountPool::new(accounts, executor, auth)
            .map_err(|_| RuntimeBuildError::Configuration)?
            .with_persist(Arc::new(XaiSecretPersist {
                store: store.clone(),
                refs: persist_refs,
            }));
        Some(Arc::new(OpenAiResponsesXaiHandler::new(Arc::new(pool))))
    };

    let responses = Arc::new(
        OpenAiResponsesProviderRouter::with_all_handlers(
            default_provider,
            claude,
            codex,
            antigravity,
            api_key_handlers,
            xai,
        )
        .map_err(|_| RuntimeBuildError::Configuration)?,
    );
    let auxiliary = (!auxiliary_handlers.is_empty()).then(|| {
        Arc::new(AuxiliaryRouteChain::new(auxiliary_handlers)) as Arc<dyn AuxiliaryRouteHandler>
    });
    Ok(Some(ProviderRoutes {
        responses,
        // Claude first: on a host with Claude accounts the Messages route
        // belongs to them; Antigravity keeps it only where it is the sole
        // subscription that can serve the shape.
        messages: claude_messages.or(messages),
        auxiliary,
        models: claude_models_response(&model_catalog(config), false),
    }))
}

fn model_catalog(config: &ValidatedRuntimeConfig) -> Vec<ClaudeModel> {
    let mut models = BTreeMap::<String, BTreeSet<String>>::new();
    for (provider, configured) in [("claude", config.claude_accounts())] {
        for account in configured.iter().filter(|account| !account.disabled) {
            for model in &account.models {
                models
                    .entry(model.clone())
                    .or_default()
                    .insert(provider.to_owned());
            }
        }
    }
    for account in config
        .codex_accounts()
        .iter()
        .filter(|account| !account.disabled)
    {
        for model in &account.models {
            models
                .entry(model.clone())
                .or_default()
                .insert("codex".to_owned());
        }
    }
    for account in config
        .antigravity_accounts()
        .iter()
        .filter(|account| !account.disabled)
    {
        for model in &account.models {
            models
                .entry(model.clone())
                .or_default()
                .insert("antigravity".to_owned());
        }
    }
    for account in config
        .api_key_accounts()
        .iter()
        .filter(|account| !account.disabled)
    {
        for model in &account.models {
            models
                .entry(model.clone())
                .or_default()
                .insert(account.provider.trim().to_owned());
        }
    }
    for account in config
        .xai_accounts()
        .iter()
        .filter(|account| !account.disabled)
    {
        for model in &account.models {
            models
                .entry(model.clone())
                .or_default()
                .insert("xai".to_owned());
        }
    }
    models
        .into_iter()
        .take(256)
        .filter_map(|(model, providers)| {
            serde_json::json!({
                "id": model,
                "object": "model",
                "owned_by": "workjet",
                "display_name": model,
                "providers": providers,
            })
            .as_object()
            .cloned()
        })
        .collect()
}

#[derive(Clone)]
pub struct HostManagementSource {
    provider_endpoint: String,
    management_endpoint: String,
    default_provider: Option<String>,
    summary: ManagementRuntimeConfigSummary,
}

impl HostManagementSource {
    pub fn new(
        provider_endpoint: String,
        management_endpoint: String,
        default_provider: Option<String>,
        config: &ValidatedRuntimeConfig,
    ) -> Self {
        let providers = [
            (
                "claude",
                config.claude_accounts().len(),
                config
                    .claude_accounts()
                    .iter()
                    .filter(|account| !account.disabled)
                    .count(),
                config
                    .claude_accounts()
                    .iter()
                    .flat_map(|account| account.models.iter().cloned())
                    .collect::<BTreeSet<_>>(),
            ),
            (
                "codex",
                config.codex_accounts().len(),
                config
                    .codex_accounts()
                    .iter()
                    .filter(|account| !account.disabled)
                    .count(),
                config
                    .codex_accounts()
                    .iter()
                    .flat_map(|account| account.models.iter().cloned())
                    .collect::<BTreeSet<_>>(),
            ),
            (
                "antigravity",
                config.antigravity_accounts().len(),
                config
                    .antigravity_accounts()
                    .iter()
                    .filter(|account| !account.disabled)
                    .count(),
                config
                    .antigravity_accounts()
                    .iter()
                    .flat_map(|account| account.models.iter().cloned())
                    .collect::<BTreeSet<_>>(),
            ),
        ]
        .into_iter()
        .map(|(provider, account_count, enabled, models)| {
            (provider.to_owned(), account_count, enabled, models)
        })
        // One summary entry per API-key provider that has accounts, so the
        // management surface lists zai/minimax/xai/kimi exactly like the OAuth
        // providers.
        .chain(config.api_key_providers().into_iter().map(|provider| {
            let accounts = config.api_key_accounts_for(provider);
            (
                provider.to_owned(),
                accounts.len(),
                accounts.iter().filter(|account| !account.disabled).count(),
                accounts
                    .iter()
                    .flat_map(|account| account.models.iter().cloned())
                    .collect::<BTreeSet<_>>(),
            )
        }))
        .filter(|(_, count, _, _)| *count > 0)
        .map(|(provider, account_count, enabled_account_count, models)| {
            ManagementProviderConfigSummary {
                provider,
                account_count,
                enabled_account_count,
                models: models.into_iter().take(256).collect(),
            }
        })
        .collect();
        // xAI subscription accounts share the "xai" row with any xai API
        // keys — one provider, one row, counts merged.
        let mut providers: Vec<ManagementProviderConfigSummary> = providers;
        if !config.xai_accounts().is_empty() {
            let subscriptions = config.xai_accounts();
            let enabled = subscriptions
                .iter()
                .filter(|account| !account.disabled)
                .count();
            let models: BTreeSet<String> = subscriptions
                .iter()
                .flat_map(|account| account.models.iter().cloned())
                .collect();
            if let Some(row) = providers.iter_mut().find(|row| row.provider == "xai") {
                row.account_count += subscriptions.len();
                row.enabled_account_count += enabled;
                let merged: BTreeSet<String> = row.models.iter().cloned().chain(models).collect();
                row.models = merged.into_iter().take(256).collect();
            } else {
                providers.push(ManagementProviderConfigSummary {
                    provider: "xai".to_owned(),
                    account_count: subscriptions.len(),
                    enabled_account_count: enabled,
                    models: models.into_iter().take(256).collect(),
                });
            }
        }
        Self {
            provider_endpoint,
            management_endpoint,
            summary: ManagementRuntimeConfigSummary {
                schema: "workjet.provider-gateway.runtime-summary.v1".to_owned(),
                revision: 1,
                default_provider: default_provider.clone(),
                providers,
            },
            default_provider,
        }
    }
}

impl HostManagementSource {
    /// A host without any provider account is up but has nothing to route to.
    fn provider_phase(&self) -> ManagementRuntimePhase {
        if self.default_provider.is_some() {
            ManagementRuntimePhase::Ready
        } else {
            ManagementRuntimePhase::WaitingForSubscription
        }
    }
}

impl ManagementRuntimeStatusSource for HostManagementSource {
    fn snapshot(&self) -> ManagementRuntimeStatus {
        ManagementRuntimeStatus {
            schema: "workjet.provider-gateway.runtime-status.v1".to_owned(),
            main_responses_gateway: ManagementRuntimeEndpoint {
                phase: self.provider_phase(),
                listen_addr: self.provider_endpoint.clone(),
            },
            codex_subscription_gateway: ManagementRuntimeEndpoint {
                phase: self.provider_phase(),
                listen_addr: self.provider_endpoint.clone(),
            },
            management_gateway: ManagementRuntimeEndpoint {
                phase: ManagementRuntimePhase::Ready,
                listen_addr: self.management_endpoint.clone(),
            },
            active_provider: self.default_provider.clone(),
            active_model: None,
        }
    }
}

impl ManagementRuntimeConfigSource for HostManagementSource {
    fn snapshot(
        &self,
    ) -> Result<Option<ManagementRuntimeConfigSummary>, ManagementRuntimeConfigError> {
        Ok(Some(self.summary.clone()))
    }

    fn replace(
        &self,
        _mutation: ManagementRuntimeConfigMutation,
    ) -> Result<ManagementRuntimeConfigSummary, ManagementRuntimeConfigError> {
        Err(ManagementRuntimeConfigError::Invalid)
    }
}

impl From<SecretResolveError> for RuntimeBuildError {
    fn from(_: SecretResolveError) -> Self {
        Self::Secret
    }
}
