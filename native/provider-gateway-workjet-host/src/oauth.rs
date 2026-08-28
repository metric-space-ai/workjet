//! Loopback provider OAuth surface for the Workjet host.
//!
//! The host owns no OAuth policy of its own: sessions, credential projection
//! and provider normalization all come from the portable gateway crate. This
//! module only supplies the two pieces the portable crate deliberately leaves
//! to an embedder - a concrete [`ManagementProviderOAuthAuthority`] that talks
//! to the real providers, and the loopback redirect target each provider's
//! OAuth client actually accepts.
//!
//! # Redirect targets the identity providers accept (evidence, 2026-08-19)
//!
//! The host used to point every provider at its own management listener
//! (`http://127.0.0.1:<ephemeral>/management/oauth/<provider>/callback`). No
//! provider registers that target, so both real logins were rejected by the
//! identity provider before any credential was ever entered:
//!
//! * Anthropic rendered `Redirect URI
//!   http://127.0.0.1:49406/management/oauth/anthropic/callback is not
//!   supported by client.`
//! * OpenAI answered `{"error":{"message":"Invalid authorize request", …
//!   "code":"invalid_authorize_request"}}`.
//!
//! The official CLIs on this machine define the accepted shapes:
//!
//! ## codex (`@openai/codex`, native binary)
//!
//! `codex login` printed, verbatim (scratch `CODEX_HOME`, no login performed):
//!
//! ```text
//! Starting local login server on http://localhost:1455.
//! https://auth.openai.com/oauth/authorize?response_type=code
//!   &client_id=app_EMoamEEZ73f0CkXaXp7hrann
//!   &redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
//!   &scope=openid%20profile%20email%20offline_access
//!          %20api.connectors.read%20api.connectors.invoke
//!   &code_challenge=…&code_challenge_method=S256
//!   &id_token_add_organizations=true&codex_cli_simplified_flow=true
//!   &state=…&originator=codex_cli_rs
//! ```
//!
//! The port is **fixed**: the client registers `http://localhost:1455/auth/
//! callback` (the binary also carries the string `default login callback port
//! is unavailable; falling back to the registered fallback port`, so a second
//! registered port exists, but its value is not recoverable from the binary and
//! is therefore not guessed here). A live login confirmed this shape is
//! accepted end to end: the IdP redirected to
//! `http://localhost:1455/auth/callback?code=…&scope=openid+profile+email+
//! offline_access+api.connectors.read+api.connectors.invoke&state=…`, which
//! then failed only because nothing was listening on 1455. Hence the host binds
//! that exact port for the duration of the flow.
//!
//! ## anthropic (`@anthropic-ai/claude-code`, `claude.exe`)
//!
//! The bundled authorize builder reads:
//!
//! ```text
//! d.searchParams.append("code","true")
//! d.searchParams.append("client_id", CLIENT_ID)          // 9d1c250a-e61b-44d9-88ed-5944d1962f5e
//! d.searchParams.append("response_type","code")
//! d.searchParams.append("redirect_uri",
//!     n ? MANUAL_REDIRECT_URL : `http://localhost:${r}/callback`)
//! … scope, code_challenge, code_challenge_method="S256", state
//! ```
//!
//! with `MANUAL_REDIRECT_URL = https://platform.claude.com/oauth/code/callback`
//! (the paste-the-code fallback) and `TOKEN_URL =
//! https://platform.claude.com/v1/oauth/token`. The loopback variant therefore
//! uses an **arbitrary** port with the fixed path `/callback` on the literal
//! host `localhost` (RFC 8252 port-any matching). Both defects of the old host
//! redirect are visible here: the wrong path, and the literal `127.0.0.1`
//! instead of `localhost`.
//!
//! The scope set stays the gateway's own (`user:profile user:inference
//! user:sessions:claude_code user:mcp_servers user:file_upload`); the official
//! CLI additionally requests `org:create_api_key`, which this host has no use
//! for and deliberately does not request.
//!
//! ## antigravity
//!
//! Unchanged: it keeps the management-listener redirect. Its client is
//! operator-supplied (client id and secret come from the host's secret store),
//! so no official fixed redirect can be derived from a shipped CLI. If that
//! client does not register the management callback, it needs the same
//! treatment - but guessing its registration would be exactly the defect fixed
//! here.
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
use workjet_provider_gateway::internal::auth::xai::{
    SystemXaiClock, XaiAuth, XaiLoginHttpTransport, XaiRefreshCoordinator,
};
use workjet_provider_gateway::sdk::auth::LoginCancellation;

