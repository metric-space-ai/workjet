//! Loopback provider OAuth surface for the Workjet host.
//!
//! The host owns no OAuth policy of its own: sessions, credential projection,
//! provider normalization and the canonical callback path all come from the
//! portable gateway crate. This module only supplies the two pieces the
//! portable crate deliberately leaves to an embedder - a concrete
//! [`ManagementProviderOAuthAuthority`] that talks to the real providers, and
//! the redirect target that the host's own management listener serves.
//!
//! No token material is written to disk here. Exchanged tokens live only in
//! this process' memory for the lifetime of the OAuth session; the loopback
//! client receives the crate's secret-free [`ManagementCredentialRecord`]
//! projection and owns persistence itself.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use workjet_provider_gateway::internal::api::handlers::management::{
    normalize_oauth_provider, validate_oauth_state, ManagementCredentialError,
    ManagementCredentialRecord, ManagementCredentialService, ManagementCredentialStore,
    ManagementCredentialStoreError, ManagementOAuthClock, ManagementOAuthSessionError,
    ManagementOAuthSessions, ManagementProviderOAuth, ManagementProviderOAuthAuthority,
    ManagementProviderOAuthAuthorityError, ManagementProviderOAuthError,
    ManagementProviderOAuthPoll, ManagementProviderOAuthStart,
};
use workjet_provider_gateway::internal::api::server_management::{
    ManagementOAuthRouteError, ManagementOAuthSource,
};
use workjet_provider_gateway::internal::auth::antigravity::{
    AntigravityAuth, AntigravityHttpTransport, AntigravityOAuthClientCredentials,
    SecretString as AntigravitySecret,
};
use workjet_provider_gateway::internal::auth::claude::{
    generate_pkce_codes as claude_pkce, AnthropicHttpTransport, ClaudeAuth,
    PkceCodes as ClaudePkceCodes, SecretString as ClaudeSecret,
};
use workjet_provider_gateway::internal::auth::codex::{
    generate_auth_url_with_redirect as codex_auth_url, generate_pkce_codes as codex_pkce,
    CodexAuth, CodexHttpTransport, PkceCodes as CodexPkceCodes, SecretString as CodexSecret,
};
use workjet_provider_gateway::sdk::auth::LoginCancellation;

/// System clock for the crate's OAuth session bookkeeping.
#[derive(Debug, Default)]
pub struct SystemOAuthClock;

impl ManagementOAuthClock for SystemOAuthClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
            .unwrap_or(i64::MAX)
    }
}

/// In-memory projection store. Credentials produced by a completed OAuth
/// session are never persisted host-side; the Node server owns persistence.
#[derive(Debug, Default)]
struct MemoryCredentialStore(Mutex<Vec<ManagementCredentialRecord>>);

impl ManagementCredentialStore for MemoryCredentialStore {
    fn load(&self) -> Result<Vec<ManagementCredentialRecord>, ManagementCredentialStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| ManagementCredentialStoreError)?
            .clone())
    }

    fn replace_all(
        &self,
        records: &[ManagementCredentialRecord],
    ) -> Result<(), ManagementCredentialStoreError> {
        *self.0.lock().map_err(|_| ManagementCredentialStoreError)? = records.to_vec();
        Ok(())
    }
}

enum ProviderPkce {
    Claude(ClaudePkceCodes),
    Codex(CodexPkceCodes),
    Antigravity,
}

struct PendingLogin {
    provider: String,
    redirect_uri: String,
    pkce: Arc<ProviderPkce>,
}

enum LoginOutcome {
    Failed(String),
    Completed(Vec<ManagementCredentialRecord>),
}

/// Concrete OAuth authority for the three providers the Workjet host exposes.
pub struct HostOAuthAuthority {
    management_endpoint: String,
    antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
    pending: Mutex<BTreeMap<String, PendingLogin>>,
    outcomes: Mutex<BTreeMap<String, LoginOutcome>>,
}

impl std::fmt::Debug for HostOAuthAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostOAuthAuthority")
            .field("management_endpoint", &self.management_endpoint)
            .field("antigravity_configured", &self.antigravity.is_some())
            .finish_non_exhaustive()
    }
}

impl HostOAuthAuthority {
    #[must_use]
    pub fn new(
        management_endpoint: String,
        antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
    ) -> Self {
        Self {
            management_endpoint,
            antigravity,
            pending: Mutex::new(BTreeMap::new()),
            outcomes: Mutex::new(BTreeMap::new()),
        }
    }

    fn redirect_uri(&self, callback_path: &str) -> String {
        format!(
            "{}{callback_path}",
            self.management_endpoint.trim_end_matches('/')
        )
    }

