#[test]
fn verified_same_token_login_clears_only_its_auth_failure_and_preserves_session() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = ["a", "b"].map(|id| AccountCandidate {
        auth_id: id.into(),
        provider: "xai".into(),
        supported_models: vec!["grok-4.7".into()],
        ..Default::default()
    });
    state.bind_oauth("xai", "a", b"reused-access").unwrap();
    state.bind_oauth("xai", "b", b"other-access").unwrap();
    state
        .observe_quota("xai", "a", quota(5000, 1000, 50.0))
        .unwrap();
    state
        .observe_quota("xai", "b", quota(3000, 1000, 30.0))
        .unwrap();
    let body = br#"{"session_id":"retained-xai-session"}"#;
    assert_eq!(
        state
            .select("xai", Some("grok-4.7"), 1000, &accounts[..1], &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("xai", "a", "grok-4.7", 401, 1001);
    state.outcome("xai", "b", "grok-4.7", 403, 1001);
    state.outcome("xai", "quota-account", "grok-4.7", 429, 1001);
    state.outcome("xai", "model-account", "grok-4.7", 404, 1001);
    let before = state.load().unwrap();
    assert_eq!(before.len(), 4);
    // Startup alone, an unrelated token and another provider cannot heal an auth rejection.
    let state = open(dir.path());
    state.bind_oauth("xai", "a", b"reused-access").unwrap();
    state
        .recover_oauth_claim("xai", b"unrelated-access")
        .unwrap();
    state
        .recover_oauth_claim("claude", b"reused-access")
        .unwrap();
    assert_eq!(state.load().unwrap(), before);
    state.recover_oauth_claim("xai", b"reused-access").unwrap();
    assert_eq!(
        state.load().unwrap(),
        before
            .into_iter()
            .filter(|record| record.auth_id != "a")
            .collect::<Vec<_>>(),
    );
    assert!(state.observation("xai", "a").is_none());
    assert_eq!(state.observation("xai", "b").unwrap().0, 403);
    assert_eq!(state.quotas("xai", "a")[0].remaining_percent, Some(50.0));
    assert_eq!(state.quotas("xai", "b")[0].remaining_percent, Some(30.0));
    // A request already running in the old process may report after the claim.
    state.outcome("xai", "a", "grok-4.7", 401, 1002);
    let restarted = open(dir.path());
    restarted.bind_oauth("xai", "a", b"reused-access").unwrap();
    assert_eq!(
        restarted
            .select("xai", Some("grok-4.7"), 1002, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    assert!(restarted.observation("xai", "a").is_none());
    assert_eq!(restarted.load().unwrap().len(), 3);
    let snapshot = std::fs::read_to_string(
        dir.path()
            .join("workjet-provider-gateway.account-policy-state.v1.bin"),
    )
    .unwrap();
    assert!(!snapshot.contains("reused-access"));
    assert!(!snapshot.contains("retained-xai-session"));
}

#[test]
#[cfg(unix)]
fn failed_durable_probe_write_reports_refresh_error_without_changing_auth_or_affinity() {
    use std::os::unix::fs::PermissionsExt;
    use workjet_provider_gateway_host::account_health::observe_usage;
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = [candidate("a")];
    let body = br#"{"session_id":"persist-session"}"#;
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1000, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("codex", "a", "gpt-5", 200, 1001);
    assert_eq!(
        observe_usage(
            &state,
            "codex",
            "a",
            br#"{"rate_limit":{"primary_window":{"used_percent":50,"reset_at":1000}}}"#,
            1002
        ),
        200
    );
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let status = observe_usage(
        &state,
        "codex",
        "a",
        br#"{"rate_limit":{"primary_window":{"used_percent":100,"reset_at":1000}}}"#,
        1003,
    );
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(status, 0);
    assert_eq!(state.quotas("codex", "a")[0].remaining_percent, Some(50.0));
    assert_eq!(state.observation("codex", "a"), Some((200, 1001)));
    assert_eq!(
        state
            .select("codex", Some("gpt-5"), 1004, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
}
#[test]
fn scoped_api_quota_blocks_only_matching_model_and_never_unlimited_or_tools() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = ["a", "b"].map(|id| AccountCandidate {
        provider: "minimax".into(),
        supported_models: vec!["MiniMax-M*".into()],
        ..candidate(id)
    });
    let windows = parse_usage(
        "minimax",
        br#"{"model_remains":[
      {"model_name":"MiniMax-M3","current_interval_remaining_percent":0,"end_time":1000000},
      {"model_name":"video","current_interval_remaining_percent":0,"end_time":1000000},
      {"model_name":"general","current_interval_status":3,"current_interval_remaining_percent":0}
    ]}"#,
        1000,
    )
    .unwrap();
    state.observe_quota("minimax", "a", windows).unwrap();
    assert_eq!(
        state
            .select(
                "minimax",
                Some("MiniMax-M2.7"),
                400000,
                &accounts,
                &[],
                br#"{"session_id":"scoped"}"#
            )
            .unwrap()
            .auth_id,
        "a"
    );
    assert_eq!(
        state
            .select(
                "minimax",
                Some("MiniMax-M3"),
                400000,
                &accounts,
                &[],
                br#"{"session_id":"blocked"}"#
            )
            .unwrap()
            .auth_id,
        "b"
    );
    assert_eq!(
        open(dir.path())
            .select(
                "minimax",
                Some("MiniMax-M2.7"),
                400001,
                &accounts,
                &[],
                br#"{"session_id":"scoped"}"#
            )
            .unwrap()
            .auth_id,
        "a"
    );
}
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

#[test]
fn upstream_change_retires_only_that_accounts_old_health_and_keeps_affinity() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    // Verified stored-account model list, 2026-10-09.
    let model = "glm-5.3-flash";
    let accounts = ["a", "b"].map(|id| AccountCandidate {
        provider: "zai".into(),
        supported_models: vec![model.into()],
        ..candidate(id)
    });
    let body = br#"{"session_id":"stable-plan-session"}"#;
    state.bind_api_key("zai", "a", b"same-api-key").unwrap();
    assert_eq!(state.select("zai", Some(model), 1000, &accounts, &[], body).unwrap().auth_id, "a");
    state.outcome("zai", "a", model, 429, 1001);
    state.outcome("zai", "b", model, 429, 1001);
    let coding = "https://api.z.ai/api/coding/paas/v4";
    state.bind_api_key_target("zai", "a", b"same-api-key", Some(coding)).unwrap();
    assert!(state.observation("zai", "a").is_none());
    assert_eq!(state.observation("zai", "b").unwrap().0, 429);
    assert_eq!(state.select("zai", Some(model), 1002, &accounts, &[], body).unwrap().auth_id, "a");
    state.outcome("zai", "a", model, 429, 1003);
    let restarted = open(dir.path());
    restarted.bind_api_key_target("zai", "a", b"same-api-key", Some(coding)).unwrap();
    assert_eq!(restarted.observation("zai", "a").unwrap().0, 429);
    assert!(restarted.select("zai", Some(model), 1004, &accounts, &[], body).is_err());
    let snapshot = std::fs::read_to_string(dir.path().join("workjet-provider-gateway.account-policy-state.v1.bin")).unwrap();
    assert!(!snapshot.contains("same-api-key"));
    assert!(!snapshot.contains("stable-plan-session"));
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
        ..Default::default()
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
fn known_exhaustion_survives_read_freshness_until_reset() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = vec![candidate("a")];
    state
        .observe_quota("codex", "a", quota(1_000_000, 1000, 0.0))
        .unwrap();
    assert!(state
        .select("codex", Some("gpt-5"), 400_000, &accounts, &[], b"{}")
        .is_err());
    assert!(open(dir.path())
        .select("codex", Some("gpt-5"), 400_000, &accounts, &[], b"{}")
        .is_err());
    assert!(state
        .select("codex", Some("gpt-5"), 1_000_000, &accounts, &[], b"{}")
        .is_ok());
    state
        .observe_quota(
            "codex",
            "a",
            vec![QuotaWindow {
                name: "primary".into(),
                remaining_percent: Some(0.0),
                resets_at_ms: None,
                observed_at_ms: 1000,
                ..Default::default()
            }],
        )
        .unwrap();
    assert!(state
        .select("codex", Some("gpt-5"), 400_000, &accounts, &[], b"{}")
        .is_ok());
}
#[test]
fn known_future_resets_still_prioritize_new_sessions_after_read_aging() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let accounts = vec![candidate("a"), candidate("b")];
    state
        .observe_quota("codex", "a", quota(900_000, 1000, 50.0))
        .unwrap();
    state
        .observe_quota("codex", "b", quota(600_000, 1000, 50.0))
        .unwrap();
    assert_eq!(
        state
            .select(
                "codex",
                Some("gpt-5"),
                400_000,
                &accounts,
                &[],
                br#"{"session_id":"aged-new-session"}"#
            )
            .unwrap()
            .auth_id,
        "b"
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
