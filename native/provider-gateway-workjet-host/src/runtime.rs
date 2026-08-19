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
    claude_models_response, ClaudeMessagesAntigravityHandler, ClaudeMessagesHttpResponse,
};
use zeroize::Zeroizing;

use workjet_provider_gateway::internal::runtime::executor::ApiKeyHttpClient;
use workjet_provider_gateway::sdk::api::handlers::openai::openai_responses_api_key_handlers::{
    ApiKeyAccount, ApiKeyAccountPool, OpenAiResponsesApiKeyHandler,
};
use workjet_provider_gateway::sdk::api::handlers::openai::openai_responses_handlers::{
    OpenAiResponsesAntigravityHandler, OpenAiResponsesClaudeHandler, OpenAiResponsesCodexHandler,
    OpenAiResponsesProviderRouter,
};
use workjet_provider_gateway::sdk::pluginapi::HostHttpClient;
use workjet_provider_gateway::sdk::translator::builtin::registry as builtin_registry;
use workjet_provider_gateway::sdk::cliproxy::auth::{
    AccountRouter, CooldownConductor, CooldownStateRecord, CooldownStateStore, CooldownStoreError,
};

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
    pub messages: Option<Arc<ClaudeMessagesAntigravityHandler>>,
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

    let mut messages = None;
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
        )));
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

    let responses = Arc::new(
        OpenAiResponsesProviderRouter::with_api_key_handlers(
            default_provider,
            claude,
            codex,
            antigravity,
            api_key_handlers,
        )
        .map_err(|_| RuntimeBuildError::Configuration)?,
    );
    let auxiliary = (!auxiliary_handlers.is_empty()).then(|| {
        Arc::new(AuxiliaryRouteChain::new(auxiliary_handlers)) as Arc<dyn AuxiliaryRouteHandler>
    });
    Ok(Some(ProviderRoutes {
        responses,
        messages,
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
                accounts
                    .iter()
                    .filter(|account| !account.disabled)
                    .count(),
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