    /// Accepts the loopback redirect result for `state` and, for a successful
    /// authorization, starts the provider token exchange off the connection
    /// task. `poll` observes the result.
    pub fn record_callback(
        self: &Arc<Self>,
        provider: &str,
        state: &str,
        code: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), ManagementProviderOAuthAuthorityError> {
        let pending = {
            let guard = self
                .pending
                .lock()
                .map_err(|_| ManagementProviderOAuthAuthorityError)?;
            let pending = guard
                .get(state)
                .ok_or(ManagementProviderOAuthAuthorityError)?;
            if pending.provider != provider {
                return Err(ManagementProviderOAuthAuthorityError);
            }
            PendingLogin {
                provider: pending.provider.clone(),
                redirect_uri: pending.redirect_uri.clone(),
                pkce: pending.pkce.clone(),
            }
        };
        if let Some(message) = error.map(str::trim).filter(|value| !value.is_empty()) {
            self.set_outcome(state, LoginOutcome::Failed(message.to_owned()))?;
            return Ok(());
        }
        let code = code
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(ManagementProviderOAuthAuthorityError)?
            .to_owned();
        let authority = self.clone();
        let state = state.to_owned();
        let antigravity = self.antigravity.clone();
        tokio::spawn(async move {
            let outcome = match exchange(&pending, &code, antigravity).await {
                Ok(records) => LoginOutcome::Completed(records),
                Err(message) => LoginOutcome::Failed(message),
            };
            let _ = authority.set_outcome(&state, outcome);
        });
        Ok(())
    }

    fn set_outcome(
        &self,
        state: &str,
        outcome: LoginOutcome,
    ) -> Result<(), ManagementProviderOAuthAuthorityError> {
        self.outcomes
            .lock()
            .map_err(|_| ManagementProviderOAuthAuthorityError)?
            .insert(state.to_owned(), outcome);
        Ok(())
    }
}

impl ManagementProviderOAuthAuthority for HostOAuthAuthority {
    fn begin(
        &self,
        provider: &str,
        state: &str,
        callback_path: &str,
    ) -> Result<String, ManagementProviderOAuthAuthorityError> {
        let redirect_uri = self.redirect_uri(callback_path);
        let (authorization_url, pkce) = match provider {
            "anthropic" => {
                let pkce = claude_pkce().map_err(|_| ManagementProviderOAuthAuthorityError)?;
                let secret_state =
                    ClaudeSecret::new(state).map_err(|_| ManagementProviderOAuthAuthorityError)?;
                let transport = AnthropicHttpTransport::new(None)
                    .map_err(|_| ManagementProviderOAuthAuthorityError)?;
                let (url, _) = ClaudeAuth::new(transport)
                    .generate_auth_url_with_redirect(&secret_state, &pkce, &redirect_uri)
                    .map_err(|_| ManagementProviderOAuthAuthorityError)?;
                (url, ProviderPkce::Claude(pkce))
            }
            "codex" => {
                let pkce = codex_pkce().map_err(|_| ManagementProviderOAuthAuthorityError)?;
                let url = codex_auth_url(state, &pkce, &redirect_uri);
                (url, ProviderPkce::Codex(pkce))
            }
            "antigravity" => {
                let credentials = self
                    .antigravity
                    .clone()
                    .ok_or(ManagementProviderOAuthAuthorityError)?;
                let transport = Arc::new(
                    AntigravityHttpTransport::new(None)
                        .map_err(|_| ManagementProviderOAuthAuthorityError)?,
                );
                let url = AntigravityAuth::new(credentials, transport)
                    .build_auth_url(state, Some(&redirect_uri));
                (url, ProviderPkce::Antigravity)
            }
            _ => return Err(ManagementProviderOAuthAuthorityError),
        };
        self.pending
            .lock()
            .map_err(|_| ManagementProviderOAuthAuthorityError)?
            .insert(
                state.to_owned(),
                PendingLogin {
                    provider: provider.to_owned(),
                    redirect_uri,
                    pkce: Arc::new(pkce),
                },
            );
        Ok(authorization_url)
    }

    fn poll(
        &self,
        provider: &str,
        state: &str,
    ) -> Result<ManagementProviderOAuthPoll, ManagementProviderOAuthAuthorityError> {
        {
            let pending = self
                .pending
                .lock()
                .map_err(|_| ManagementProviderOAuthAuthorityError)?;
            let record = pending
                .get(state)
                .ok_or(ManagementProviderOAuthAuthorityError)?;
            if record.provider != provider {
                return Err(ManagementProviderOAuthAuthorityError);
            }
        }
        let mut outcomes = self
            .outcomes
            .lock()
            .map_err(|_| ManagementProviderOAuthAuthorityError)?;
        match outcomes.remove(state) {
            None => Ok(ManagementProviderOAuthPoll {
                pending: true,
                error: None,
                credentials: Vec::new(),
            }),
            Some(LoginOutcome::Failed(message)) => Ok(ManagementProviderOAuthPoll {
                pending: false,
                error: Some(message),
                credentials: Vec::new(),
            }),
            Some(LoginOutcome::Completed(credentials)) => Ok(ManagementProviderOAuthPoll {
                pending: false,
                error: None,
                credentials,
            }),
        }
    }