use crate::loopback::{BoundCallback, CallbackBindError};
use crate::secret_store::antigravity_state_secret;

/// Fixed callback port the official codex client registers.
pub const CODEX_CALLBACK_PORT: u16 = 1455;
/// Path component of the codex client's registered redirect URI.
const CODEX_CALLBACK_PATH: &str = "/auth/callback";
/// Path component of the claude client's loopback redirect URI. The port is
/// free (RFC 8252 port-any matching); the path is not.
const ANTHROPIC_CALLBACK_PATH: &str = "/callback";

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
    /// Device flow: no redirect, no code exchange — the background poll task
    /// owns completion, `record_callback` never fires for it.
    XaiDevice,
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
    me: std::sync::Weak<Self>,
    management_endpoint: String,
    codex_callback_port: u16,
    antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
    pending: Mutex<BTreeMap<String, PendingLogin>>,
    outcomes: Mutex<BTreeMap<String, LoginOutcome>>,
    claims: Mutex<BTreeMap<String, Vec<ManagementClaimedCredential>>>,
    listeners: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
    /// Device-flow polls in flight, cancellable by state. The xai flow has no
    /// loopback listener to stop; cancelling the token poll is the analogue.
    device_polls: Mutex<BTreeMap<String, LoginCancellation>>,
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
    ) -> Arc<Self> {
        Self::with_codex_callback_port(management_endpoint, antigravity, CODEX_CALLBACK_PORT)
    }

    /// Same, with the codex callback port overridden. Only a deployment that
    /// cannot use the officially registered port - or a test - should do this:
    /// OpenAI rejects any other redirect target.
    #[must_use]
    pub fn with_codex_callback_port(
        management_endpoint: String,
        antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
        codex_callback_port: u16,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            management_endpoint,
            codex_callback_port,
            antigravity,
            pending: Mutex::new(BTreeMap::new()),
            outcomes: Mutex::new(BTreeMap::new()),
            claims: Mutex::new(BTreeMap::new()),
            listeners: Mutex::new(BTreeMap::new()),
            device_polls: Mutex::new(BTreeMap::new()),
        })
    }

    /// Stops and forgets the loopback redirect listener of `state`, if any.
    fn stop_listener(&self, state: &str) {
        if let Ok(mut listeners) = self.listeners.lock() {
            if let Some(handle) = listeners.remove(state) {
                handle.abort();
            }
        }
    }

    /// Cancels and forgets the device-flow token poll of `state`, if any.
    fn stop_device_poll(&self, state: &str) {
        if let Ok(mut polls) = self.device_polls.lock() {
            if let Some(cancellation) = polls.remove(state) {
                cancellation.cancel();
            }
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
        // `callback_path` is the portable crate's management-listener path. It
        // is only usable for a provider whose OAuth client registers it;
        // anthropic and codex do not (see the module documentation), so each of
        // them gets the loopback redirect its official client registers.
        let bound = match provider {
            "anthropic" => Some(BoundCallback::bind(0, ANTHROPIC_CALLBACK_PATH)),
            "codex" => Some(BoundCallback::bind(
                self.codex_callback_port,
                CODEX_CALLBACK_PATH,
            )),
            _ => None,
        }
        .transpose()
        .map_err(|error| match error {
            // A bounded, typed failure: the officially registered port is held
            // by something else (typically the official CLI's login server).
            CallbackBindError::PortUnavailable(_) | CallbackBindError::Unavailable => {
                ManagementProviderOAuthAuthorityError
            }
        })?;
        let redirect_uri = match bound.as_ref() {
            Some(bound) => bound.redirect_uri().to_owned(),
            None => self.redirect_uri(callback_path),
        };
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
            "xai" => {
                // DEVICE flow: the authorization URL is xAI's verification
                // page for this device code — obtained over the network, so
                // the sync `begin` briefly blocks in place (the host runs a
                // multi-threaded runtime). A background task then polls the
                // token endpoint until the operator approves in the browser.
                let transport = Arc::new(
                    XaiLoginHttpTransport::new()
                        .map_err(|_| ManagementProviderOAuthAuthorityError)?,
                );
                let auth = XaiAuth::new(
                    transport,
                    Arc::new(SystemXaiClock),
                    Arc::new(XaiRefreshCoordinator::default()),
                );
                let cancellation = LoginCancellation::default();
                let begin_cancellation = cancellation.clone();
                let code = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current()
                        .block_on(auth.start_device_flow(&begin_cancellation))
                })
                .map_err(|_| ManagementProviderOAuthAuthorityError)?;
                let url = [
                    code.verification_uri_complete.trim(),
                    code.verification_uri.trim(),
                ]
                .into_iter()
                .find(|value| !value.is_empty())
                .ok_or(ManagementProviderOAuthAuthorityError)?
                .to_owned();
                if let Ok(mut polls) = self.device_polls.lock() {
                    if let Some(previous) = polls.insert(state.to_owned(), cancellation.clone()) {
                        previous.cancel();
                    }
                }
                let authority = self
                    .me
                    .upgrade()
                    .ok_or(ManagementProviderOAuthAuthorityError)?;
                let poll_state = state.to_owned();
                tokio::spawn(async move {
                    let outcome = match auth.wait_for_authorization(&cancellation, &code).await {
                        Ok(bundle) => xai_device_outcome(&auth, &bundle),
                        Err(_) => LoginOutcome::Failed("Authentication failed".to_owned()),
                    };
                    let _ = authority.set_outcome(&poll_state, outcome);
                });
                (url, ProviderPkce::XaiDevice)
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
        if let Some(bound) = bound {
            let authority = self
                .me
                .upgrade()
                .ok_or(ManagementProviderOAuthAuthorityError)?;
            let handle = bound.serve(authority, provider.to_owned(), state.to_owned());
            if let Ok(mut listeners) = self.listeners.lock() {
                if let Some(previous) = listeners.insert(state.to_owned(), handle) {
                    previous.abort();
                }
            }
        }
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
            Some(LoginOutcome::Failed(message)) => {
                self.stop_listener(state);
                self.stop_device_poll(state);
                Ok(ManagementProviderOAuthPoll {
                    pending: false,
                    error: Some(message),
                    credentials: Vec::new(),
                })
            }
            Some(LoginOutcome::Completed(claimed)) => {
                self.stop_listener(state);
                self.stop_device_poll(state);
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
        // A cancelled login must release its loopback redirect port at once;
        // the codex port is fixed and shared with the official CLI.
        self.stop_listener(state);
        self.stop_device_poll(state);
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

/// Builds the claimable credential from a completed xAI device login. The
/// refresh token is REQUIRED: without it the account dies at the first
/// access-token expiry, silently — better to fail the login visibly.
fn xai_device_outcome(
    auth: &XaiAuth,
    bundle: &workjet_provider_gateway::internal::auth::xai::AuthBundle,
) -> LoginOutcome {
    let Some(storage) = auth.create_token_storage(Some(bundle)) else {
        return LoginOutcome::Failed("provider returned no credential".to_owned());
    };
    let credentials = storage.credentials();
    let Some(refresh_token) = credentials.refresh_token() else {
        return LoginOutcome::Failed("provider returned no refresh token".to_owned());
    };
    let Some(identity) = first_nonempty(&[storage.subject(), storage.email()]) else {
        return LoginOutcome::Failed("provider identity unavailable".to_owned());
    };
    LoginOutcome::Completed(vec![ManagementClaimedCredential {
        account: record("xai", &identity, storage.email()),
        secrets: BTreeMap::from([
            (
                "access_token_secret".to_owned(),
                credentials.access_token().expose_secret().to_owned(),
            ),
            (
                "refresh_token_secret".to_owned(),
                refresh_token.expose_secret().to_owned(),
            ),
        ]),
    }])
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
        Self::with_codex_callback_port(management_endpoint, antigravity, CODEX_CALLBACK_PORT)
    }

    /// Same, with the codex loopback callback port overridden. See
    /// [`HostOAuthAuthority::with_codex_callback_port`].
    #[must_use]
    pub fn with_codex_callback_port(
        management_endpoint: String,
        antigravity: Option<Arc<AntigravityOAuthClientCredentials>>,
        codex_callback_port: u16,
    ) -> Self {
        let sessions = Arc::new(ManagementOAuthSessions::new(Arc::new(SystemOAuthClock)));
        let credentials = Arc::new(ManagementCredentialService::new(Arc::new(
            MemoryCredentialStore::default(),
        )));
        let authority = HostOAuthAuthority::with_codex_callback_port(
            management_endpoint,
            antigravity,
            codex_callback_port,
        );
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

    /// Tests never bind the officially registered codex port: it is a fixed,
    /// machine-wide port shared with the official CLI.
    fn source() -> HostOAuthSource {
        HostOAuthSource::with_codex_callback_port("http://127.0.0.1:1/".to_owned(), None, 0)
    }

    fn query(url: &str) -> BTreeMap<String, String> {
        url.split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default()
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                (
                    key.to_owned(),
                    crate::loopback::decode_component_for_test(value),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn anthropic_authorizes_against_the_official_loopback_redirect() {
        let source = source();
        let start = source.begin("anthropic", Some("anthropic-shape")).unwrap();
        let url = start.authorization_url;
        assert!(
            url.starts_with("https://claude.ai/oauth/authorize?"),
            "{url}"
        );
        let params = query(&url);
        assert_eq!(
            params["client_id"], "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "{url}"
        );
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code"], "true");
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["state"], "anthropic-shape");
        let redirect = &params["redirect_uri"];
        // Official shape: literal `localhost`, free port, fixed `/callback`.
        assert!(redirect.starts_with("http://localhost:"), "{redirect}");
        assert!(redirect.ends_with("/callback"), "{redirect}");
        assert!(!redirect.contains("management"), "{redirect}");
        assert!(!redirect.contains("127.0.0.1"), "{redirect}");
    }

    #[tokio::test]
    async fn codex_authorizes_against_the_official_loopback_redirect() {
        let source = source();
        let start = source.begin("codex", Some("codex-shape")).unwrap();
        let url = start.authorization_url;
        assert!(
            url.starts_with("https://auth.openai.com/oauth/authorize?"),
            "{url}"
        );
        let params = query(&url);
        assert_eq!(params["client_id"], "app_EMoamEEZ73f0CkXaXp7hrann", "{url}");
        assert_eq!(params["response_type"], "code");
        assert_eq!(
            params["scope"],
            "openid profile email offline_access api.connectors.read api.connectors.invoke"
        );
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["id_token_add_organizations"], "true");
        assert_eq!(params["codex_cli_simplified_flow"], "true");
        assert_eq!(params["originator"], "codex_cli_rs");
        assert!(!params.contains_key("prompt"), "{url}");
        assert_eq!(params["state"], "codex-shape");
        let redirect = &params["redirect_uri"];
        assert!(redirect.starts_with("http://localhost:"), "{redirect}");
        assert!(redirect.ends_with("/auth/callback"), "{redirect}");
        assert!(!redirect.contains("management"), "{redirect}");
    }

    #[tokio::test]
    async fn the_default_codex_callback_port_is_the_registered_one() {
        assert_eq!(CODEX_CALLBACK_PORT, 1455);
        assert_eq!(CODEX_CALLBACK_PATH, "/auth/callback");
        assert_eq!(ANTHROPIC_CALLBACK_PATH, "/callback");
    }

    #[tokio::test]
    async fn the_loopback_redirect_completes_the_pending_session() {
        let source = source();
        let start = source.begin("codex", Some("redirect-state")).unwrap();
        let redirect = query(&start.authorization_url)
            .remove("redirect_uri")
            .unwrap();
        let port = redirect
            .trim_start_matches("http://localhost:")
            .split('/')
            .next()
            .unwrap()
            .to_owned();
        let authority = format!("127.0.0.1:{port}");

        // A redirect for a different session is rejected and does not complete
        // this one.
        let foreign = get(&authority, "/auth/callback?code=abc&state=someone-else").await;
        assert!(foreign.starts_with("HTTP/1.1 400"), "{foreign}");
        assert!(source.poll("redirect-state").unwrap().pending);

        // The provider's own error redirect completes the session as failed
        // without any token exchange.
        let response = get(
            &authority,
            "/auth/callback?error=access_denied&state=redirect-state",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let polled = source.poll("redirect-state").unwrap();
        assert!(!polled.pending);
        assert_eq!(polled.error.as_deref(), Some("access_denied"));
    }

    async fn get(authority: &str, target: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(authority).await.unwrap();
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    #[tokio::test]
    async fn claims_the_canonical_provider_payload_exactly_once() {
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

    #[tokio::test]
    async fn cancelling_a_session_drops_any_retained_token_material() {
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
