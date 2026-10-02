use workjet_provider_gateway_host::account_health::{api_quota_endpoint, parse_usage};
use workjet_provider_gateway_host::account_policy::{quota_applies, quota_is_exhausted};

#[test]
fn destination_allowlist_never_sends_vendor_keys_to_unrelated_quota_hosts() {
    assert!(api_quota_endpoint("minimax", "https://custom.example/v1").is_none());
    assert!(api_quota_endpoint("zai", "https://api.z.ai.attacker.test/api/paas/v4").is_none());
    assert!(api_quota_endpoint("zai", "https://api.z.ai:444/api/paas/v4").is_none());
    assert!(api_quota_endpoint("zai", "https://api.z.ai/custom").is_none());
    assert_eq!(
        api_quota_endpoint("minimax", "https://api.minimaxi.com/v1"),
        Some("https://api.minimaxi.com/v1/token_plan/remains")
    );
    assert_eq!(
        api_quota_endpoint("zai", "https://open.bigmodel.cn/api/coding/paas/v4"),
        Some("https://open.bigmodel.cn/api/monitor/usage/quota/limit")
    );
}

#[test]
fn minimax_direct_readings_preserve_boost_unlimited_scope_and_unknown() {
    let windows = parse_usage("minimax", br#"{"base_resp":{"status_code":0},"model_remains":[
      {"model_name":"general","current_interval_remaining_percent":80,"end_time":5000,
       "current_weekly_remaining_percent":90,"weekly_boost_permille":1500,"weekly_end_time":10000},
      {"model_name":"MiniMax-M3","current_interval_remaining_percent":0,"end_time":5000,
       "current_weekly_status":3,"current_weekly_remaining_percent":0},
      {"model_name":"video","current_interval_remaining_percent":0,"end_time":5000},
      {"model_name":"speech-hd","current_interval_total_count":100,"current_interval_usage_count":20},
      {"model_name":"image","current_interval_remaining_percent":"bad","end_time":"bad"}
    ]}"#, 1000).unwrap();
    assert_eq!(windows[0].remaining_percent, Some(80.0));
    assert_eq!(windows[0].resets_at_ms, Some(5000));
    assert_eq!(windows[1].remaining_percent, Some(135.0));
    assert_eq!(windows[1].boost_permille, Some(1500));
    assert!(quota_applies(&windows[2], "MiniMax-M3"));
    assert!(!quota_applies(&windows[2], "MiniMax-M2.7"));
    assert!(quota_is_exhausted(&windows[2], 4000));
    assert!(!quota_is_exhausted(&windows[2], 5000));
    assert!(windows[3].unlimited);
    assert!(!quota_is_exhausted(&windows[3], 1001));
    assert!(windows[4].tool_only);
    assert!(!quota_applies(&windows[4], "MiniMax-M3"));
    assert_eq!(windows[6].remaining_percent, None);
    assert_eq!(windows[8].remaining_percent, None);
    assert_eq!(windows[8].resets_at_ms, None);
    assert!(parse_usage("minimax", br#"{"base_resp":{"status_code":1004}}"#, 1000).is_none());
    assert!(parse_usage("minimax", br#"{}"#, 1000).is_none());
}

#[test]
fn zai_llm_and_tool_scopes_do_not_share_exhaustion_or_invent_resets() {
    let windows = parse_usage(
        "zai",
        br#"{"code":200,"success":true,"data":{"limits":[
      {"type":"TOKENS_LIMIT","percentage":100,"nextResetTime":5000},
      {"type":"TIME_LIMIT","percentage":100,"currentValue":10,"usage":10},
      {"type":"CREDIT_LIMIT","percentage":100},
      {"type":"TOKENS_LIMIT","percentage":"bad"}
    ]}}"#,
        1000,
    )
    .unwrap();
    assert_eq!(windows[0].remaining_percent, Some(0.0));
    assert_eq!(windows[0].resets_at_ms, None);
    assert!(quota_applies(&windows[0], "glm-5"));
    assert!(!quota_applies(&windows[1], "glm-5"));
    assert!(!quota_applies(&windows[2], "glm-5"));
    assert_eq!(windows[3].remaining_percent, None);
    assert!(parse_usage("zai", br#"{"code":401,"success":false}"#, 1000).is_none());
}