    fn cancel(
        &self,
        provider: &str,
        state: &str,
    ) -> Result<(), ManagementProviderOAuthAuthorityError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| ManagementProviderOAuthAuthorityError)?;
        match pending.get(state) {
            Some(record) if record.provider == provider => {
                pending.remove(state);
            }
            Some(_) => return Err(ManagementProviderOAuthAuthorityError),
            None => {}
        }
        drop(pending);
        self.outcomes
            .lock()
            .map_err(|_| ManagementProviderOAuthAuthorityError)?
            .remove(state);
        Ok(())
    }
}

async fn exchange(
    pending: &PendingLogin,
    code: &str,
    antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
) -> Result<Vec<ManagementCredentialRecord>, String> {
    match (pending.provider.as_str(), pending.pkce.as_ref()) {
        ("anthropic", ProviderPkce::Claude(pkce)) => {
            let transport = AnthropicHttpTransport::new(None)
                .map_err(|_| "transport unavailable".to_owned())?;
            let auth = ClaudeAuth::new(transport);
            let code = ClaudeSecret::new(code).map_err(|_| "invalid code".to_owned())?;
            let state = ClaudeSecret::new("callback").map_err(|_| "invalid state".to_owned())?;
            let bundle = auth
                .exchange_code_for_tokens_with_redirect(&code, &state, pkce, &pending.redirect_uri)
                .await
                .map_err(|_| "Authentication exchange failed".to_owned())?;
            let storage = auth.create_token_storage(&bundle);
            let identity = first_nonempty(&[storage.account_uuid(), storage.email()])
                .ok_or_else(|| "provider identity unavailable".to_owned())?;
            Ok(vec![record("anthropic", &identity, storage.email())])
        }
        ("codex", ProviderPkce::Codex(pkce)) => {
            let transport =
                CodexHttpTransport::new(None).map_err(|_| "transport unavailable".to_owned())?;
            let auth = CodexAuth::new(transport);
            let code = CodexSecret::new(code).map_err(|_| "invalid code".to_owned())?;
            let bundle = auth
                .exchange_code_for_tokens_with_redirect(&code, &pending.redirect_uri, pkce)
                .await
                .map_err(|_| "Authentication exchange failed".to_owned())?;
            let storage = auth.create_token_storage(&bundle);
            let identity = first_nonempty(&[storage.account_id(), storage.email()])
                .ok_or_else(|| "provider identity unavailable".to_owned())?;
            Ok(vec![record("codex", &identity, storage.email())])
        }
        ("antigravity", ProviderPkce::Antigravity) => {
            let credentials =
                antigravity.ok_or_else(|| "antigravity client is unconfigured".to_owned())?;
            let transport = Arc::new(
                AntigravityHttpTransport::new(None)
                    .map_err(|_| "transport unavailable".to_owned())?,
            );
            let auth = AntigravityAuth::new(credentials, transport);
            let cancellation = LoginCancellation::default();
            let tokens = auth
                .exchange_code_for_tokens(&cancellation, code, &pending.redirect_uri)
                .await
                .map_err(|_| "Authentication exchange failed".to_owned())?;
            let email = fetch_antigravity_email(&auth, &cancellation, tokens.access_token()).await;
            let identity = first_nonempty(&[email.as_str()])
                .ok_or_else(|| "provider identity unavailable".to_owned())?;
            Ok(vec![record("antigravity", &identity, &email)])
        }
        _ => Err("provider session is inconsistent".to_owned()),
    }
}

async fn fetch_antigravity_email(
    auth: &AntigravityAuth,
    cancellation: &LoginCancellation,
    access_token: &AntigravitySecret,
) -> String {
    auth.fetch_user_info(cancellation, access_token)
        .await
        .unwrap_or_default()
}

fn first_nonempty(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(str::to_owned)
}

fn record(provider: &str, identity: &str, email: &str) -> ManagementCredentialRecord {
    let label = if email.trim().is_empty() {
        format!("{provider}:{identity}")
    } else {
        email.trim().to_owned()
    };
    ManagementCredentialRecord {
        id: format!("{provider}:{identity}"),
        auth_index: String::new(),
        label,
        provider: provider.to_owned(),
        disabled: false,
        models: Vec::new(),
    }
}

