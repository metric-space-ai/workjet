use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use workjet_provider_gateway::internal::config::{
    CliproxyRuntimeConfig, RuntimeSecretRef, ValidatedRuntimeConfig, API_KEY_PROVIDERS,
};

pub const HOST_CONFIG_SCHEMA: &str = "workjet.provider-gateway-host.v1";
pub const ALLOWED_SECRET_SCOPE: &str = "workjet-provider-gateway";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostConfig {
    pub schema: String,
    pub provider_address: SocketAddr,
    pub management_address: SocketAddr,
    pub secret_root: PathBuf,
    pub management_secret: RuntimeSecretRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub antigravity_oauth_client_id_secret: Option<RuntimeSecretRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub antigravity_oauth_client_secret_secret: Option<RuntimeSecretRef>,
    /// Absent (or null) while no provider account is configured yet. A named
    /// provider must still have an enabled account, exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    /// Loopback port the codex OAuth redirect is served on. Absent means the
    /// port OpenAI's official client registers (1455); any other value is only
    /// usable if that client registers it too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_callback_port: Option<u16>,
    pub runtime: CliproxyRuntimeConfig,
}

impl fmt::Debug for HostConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostConfig")
            .field("schema", &self.schema)
            .field("provider_address", &self.provider_address)
            .field("management_address", &self.management_address)
            .field("secret_root", &self.secret_root)
            .field("management_secret", &self.management_secret)
            .field(
                "has_antigravity_oauth_refs",
                &(self.antigravity_oauth_client_id_secret.is_some()
                    && self.antigravity_oauth_client_secret_secret.is_some()),
            )
            .field("default_provider", &self.default_provider)
            .field("runtime", &"CliproxyRuntimeConfig([REDACTED REFERENCES])")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostConfigError {
    InvalidSchema,
    NonLoopbackAddress,
    InvalidDefaultProvider,
    InvalidRuntime,
    InvalidSecretReference,
}

pub struct ValidatedHostConfig {
    pub provider_address: SocketAddr,
    pub management_address: SocketAddr,
    pub secret_root: PathBuf,
    pub management_secret: RuntimeSecretRef,
    pub antigravity_oauth: Option<(RuntimeSecretRef, RuntimeSecretRef)>,
    pub default_provider: Option<String>,
    pub codex_callback_port: u16,
    pub runtime: ValidatedRuntimeConfig,
}

impl HostConfig {
    pub fn validate(self) -> Result<ValidatedHostConfig, HostConfigError> {
        if self.schema != HOST_CONFIG_SCHEMA {
            return Err(HostConfigError::InvalidSchema);
        }
        if !self.provider_address.ip().is_loopback() || !self.management_address.ip().is_loopback()
        {
            return Err(HostConfigError::NonLoopbackAddress);
        }
        let default_provider = self
            .default_provider
            .as_deref()
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(str::to_owned);
        if default_provider.as_deref().is_some_and(|provider| {
            !matches!(provider, "claude" | "codex" | "antigravity")
                && !API_KEY_PROVIDERS.contains(&provider)
        }) {
            return Err(HostConfigError::InvalidDefaultProvider);
        }
        let reference_allowed = |reference: &RuntimeSecretRef| {
            reference.scope == ALLOWED_SECRET_SCOPE
                && !reference.name.is_empty()
                && reference.name.len() <= 160
                && reference.name != "."
                && reference.name != ".."
                && !reference.name.contains("..")
                && reference.name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
        };
        if !reference_allowed(&self.management_secret) {
            return Err(HostConfigError::InvalidSecretReference);
        }
        // A bootstrap host carries no account at all. The portable runtime
        // already models this as an outer-host runtime whose routes live
        // outside the portable account lists; every other configuration keeps
        // the strict portable validation, so an all-disabled account set still
        // fails exactly as before.
        let bootstrap = self.runtime.claude_accounts.is_empty()
            && self.runtime.codex_accounts.is_empty()
            && self.runtime.antigravity_accounts.is_empty()
            && self.runtime.api_key_accounts.is_empty();
        if bootstrap && default_provider.is_some() {
            return Err(HostConfigError::InvalidDefaultProvider);
        }
        let runtime = if bootstrap {
            self.runtime.validate_for_extension_host()
        } else {
            self.runtime.validate()
        }
        .map_err(|_| HostConfigError::InvalidRuntime)?;
        let runtime_refs_allowed = runtime.claude_accounts().iter().all(|account| {
            reference_allowed(&account.access_token_secret)
                && reference_allowed(&account.refresh_token_secret)
                && account
                    .proxy_url_secret
                    .as_ref()
                    .is_none_or(reference_allowed)
        }) && runtime.codex_accounts().iter().all(|account| {
            reference_allowed(&account.id_token_secret)
                && reference_allowed(&account.access_token_secret)
                && reference_allowed(&account.refresh_token_secret)
                && account
                    .proxy_url_secret
                    .as_ref()
                    .is_none_or(reference_allowed)
        }) && runtime.antigravity_accounts().iter().all(|account| {
            reference_allowed(&account.access_token_secret)
                && reference_allowed(&account.refresh_token_secret)
                && reference_allowed(&account.state_secret)
                && account
                    .proxy_url_secret
                    .as_ref()
                    .is_none_or(reference_allowed)
        }) && runtime.api_key_accounts().iter().all(|account| {
            reference_allowed(&account.api_key_secret)
                && account
                    .proxy_url_secret
                    .as_ref()
                    .is_none_or(reference_allowed)
        });
        if !runtime_refs_allowed {
            return Err(HostConfigError::InvalidSecretReference);
        }
        let antigravity_oauth = match (
            self.antigravity_oauth_client_id_secret,
            self.antigravity_oauth_client_secret_secret,
        ) {
            (Some(client_id), Some(client_secret))
                if reference_allowed(&client_id) && reference_allowed(&client_secret) =>
            {
                Some((client_id, client_secret))
            }
            (None, None) if runtime.antigravity_accounts().is_empty() => None,
            _ => return Err(HostConfigError::InvalidSecretReference),
        };
        // A host that carries no account at all is a legitimate bootstrap
        // state: the management surface must come up so the very first OAuth
        // login can happen. Any configured account still demands a named,
        // enabled default provider, so established deployments are unchanged.
        let configured_accounts = runtime.claude_accounts().len()
            + runtime.codex_accounts().len()
            + runtime.antigravity_accounts().len()
            + runtime.api_key_accounts().len();
        let default_is_enabled = match default_provider.as_deref() {
            Some("claude") => runtime
                .claude_accounts()
                .iter()
                .any(|account| !account.disabled),
            Some("codex") => runtime
                .codex_accounts()
                .iter()
                .any(|account| !account.disabled),
            Some("antigravity") => runtime
                .antigravity_accounts()
                .iter()
                .any(|account| !account.disabled),
            Some(provider) if API_KEY_PROVIDERS.contains(&provider) => runtime
                .api_key_accounts()
                .iter()
                .any(|account| !account.disabled && account.provider.trim() == provider),
            Some(_) => false,
            None => configured_accounts == 0,
        };
        if !default_is_enabled {
            return Err(HostConfigError::InvalidDefaultProvider);
        }
        Ok(ValidatedHostConfig {
            provider_address: self.provider_address,
            management_address: self.management_address,
            secret_root: self.secret_root,
            management_secret: self.management_secret,
            antigravity_oauth,
            default_provider,
            codex_callback_port: self
                .codex_callback_port
                .unwrap_or(crate::oauth::CODEX_CALLBACK_PORT),
            runtime,
        })
    }
}
