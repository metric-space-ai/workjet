//! Workjet's fixed cache-preserving policy and durable account observations.
use crate::config::ALLOWED_SECRET_SCOPE;
use crate::secret_store::{SecretResolveError, WorkjetSecretStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use workjet_provider_gateway::internal::config::RuntimeSecretRef;
use workjet_provider_gateway::sdk::cliproxy::auth::conductor_execution::AccountPolicy;
use workjet_provider_gateway::sdk::cliproxy::auth::scheduler::{
    canonical_model_key, model_entry_matches,
};
use workjet_provider_gateway::sdk::cliproxy::auth::{
    AccountCandidate, AccountExecutionResult, AccountSelectionError, CooldownConductor,
    CooldownStateRecord, CooldownStateStore, CooldownStoreError,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub name: String,
    pub remaining_percent: Option<f64>,
    pub resets_at_ms: Option<i64>,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    api_key_fingerprints: BTreeMap<String, String>,
    #[serde(default)]
    observations: BTreeMap<String, (u16, i64)>,
    #[serde(default)]
    affinities: BTreeMap<String, String>,
    #[serde(default)]
    cooldowns: Vec<CooldownStateRecord>,
    #[serde(default)]
    quotas: BTreeMap<String, Vec<QuotaWindow>>,
}

pub struct AccountState {
    store: Arc<WorkjetSecretStore>,
    state: Mutex<State>,
    conductor: Arc<CooldownConductor>,
}
impl AccountState {
    /// Replacing an API credential preserves its session lane and discards
    /// observations from the previous credential. Plaintext never enters state.
    pub fn bind_api_key(
        &self,
        provider: &str,
        account: &str,
        key: &[u8],
    ) -> Result<(), CooldownStoreError> {
        let identity = account_key(provider, account);
        let fingerprint = format!("{:x}", Sha256::digest(key));
        let mut state = self.state.lock().map_err(|_| CooldownStoreError::Write)?;
        if state.api_key_fingerprints.get(&identity) == Some(&fingerprint) {
            return Ok(());
        }
        let mut next = state.clone();
        if next.api_key_fingerprints.contains_key(&identity) {
            next.cooldowns
                .retain(|r| !(r.provider.eq_ignore_ascii_case(provider) && r.auth_id == account));
            next.quotas.remove(&identity);
            next.observations.remove(&identity);
        }
        next.api_key_fingerprints.insert(identity, fingerprint);
        self.persist(&next)?;
        *state = next;
        Ok(())
    }
    fn reference() -> RuntimeSecretRef {
        RuntimeSecretRef {
            scope: ALLOWED_SECRET_SCOPE.to_owned(),
            name: "account-policy-state.v1".to_owned(),
        }
    }
    pub fn open(store: Arc<WorkjetSecretStore>) -> Result<Arc<Self>, CooldownStoreError> {
        let state = match store.resolve_text(&Self::reference()) {
            Ok(text) => serde_json::from_str(&text).map_err(|_| CooldownStoreError::Read)?,
            Err(SecretResolveError::Missing) => State::default(),
            Err(_) => return Err(CooldownStoreError::Read),
        };
        Ok(Arc::new_cyclic(|weak| Self {
            store,
            state: Mutex::new(state),
            conductor: Arc::new(CooldownConductor::new(Arc::new(WeakStore(weak.clone())))),
        }))
    }
    pub fn conductor(&self) -> Arc<CooldownConductor> {
        self.conductor.clone()
    }
    fn persist(&self, state: &State) -> Result<(), CooldownStoreError> {
        let text = serde_json::to_string(state).map_err(|_| CooldownStoreError::Write)?;
        self.store
            .write_text(&Self::reference(), &text)
            .map_err(|_| CooldownStoreError::Write)
    }
    pub fn observe_quota(
        &self,
        provider: &str,
        account: &str,
        windows: Vec<QuotaWindow>,
    ) -> Result<(), CooldownStoreError> {
        let mut state = self.state.lock().map_err(|_| CooldownStoreError::Write)?;
        let mut next = state.clone();
        next.quotas.insert(account_key(provider, account), windows);
        self.persist(&next)?;
        *state = next;
        Ok(())
    }
    pub fn observation(&self, provider: &str, account: &str) -> Option<(u16, i64)> {
        self.state
            .lock()
            .ok()?
            .observations
            .get(&account_key(provider, account))
            .copied()
    }
    pub fn quotas(&self, provider: &str, account: &str) -> Vec<QuotaWindow> {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.quotas.get(&account_key(provider, account)).cloned())
            .unwrap_or_default()
    }
}
impl CooldownStateStore for AccountState {
    fn observe_outcome(&self, result: &AccountExecutionResult) -> Result<(), CooldownStoreError> {
        let mut state = self.state.lock().map_err(|_| CooldownStoreError::Write)?;
        let mut next = state.clone();
        next.observations.insert(
            account_key(&result.provider, &result.auth_id),
            (result.status, result.observed_at_ms),
        );
        self.persist(&next)?;
        *state = next;
        Ok(())
    }
    fn load(&self) -> Result<Vec<CooldownStateRecord>, CooldownStoreError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| CooldownStoreError::Read)?
            .cooldowns
            .clone())
    }
    fn save(&self, records: &[CooldownStateRecord]) -> Result<(), CooldownStoreError> {
        let mut state = self.state.lock().map_err(|_| CooldownStoreError::Write)?;
        let mut next = state.clone();
        next.cooldowns = records.to_vec();
        self.persist(&next)?;
        *state = next;
        Ok(())
    }
}
fn account_key(provider: &str, account: &str) -> String {
    format!("{}:{account}", provider.trim().to_ascii_lowercase())
}
fn affinity_key(provider: &str, body: &[u8]) -> String {
    let value = serde_json::from_slice::<serde_json::Value>(body).ok();
    let session = value
        .as_ref()
        .and_then(|v| {
            [
                v.get("prompt_cache_key"),
                v.get("session_id"),
                v.pointer("/metadata/session_id"),
                v.pointer("/metadata/user_id"),
            ]
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .find(|v| !v.trim().is_empty())
        })
        .unwrap_or("unidentified-session");
    format!(
        "{}:{:x}",
        provider.trim().to_ascii_lowercase(),
        Sha256::digest(session.as_bytes())
    )
}
impl AccountPolicy for AccountState {
    fn select(
        &self,
        provider: &str,
        model: Option<&str>,
        now: i64,
        candidates: &[AccountCandidate],
        cooldowns: &[CooldownStateRecord],
        body: &[u8],
    ) -> Result<AccountCandidate, AccountSelectionError> {
        let requested = canonical_model_key(model.unwrap_or(""));
        let mut state = self
            .state
            .lock()
            .map_err(|_| AccountSelectionError::State)?;
        let all_cooldowns = cooldowns
            .iter()
            .chain(state.cooldowns.iter())
            .cloned()
            .collect::<Vec<_>>();
        let cooldowns = all_cooldowns.as_slice();
        let eligible: Vec<_> = candidates
            .iter()
            .filter(|c| {
                !c.disabled
                    && c.provider.eq_ignore_ascii_case(provider)
                    && (c.supported_models.is_empty()
                        || c.supported_models
                            .iter()
                            .any(|m| model_entry_matches(m, &requested)))
                    && !cooldowns.iter().any(|r| {
                        r.provider.eq_ignore_ascii_case(provider)
                            && r.auth_id == c.auth_id
                            && (r.model.is_none()
                                || r.model
                                    .as_deref()
                                    .is_some_and(|m| canonical_model_key(m) == requested))
                            && !r.is_available_at(now)
                    })
                    && !state
                        .quotas
                        .get(&account_key(provider, &c.auth_id))
                        .is_some_and(|windows| {
                            windows.iter().any(|w| {
                                (w.name != "seven_day_opus"
                                    || requested.to_ascii_lowercase().contains("opus"))
                                    && (w.name != "seven_day_sonnet"
                                        || requested.to_ascii_lowercase().contains("sonnet"))
                                    && now.saturating_sub(w.observed_at_ms) < 300_000
                                    && w.remaining_percent == Some(0.0)
                                    && w.resets_at_ms.is_none_or(|reset| reset > now)
                            })
                        })
            })
            .collect();
        if eligible.is_empty() {
            return cooldowns
                .iter()
                .filter(|r| {
                    r.provider.eq_ignore_ascii_case(provider)
                        && candidates.iter().any(|c| c.auth_id == r.auth_id)
                })
                .filter_map(|r| r.blocking_until_ms())
                .filter(|t| *t > now)
                .min()
                .map_or(Err(AccountSelectionError::Unavailable), |retry_after_ms| {
                    Err(AccountSelectionError::Cooldown { retry_after_ms })
                });
        }
        let key = affinity_key(provider, body);
        if let Some(account) = state.affinities.get(&key) {
            if let Some(candidate) = eligible.iter().find(|c| c.auth_id == *account) {
                return Ok((*candidate).clone());
            }
        }
        let selected = eligible
            .into_iter()
            .min_by_key(|c| {
                let expiry = state
                    .quotas
                    .get(&account_key(provider, &c.auth_id))
                    .into_iter()
                    .flatten()
                    .filter(|w| {
                        (w.name != "seven_day_opus"
                            || requested.to_ascii_lowercase().contains("opus"))
                            && (w.name != "seven_day_sonnet"
                                || requested.to_ascii_lowercase().contains("sonnet"))
                            && now.saturating_sub(w.observed_at_ms) < 300_000
                            && w.remaining_percent.is_some_and(|r| r > 0.0)
                    })
                    .filter_map(|w| w.resets_at_ms)
                    .filter(|t| *t > now)
                    .min();
                (
                    expiry.unwrap_or(i64::MAX),
                    std::cmp::Reverse(c.priority),
                    c.auth_id.clone(),
                )
            })
            .ok_or(AccountSelectionError::Unavailable)?
            .clone();
        let mut next = state.clone();
        next.affinities.insert(key, selected.auth_id.clone());
        self.persist(&next)
            .map_err(|_| AccountSelectionError::State)?;
        *state = next;
        Ok(selected)
    }
    fn outcome(&self, provider: &str, account: &str, model: &str, status: u16, now: i64) {
        let _ = self.conductor.record(AccountExecutionResult {
            provider: provider.to_owned(),
            auth_id: account.to_owned(),
            model: Some(model.to_owned()),
            status,
            retry_delay_ms: None,
            observed_at_ms: now,
        });
    }
}
struct WeakStore(std::sync::Weak<AccountState>);
impl CooldownStateStore for WeakStore {
    fn observe_outcome(&self, result: &AccountExecutionResult) -> Result<(), CooldownStoreError> {
        self.0
            .upgrade()
            .ok_or(CooldownStoreError::Write)?
            .observe_outcome(result)
    }
    fn load(&self) -> Result<Vec<CooldownStateRecord>, CooldownStoreError> {
        self.0.upgrade().ok_or(CooldownStoreError::Read)?.load()
    }
    fn save(&self, records: &[CooldownStateRecord]) -> Result<(), CooldownStoreError> {
        self.0
            .upgrade()
            .ok_or(CooldownStoreError::Write)?
            .save(records)
    }
}
