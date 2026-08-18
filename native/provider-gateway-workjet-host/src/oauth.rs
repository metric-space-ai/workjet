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
//! this process' memory until the loopback client claims them exactly once;
//! `status` returns only the crate's secret-free
//! [`ManagementCredentialRecord`] projection, and the separate claim hands the
//! provider payload over in the canonical serialization this host reads back
//! at startup. The claiming control plane owns persistence.

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
    ManagementClaimedCredential, ManagementOAuthRouteError, ManagementOAuthSource,
};
use workjet_provider_gateway::internal::auth::antigravity::{
    AntigravityAuth, AntigravityHttpTransport, AntigravityOAuthClientCredentials,
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

use crate::secret_store::antigravity_state_secret;

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
    Completed(Vec<ManagementClaimedCredential>),
}

/// Concrete OAuth authority for the three providers the Workjet host exposes.
pub struct HostOAuthAuthority {
    management_endpoint: String,
    antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
    pending: Mutex<BTreeMap<String, PendingLogin>>,
    outcomes: Mutex<BTreeMap<String, LoginOutcome>>,
    claims: Mutex<BTreeMap<String, Vec<ManagementClaimedCredential>>>,
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
            claims: Mutex::new(BTreeMap::new()),
        }
    }

    /// Hands the completed session's provider payload over exactly once.
    fn take_claim(
        &self,
        state: &str,
    ) -> Result<Vec<ManagementClaimedCredential>, ManagementOAuthRouteError> {
        self.claims
            .lock()
            .map_err(|_| ManagementOAuthRouteError::Unavailable)?
            .remove(state)
            .ok_or(ManagementOAuthRouteError::NotClaimable)
    }

    /// Drops any retained token material for `state` without handing it out.
    fn discard_claim(&self, state: &str) {
        if let Ok(mut claims) = self.claims.lock() {
            claims.remove(state);
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
            Some(LoginOutcome::Completed(claimed)) => {
                let credentials = claimed
                    .iter()
                    .map(|entry| entry.account.clone())
                    .collect::<Vec<_>>();
                // The secret payload stays behind for a single later claim;
                // only the secret-free projection travels with the poll.
                self.claims
                    .lock()
                    .map_err(|_| ManagementProviderOAuthAuthorityError)?
                    .insert(state.to_owned(), claimed);
                Ok(ManagementProviderOAuthPoll {
                    pending: false,
                    error: None,
                    credentials,
                })
            }
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
        self.discard_claim(state);
        Ok(())
    }
}

async fn exchange(
    pending: &PendingLogin,
    code: &str,
    antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
) -> Result<Vec<ManagementClaimedCredential>, String> {
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
            let credentials = storage.credentials();
            Ok(vec![ManagementClaimedCredential {
                account: record("anthropic", &identity, storage.email()),
                secrets: BTreeMap::from([
                    (
                        "access_token_secret".to_owned(),
                        credentials.access_token().expose_secret().to_owned(),
                    ),
                    (
                        "refresh_token_secret".to_owned(),
                        credentials.refresh_token().expose_secret().to_owned(),
                    ),
                ]),
            }])
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
            let credentials = storage.credentials();
            Ok(vec![ManagementClaimedCredential {
                account: record("codex", &identity, storage.email()),
                secrets: BTreeMap::from([
                    (
                        "id_token_secret".to_owned(),
                        credentials.id_token().expose_secret().to_owned(),
                    ),
                    (
                        "access_token_secret".to_owned(),
                        credentials.access_token().expose_secret().to_owned(),
                    ),
                    (
                        "refresh_token_secret".to_owned(),
                        credentials.refresh_token().expose_secret().to_owned(),
                    ),
                ]),
            }])
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
            let refresh_token = tokens
                .refresh_token()
                .ok_or_else(|| "provider returned no refresh token".to_owned())?;
            let email = auth
                .fetch_user_info(&cancellation, tokens.access_token())
                .await
                .unwrap_or_default();
            let project_id = auth
                .fetch_project_id(&cancellation, tokens.access_token())
                .await
                .map_err(|_| "provider project is unavailable".to_owned())?;
            let identity = first_nonempty(&[email.as_str(), project_id.as_str()])
                .ok_or_else(|| "provider identity unavailable".to_owned())?;
            let state_secret =
                antigravity_state_secret(expires_at_unix_ms(tokens.expires_in), &project_id)
                    .map_err(|_| "provider state is invalid".to_owned())?;
            Ok(vec![ManagementClaimedCredential {
                account: record("antigravity", &identity, &email),
                secrets: BTreeMap::from([
                    (
                        "access_token_secret".to_owned(),
                        tokens.access_token().expose_secret().to_owned(),
                    ),
                    (
                        "refresh_token_secret".to_owned(),
                        refresh_token.expose_secret().to_owned(),
                    ),
                    ("state_secret".to_owned(), state_secret),
                ]),
            }])
        }
        _ => Err("provider session is inconsistent".to_owned()),
    }
}

