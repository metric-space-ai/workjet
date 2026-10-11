#[test]
fn no_subscription_bucket_is_distinct_from_tools_unlimited_and_inference_failure() {
    let windows = parse_usage("minimax", br#"{"model_remains":[
        {"model_name":"MiniMax-M3","current_interval_total_count":0,"current_weekly_total_count":0,
         "current_interval_status":3,"current_weekly_status":3,"current_interval_remaining_percent":100}
    ]}"#,1000).unwrap();
    assert!(windows
        .iter()
        .all(|w| w.not_in_plan && !w.tool_only && !w.unlimited));
    assert!(windows.iter().all(|w| w.remaining_percent.is_none()));
    assert!(!quota_is_exhausted(&windows[0], 1001));
    assert!(!quota_applies(&windows[0], "MiniMax-M3"));
}
use workjet_provider_gateway_host::account_health::{api_quota_endpoint, parse_usage};
use workjet_provider_gateway_host::account_policy::{quota_applies, quota_is_exhausted};

#[test]
fn destination_allowlist_never_sends_vendor_keys_to_unrelated_quota_hosts() {
    assert!(api_quota_endpoint("minimax", "https://custom.example/v1").is_none());
    assert!(api_quota_endpoint("zai", "https://api.z.ai.attacker.test/api/paas/v4").is_none());
    assert!(api_quota_endpoint("zai", "https://api.z.ai:444/api/paas/v4").is_none());
    assert!(api_quota_endpoint("zai", "https://api.z.ai/custom").is_none());
    assert_eq!(
        api_quota_endpoint("minimax", "https://api.minimax.cn/v1"),
        Some("https://api.minimax.cn/v1/token_plan/remains")
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
    assert_eq!(windows[0].resets_at_ms, Some(5000));
    assert!(quota_applies(&windows[0], "glm-5"));
    assert!(!quota_applies(&windows[1], "glm-5"));
    assert!(!quota_applies(&windows[2], "glm-5"));
    assert_eq!(windows[3].remaining_percent, None);
    assert!(parse_usage("zai", br#"{"code":401,"success":false}"#, 1000).is_none());
}

#[test]
fn zai_preserves_observed_epoch_millisecond_reset_without_rescaling() {
    // Published dashboard capture: gateway-api-quotas.md#zai-reset-unit-evidence.
    let windows = parse_usage(
        "zai",
        br#"{"code":200,"success":true,"data":{"limits":[
          {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":100,
           "nextResetTime":1784643970777}
        ]}}"#,
        1784643970000,
    )
    .unwrap();
    assert_eq!(windows[0].resets_at_ms, Some(1_784_643_970_777));
    assert!(quota_is_exhausted(&windows[0], 1_784_643_970_776));
    assert!(!quota_is_exhausted(&windows[0], 1_784_643_970_777));
}

#[test]
fn quota_source_preserves_raw_percent_and_duration_without_changing_legacy_rest() {
    for (provider, body, field, value, remaining, seconds) in [
        (
            "claude",
            r#"{"five_hour":{"utilization":20}}"#,
            "utilization",
            20.0,
            80.0,
            18000,
        ),
        (
            "codex",
            r#"{"rate_limit":{"secondary_window":{"used_percent":57,"limit_window_seconds":604800,"reset_at":2000}}}"#,
            "used_percent",
            57.0,
            43.0,
            604800,
        ),
        (
            "minimax",
            r#"{"model_remains":[{"model_name":"general","start_time":1000,"end_time":18001000,"current_interval_remaining_percent":80,"current_interval_status":1}]}"#,
            "current_interval_remaining_percent",
            80.0,
            80.0,
            18000,
        ),
    ] {
        let quota = parse_usage(provider, body.as_bytes(), 1000).unwrap();
        let source = quota[0].source.as_ref().unwrap();
        assert_eq!(source.field, field);
        assert_eq!(source.value, Some(value));
        assert_eq!(source.window_seconds, Some(seconds));
        assert_eq!(quota[0].remaining_percent, Some(remaining));
        let wire = serde_json::to_value(&quota[0]).unwrap();
        assert_eq!(wire["source"]["field"], field);
        assert_eq!(wire["source"]["windowSeconds"], seconds);
    }
}

#[test]
fn zai_keeps_raw_window_units_and_reset_independent_of_array_order() {
    let quota = parse_usage(
        "zai",
        br#"{"data":{"limits":[
        {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":42,"nextResetTime":604801000},
        {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":5,"nextResetTime":18001000},
        {"type":"TOKENS_LIMIT","unit":5,"number":1,"percentage":20},
        {"type":"TOKENS_LIMIT","unit":99,"number":2,"percentage":10}
    ]}}"#,
        1000,
    )
    .unwrap();
    assert_eq!(quota[0].remaining_percent, Some(58.0));
    assert_eq!(quota[1].remaining_percent, Some(95.0));
    assert_eq!(quota[0].resets_at_ms, Some(604801000));
    for (i, unit) in [6, 3, 5, 99].into_iter().enumerate() {
        let source = quota[i].source.as_ref().unwrap();
        assert_eq!(source.field, "percentage");
        assert_eq!(source.unit, Some(unit));
        assert_eq!(source.window_seconds, None); // UI owns qualification and labels.
    }
}

#[test]
fn minimax_exhausted_status_and_ambiguous_count_are_not_lost_in_transport() {
    let quota = parse_usage("minimax", br#"{"model_remains":[
        {"model_name":"general","current_interval_total_count":100,"current_interval_usage_count":100,
         "current_interval_remaining_percent":100,"current_interval_status":2},
        {"model_name":"MiniMax-M3","current_interval_total_count":100,"current_interval_usage_count":100}
    ]}"#, 1000).unwrap();
    assert_eq!(quota[0].source.as_ref().unwrap().status, Some(2));
    assert_eq!(quota[0].source.as_ref().unwrap().value, Some(100.0));
    assert_eq!(quota[2].source.as_ref().unwrap().value, None);
    let wire = serde_json::to_string(&quota).unwrap();
    assert!(!wire.contains("usage_count")); // No guessed interpretation or full upstream body.
}

#[test]
fn older_quota_cache_without_source_still_decodes() {
    let window: workjet_provider_gateway_host::account_policy::QuotaWindow = serde_json::from_str(
        r#"{"name":"primary_window","remainingPercent":43,"resetsAtMs":2000,"observedAtMs":1000}"#,
    )
    .unwrap();
    assert!(window.source.is_none());
    assert_eq!(window.remaining_percent, Some(43.0));
}

#[test]
fn no_quota_percentage_is_fabricated_for_xai_or_kimi() {
    for provider in ["xai", "kimi"] {
        assert!(parse_usage(provider, br#"{"data":{"available_balance":20}}"#, 1000).is_none());
    }
}
