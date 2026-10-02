use std::sync::Arc;
use workjet_provider_gateway::sdk::cliproxy::auth::conductor_execution::AccountPolicy;
use workjet_provider_gateway_host::{
    account_health::{api_quota_endpoint, observe_balance, parse_balance},
    account_policy::{balance_is_exhausted, AccountState},
    secret_store::WorkjetSecretStore,
};
const GLOBAL: &str = "https://api.moonshot.ai/v1/users/me/balance";
const CHINA: &str = "https://api.moonshot.cn/v1/users/me/balance";
const POSITIVE: &[u8] = br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":49.58894,"cash_balance":-3,"voucher_balance":49.58894}}"#;
fn open(root: &std::path::Path) -> Arc<AccountState> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    AccountState::open(Arc::new(WorkjetSecretStore::new(root.to_owned()).unwrap())).unwrap()
}
fn candidates() -> Vec<workjet_provider_gateway::sdk::cliproxy::auth::AccountCandidate> {
    ["a", "b"]
        .map(
            |id| workjet_provider_gateway::sdk::cliproxy::auth::AccountCandidate {
                auth_id: id.into(),
                provider: "kimi".into(),
                supported_models: vec!["kimi-*".into()],
                ..Default::default()
            },
        )
        .to_vec()
}
#[test]
fn balance_destinations_are_regional_and_never_kimi_code_or_custom_upstreams() {
    assert_eq!(
        api_quota_endpoint("kimi", "https://api.moonshot.ai/v1/"),
        Some(GLOBAL)
    );
    assert_eq!(
        api_quota_endpoint("kimi", "https://api.moonshot.cn/v1"),
        Some(CHINA)
    );
    for base in [
        "https://api.kimi.com/coding",
        "https://api.kimi.ai/coding/v1",
        "https://custom.example/v1",
        "https://api.moonshot.ai.attacker.test/v1",
        "https://api.moonshot.ai:444/v1",
        "https://api.moonshot.ai/custom",
    ] {
        assert_eq!(api_quota_endpoint("kimi", base), None);
    }
    assert_eq!(
        api_quota_endpoint("minimax", "https://api.moonshot.ai/v1"),
        None
    );
    assert!(parse_balance("https://api.kimi.com/coding", POSITIVE, 1000).is_none());
}
#[test]
fn official_balance_schema_preserves_amounts_and_regional_currency() {
    for (url, currency) in [(GLOBAL, "USD"), (CHINA, "CNY")] {
        let balance = parse_balance(url, POSITIVE, 1000).unwrap();
        assert_eq!(balance.available_balance, 49.58894);
        assert_eq!(balance.currency, currency);
        assert_eq!(balance.cash_balance, Some(-3.0));
        assert_eq!(balance.voucher_balance, Some(49.58894));
        assert_eq!(balance.observed_at_ms, 1000);
        assert!(!balance_is_exhausted(&balance, 1001));
    }
    let minimal = parse_balance(
        GLOBAL,
        br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":0}}"#,
        1000,
    )
    .unwrap();
    assert_eq!(minimal.cash_balance, None);
    assert_eq!(minimal.voucher_balance, None);
    assert!(balance_is_exhausted(&minimal, 1001));
    assert!(!balance_is_exhausted(&minimal, 301000));
    assert!(!balance_is_exhausted(&minimal, 999));
    let negative = parse_balance(
        CHINA,
        br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":-1}}"#,
        1000,
    )
    .unwrap();
    assert!(balance_is_exhausted(&negative, 1001));
}
#[test]
fn unsuccessful_missing_or_malformed_readings_stay_unknown() {
    for body in [
        br#"{}"#.as_slice(),
        br#"{"code":123,"status":true,"scode":"0x0","data":{"available_balance":0}}"#,
        br#"{"code":0,"status":false,"scode":"0x0","data":{"available_balance":0}}"#,
        br#"{"code":0,"status":true,"scode":"error","data":{"available_balance":0}}"#,
        br#"{"code":0,"status":true,"scode":"0x0","data":{}}"#,
        br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":"0"}}"#,
        br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":null}}"#,
        br#"{"error":{"code":"permission_denied"}}"#,
    ] {
        assert!(parse_balance(GLOBAL, body, 1000).is_none());
    }
    assert!(parse_balance(GLOBAL, &vec![b' '; 256 * 1024 + 1], 1000).is_none());
}
#[test]
fn failed_balance_read_preserves_auth_affinity_and_durable_reading() {
    let root = tempfile::tempdir().unwrap();
    let state = open(root.path());
    let candidates = candidates();
    let session = br#"{"session_id":"balance-session"}"#;
    state.bind_api_key("kimi", "a", b"fixture-key").unwrap();
    assert_eq!(
        state
            .select("kimi", Some("kimi-k2.5"), 1000, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "a"
    );
    state.outcome("kimi", "a", "kimi-k2.5", 200, 1001);
    assert_eq!(observe_balance(&state, "a", GLOBAL, POSITIVE, 1002), 200);
    assert_eq!(
        observe_balance(
            &state,
            "a",
            GLOBAL,
            br#"{"error":{"code":"permission_denied"}}"#,
            1003
        ),
        0
    );
    assert_eq!(state.observation("kimi", "a"), Some((200, 1001)));
    let restarted = open(root.path());
    assert_eq!(
        restarted.balance("kimi", "a").unwrap().available_balance,
        49.58894
    );
    assert_eq!(
        restarted
            .select("kimi", Some("kimi-k2.5"), 1004, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "a"
    );
    restarted
        .bind_api_key("kimi", "a", b"replacement-key")
        .unwrap();
    assert!(restarted.balance("kimi", "a").is_none());
    assert_eq!(
        restarted
            .select("kimi", Some("kimi-k2.5"), 1005, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "a"
    );
}
#[test]
fn only_fresh_authoritative_nonpositive_balance_blocks_inference() {
    let root = tempfile::tempdir().unwrap();
    let state = open(root.path());
    let candidates = candidates();
    let session = br#"{"session_id":"stale-balance"}"#;
    assert_eq!(
        state
            .select("kimi", Some("kimi-k2.5"), 1000, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "a"
    );
    let zero = br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":0}}"#;
    assert_eq!(observe_balance(&state, "a", GLOBAL, zero, 1001), 200);
    // Unknown refill time: a stale zero cannot shift an otherwise usable sticky session.
    assert_eq!(
        open(root.path())
            .select("kimi", Some("kimi-k2.5"), 301001, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "a"
    );
    assert_eq!(
        state
            .select("kimi", Some("kimi-k2.5"), 1002, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "b"
    );
    assert_eq!(observe_balance(&state, "a", GLOBAL, POSITIVE, 1003), 200);
    // Refilling a different lane cannot steal a session from its now-usable account.
    assert_eq!(
        state
            .select("kimi", Some("kimi-k2.5"), 1004, &candidates, &[], session)
            .unwrap()
            .auth_id,
        "b"
    );
}
#[test]
#[cfg(unix)]
fn failed_durable_balance_write_is_not_a_successful_refresh() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let state = open(root.path());
    assert_eq!(observe_balance(&state, "a", GLOBAL, POSITIVE, 1000), 200);
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let status = observe_balance(
        &state,
        "a",
        GLOBAL,
        br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":0}}"#,
        1001,
    );
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(status, 0);
    assert_eq!(
        state.balance("kimi", "a").unwrap().available_balance,
        49.58894
    );
}