/// Absolute expiry the antigravity state payload records, derived from the
/// provider's relative `expires_in`.
fn expires_at_unix_ms(expires_in: i64) -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default();
    let lifetime_ms = u64::try_from(expires_in.max(0)).unwrap_or_default() * 1_000;
    now_ms.saturating_add(lifetime_ms)
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

    fn claim(
        &self,
        state: &str,
    ) -> Result<Vec<ManagementClaimedCredential>, ManagementOAuthRouteError> {
        validate_oauth_state(state).map_err(|_| ManagementOAuthRouteError::InvalidState)?;
        // Retained token material lives exactly as long as its session does.
        let Some(session) = self.sessions.details(state).map_err(session_error)? else {
            self.authority.discard_claim(state);
            return Err(ManagementOAuthRouteError::UnknownSession);
        };
        if !session.completed {
            return Err(ManagementOAuthRouteError::NotClaimable);
        }
        self.authority.take_claim(state)
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

#[cfg(test)]
mod tests {
    use super::*;

    const ACCESS: &str = "codex-access-token-must-not-leak";

    fn completed_codex_credential() -> ManagementClaimedCredential {
        ManagementClaimedCredential {
            account: record("codex", "account-1", "user@example.test"),
            secrets: BTreeMap::from([
                ("id_token_secret".to_owned(), "codex-id-token".to_owned()),
                ("access_token_secret".to_owned(), ACCESS.to_owned()),
                (
                    "refresh_token_secret".to_owned(),
                    "codex-refresh-token".to_owned(),
                ),
            ]),
        }
    }

    fn source() -> HostOAuthSource {
        HostOAuthSource::new("http://127.0.0.1:1/".to_owned(), None)
    }

    #[test]
    fn claims_the_canonical_provider_payload_exactly_once() {
        let source = source();
        let start = source.begin("codex", Some("claim-state")).unwrap();
        assert_eq!(start.provider, "codex");

        // A session that has not completed yet holds nothing to claim.
        assert_eq!(
            source.claim("claim-state").unwrap_err(),
            ManagementOAuthRouteError::NotClaimable
        );

        source
            .authority
            .set_outcome(
                "claim-state",
                LoginOutcome::Completed(vec![completed_codex_credential()]),
            )
            .unwrap();

        // The poll response carries the identity projection only.
        let polled = source.poll("claim-state").unwrap();
        assert!(!polled.pending);
        assert_eq!(polled.credentials.len(), 1);
        assert_eq!(polled.credentials[0].provider, "codex");
        let rendered = serde_json::to_string(&polled.credentials).unwrap();
        assert!(!rendered.contains(ACCESS), "{rendered}");

        let claimed = source.claim("claim-state").unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].account.provider, "codex");
        assert_eq!(claimed[0].secrets["access_token_secret"], ACCESS);
        assert_eq!(claimed[0].secrets["id_token_secret"], "codex-id-token");
        assert_eq!(
            claimed[0].secrets["refresh_token_secret"],
            "codex-refresh-token"
        );
        // Debug never renders token material.
        assert!(!format!("{:?}", claimed[0]).contains(ACCESS));

        // One time only.
        assert_eq!(
            source.claim("claim-state").unwrap_err(),
            ManagementOAuthRouteError::NotClaimable
        );
    }

    #[test]
    fn cancelling_a_session_drops_any_retained_token_material() {
        let source = source();
        source.begin("codex", Some("cancel-state")).unwrap();
        source
            .authority
            .set_outcome(
                "cancel-state",
                LoginOutcome::Completed(vec![completed_codex_credential()]),
            )
            .unwrap();
        assert!(source.cancel("cancel-state").unwrap());
        assert_eq!(
            source.claim("cancel-state").unwrap_err(),
            ManagementOAuthRouteError::UnknownSession
        );
    }
}
