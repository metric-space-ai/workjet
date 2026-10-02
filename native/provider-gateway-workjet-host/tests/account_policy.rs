#[test]
fn oauth_relogin_clears_rejection_preserves_affinity_and_known_quota() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = vec![candidate("a"), candidate("b")];
    state.bind_oauth("codex", "a", b"old-oauth-access").unwrap();
    state
        .observe_quota("codex", "a", quota(5000, 1000, 50.0))
        .unwrap();
    let body = br#"{"session_id":"oauth-session"}"#;
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1000, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("codex", "a", "gpt-5", 401, 1001);
    assert_eq!(state.observation("codex", "a").unwrap().0, 401);
    state.bind_oauth("codex", "a", b"new-oauth-access").unwrap();
    assert!(state.observation("codex", "a").is_none());
    assert!(state.load().unwrap().is_empty());
    assert_eq!(state.quotas("codex", "a")[0].remaining_percent, Some(50.0));
    let restarted = open(dir.path());
    assert_eq!(
        restarted
            .select("codex", Some("gpt-5"), 1002, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    // Loading the identical token cannot erase a subsequent genuine rejection.
    restarted.outcome("codex", "a", "gpt-5", 401, 1003);
    restarted
        .bind_oauth("codex", "a", b"new-oauth-access")
        .unwrap();
    assert_eq!(restarted.observation("codex", "a").unwrap().0, 401);
    let snapshot = std::fs::read_to_string(
        dir.path()
            .join("workjet-provider-gateway.account-policy-state.v1.bin"),
    )
    .unwrap();
    assert!(!snapshot.contains("oauth-access"));
    assert!(!snapshot.contains("oauth-session"));
}
#[test]
fn api_key_replacement_clears_old_health_without_moving_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = ["a", "b"].map(|id| AccountCandidate {
        provider: "zai".into(),
        supported_models: vec!["glm-*".into()],
        ..candidate(id)
    });
    state.bind_api_key("zai", "a", b"old-api-key").unwrap();
    let body = br#"{"session_id":"api-session"}"#;
    assert_eq!(
        state
            .select("zai", Some("glm-5"), 1000, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("zai", "a", "glm-5", 401, 1001);
    assert_eq!(
        state
            .select("zai", Some("glm-5"), 1002, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "b"
    );
    state.bind_api_key("zai", "a", b"new-api-key").unwrap();
    assert!(state.load().unwrap().is_empty());
    assert_eq!(
        state
            .select("zai", Some("glm-5"), 1003, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "b"
    );
    let snapshot = std::fs::read_to_string(
        dir.path()
            .join("workjet-provider-gateway.account-policy-state.v1.bin"),
    )
    .unwrap();
    assert!(!snapshot.contains("old-api-key"));
    assert!(!snapshot.contains("new-api-key"));
    assert!(!snapshot.contains("api-session"));
}

use std::sync::Arc;
use workjet_provider_gateway::sdk::cliproxy::auth::conductor_execution::AccountPolicy;
use workjet_provider_gateway::sdk::cliproxy::auth::{AccountCandidate, CooldownStateStore};
use workjet_provider_gateway_host::{
    account_health::parse_usage,
    account_policy::{AccountState, QuotaWindow},
    secret_store::WorkjetSecretStore,
};
fn candidate(id: &str) -> AccountCandidate {
    AccountCandidate {
        auth_id: id.into(),
        provider: "codex".into(),
        supported_models: vec!["gpt-*".into()],
        ..Default::default()
    }
}
fn open(dir: &std::path::Path) -> Arc<AccountState> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    AccountState::open(Arc::new(WorkjetSecretStore::new(dir.to_owned()).unwrap())).unwrap()
}
fn quota(reset: i64, observed: i64, remaining: f64) -> Vec<QuotaWindow> {
    vec![QuotaWindow {
        name: "primary".into(),
        remaining_percent: Some(remaining),
        resets_at_ms: Some(reset),
        observed_at_ms: observed,
    }]
}
#[test]
fn expiry_preference_never_moves_usable_session_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = vec![candidate("a"), candidate("b")];
    state
        .observe_quota("codex", "a", quota(5000, 1000, 50.0))
        .unwrap();
    state
        .observe_quota("codex", "b", quota(3000, 1000, 30.0))
        .unwrap();
    let first = br#"{"prompt_cache_key":"first"}"#;
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1000, &accounts, &[], first)
            .unwrap()
            .auth_id,
        "b"
    );
    state
        .observe_quota("codex", "a", quota(2000, 1000, 50.0))
        .unwrap();
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1001, &accounts, &[], first)
            .unwrap()
            .auth_id,
        "b"
    );
    let second = br#"{"prompt_cache_key":"second"}"#;
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1001, &accounts, &[], second)
            .unwrap()
            .auth_id,
        "a"
    );
    drop(state);
    let state = open(dir.path());
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1002, &accounts, &[], first)
            .unwrap()
            .auth_id,
        "b"
    );
    let mut disabled = accounts.clone();
    disabled[1].disabled = true;
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1003, &disabled, &[], first)
            .unwrap()
            .auth_id,
        "a"
    );
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1004, &accounts, &[], first)
            .unwrap()
            .auth_id,
        "a"
    );
}
#[test]
fn errors_switch_only_after_account_becomes_unusable_and_do_not_switch_back() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = vec![candidate("b"), candidate("a")];
    let body = br#"{"session_id":"s"}"#;
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1000, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("codex", "a", "gpt-5", 400, 1000);
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1001, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("codex", "a", "gpt-5", 429, 1001);
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1002, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "b"
    );
    assert!(!state.load().unwrap().is_empty());
    drop(state);
    let state = open(dir.path());
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1003, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "b"
    );
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1_000_000, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "b"
    );
}
#[test]
fn exhausted_quota_and_disabled_accounts_are_not_selected() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let mut accounts = vec![candidate("a"), candidate("b")];
    state
        .observe_quota("codex", "a", quota(5000, 1000, 0.0))
        .unwrap();
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1000, &accounts, &[], b"{}")
            .unwrap()
            .auth_id,
        "b"
    );
    accounts[1].disabled = true;
    assert!(state
        .select("codex", Some("gpt-5"), 1000, &accounts, &[], b"{}")
        .is_err());
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 5001, &accounts, &[], b"{}")
            .unwrap()
            .auth_id,
        "a"
    );
}
#[test]
fn authentic_quota_parsers_keep_missing_values_unknown() {
    let codex=parse_usage("codex",br#"{"rate_limit":{"primary_window":{"used_percent":42,"reset_at":123},"secondary_window":null}}"#,1000).unwrap();
    assert_eq!(codex[0].remaining_percent, Some(58.0));
    assert_eq!(codex[0].resets_at_ms, Some(123000));
    let claude=parse_usage("claude",br#"{"five_hour":{"utilization":80,"resets_at":"2026-10-02T10:00:00Z"},"seven_day":{"utilization":null,"resets_at":null}}"#,1000).unwrap();
    assert_eq!(claude[0].remaining_percent, Some(20.0));
    assert!(claude[0].resets_at_ms.is_some());
    assert_eq!(claude[1].remaining_percent, None);
    assert_eq!(claude[1].resets_at_ms, None);
    assert!(parse_usage("xai", br#"{"usage":42}"#, 1000).is_none());
    assert_eq!(
        parse_usage("codex", br#"{"rate_limit":null}"#, 1000).unwrap(),
        vec![]
    );
}