/// Management OAuth surface wired into the host's loopback listener.
pub struct HostOAuthSource {
    sessions: Arc<ManagementOAuthSessions>,
    provider_oauth: Arc<ManagementProviderOAuth>,
    authority: Arc<HostOAuthAuthority>,
}

impl std::fmt::Debug for HostOAuthSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostOAuthSource")
            .finish_non_exhaustive()
    }
}

impl HostOAuthSource {
    #[must_use]
    pub fn new(
        management_endpoint: String,
        antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
    ) -> Self {
        let sessions = Arc::new(ManagementOAuthSessions::new(Arc::new(SystemOAuthClock)));
        let credentials = Arc::new(ManagementCredentialService::new(Arc::new(
            MemoryCredentialStore::default(),
        )));
        let authority = Arc::new(HostOAuthAuthority::new(management_endpoint, antigravity));
        let provider_oauth = Arc::new(ManagementProviderOAuth::new(
            sessions.clone(),
            credentials,
            authority.clone(),
        ));
        Self {
            sessions,
            provider_oauth,
            authority,
        }
    }

    fn provider_for_state(&self, state: &str) -> Result<String, ManagementOAuthRouteError> {
        validate_oauth_state(state).map_err(|_| ManagementOAuthRouteError::InvalidState)?;
        self.sessions
            .details(state)
            .map_err(session_error)?
            .filter(|session| !session.completed)
            .map(|session| session.provider)
            .ok_or(ManagementOAuthRouteError::UnknownSession)
    }
}

impl ManagementOAuthSource for HostOAuthSource {
    fn begin(
        &self,
        provider: &str,
        state: Option<&str>,
    ) -> Result<ManagementProviderOAuthStart, ManagementOAuthRouteError> {
        let state = match state.map(str::trim).filter(|value| !value.is_empty()) {
            Some(state) => {
                validate_oauth_state(state).map_err(|_| ManagementOAuthRouteError::InvalidState)?;
                state.to_owned()
            }
            None => uuid::Uuid::new_v4().simple().to_string(),
        };
        self.provider_oauth
            .begin_builtin(provider, &state)
            .map_err(provider_error)
    }

    fn poll(&self, state: &str) -> Result<ManagementProviderOAuthPoll, ManagementOAuthRouteError> {
        let provider = self.provider_for_state(state)?;
        self.provider_oauth
            .poll(&provider, state)
            .map_err(provider_error)
    }

    fn cancel(&self, state: &str) -> Result<bool, ManagementOAuthRouteError> {
        let provider = self.provider_for_state(state)?;
        self.provider_oauth
            .cancel(&provider, state)
            .map_err(provider_error)
    }

    fn callback(
        &self,
        provider: &str,
        state: &str,
        code: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), ManagementOAuthRouteError> {
        let provider = normalize_oauth_provider(provider)
            .map_err(|_| ManagementOAuthRouteError::UnsupportedProvider)?;
        validate_oauth_state(state).map_err(|_| ManagementOAuthRouteError::InvalidState)?;
        self.sessions
            .guard_pending_for_save(state, &provider)
            .map_err(|_| ManagementOAuthRouteError::UnknownSession)?;
        self.authority
            .record_callback(&provider, state, code, error)
            .map_err(|_| ManagementOAuthRouteError::Unavailable)
    }
}

fn session_error(error: ManagementOAuthSessionError) -> ManagementOAuthRouteError {
    match error {
        ManagementOAuthSessionError::InvalidState => ManagementOAuthRouteError::InvalidState,
        ManagementOAuthSessionError::UnsupportedProvider => {
            ManagementOAuthRouteError::UnsupportedProvider
        }
        ManagementOAuthSessionError::SessionExists => ManagementOAuthRouteError::SessionExists,
        ManagementOAuthSessionError::SessionNotPending => ManagementOAuthRouteError::UnknownSession,
        ManagementOAuthSessionError::StateUnavailable => ManagementOAuthRouteError::Unavailable,
    }
}

fn provider_error(error: ManagementProviderOAuthError) -> ManagementOAuthRouteError {
    match error {
        ManagementProviderOAuthError::Session(error) => session_error(error),
        ManagementProviderOAuthError::Credential(ManagementCredentialError::InvalidRecord) => {
            ManagementOAuthRouteError::Unavailable
        }
        ManagementProviderOAuthError::Credential(_)
        | ManagementProviderOAuthError::AuthorityUnavailable
        | ManagementProviderOAuthError::InvalidResponse
        | ManagementProviderOAuthError::StateUnavailable
        | ManagementProviderOAuthError::VirtualChildConflict => {
            ManagementOAuthRouteError::Unavailable
        }
    }
}
