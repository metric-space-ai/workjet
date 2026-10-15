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

// Shape of MoonshotAI/kimi-code packages/oauth/src/managed-usage.ts
// (`parseQuotaUsages`): snake_case entries with `used_ratio` and `reset_time`.
const KIMI_CODE_USAGES: &[u8] = br#"{
  "usages":{
    "limit_5h":{"used_ratio":0.25,"reset_time":"2026-10-15T20:00:00Z"},
    "limit_7d":{"used_ratio":"0.5","reset_time":"2026-10-20T00:00:00+00:00"},
    "limit_month_total":{"used_ratio":1,"reset_time":"2026-11-01T00:00:00Z"},
    "limit_month_code":{"used_ratio":0.75,"reset_time":"2026-11-01T00:00:00Z"}
  },
  "boosterWallet":{"balance":{"type":"BOOSTER","amount":5000000000,"amountLeft":2500000000}}
}"#;

#[test]
fn kimi_code_usages_become_one_window_per_vendor_limit() {
    let windows = parse_usage("kimi", KIMI_CODE_USAGES, 1000).unwrap();
    // limit_month_code is a sub-budget of the monthly total, not its own window.
    let names: Vec<_> = windows.iter().map(|w| w.name.as_str()).collect();
    assert_eq!(names, ["limit_5h", "limit_7d", "limit_month_total"]);
    assert_eq!(windows[0].remaining_percent, Some(75.0));
    assert_eq!(windows[1].remaining_percent, Some(50.0));
    assert_eq!(windows[2].remaining_percent, Some(0.0));
    assert_eq!(windows[0].resets_at_ms, Some(1_792_094_400_000));
    assert_eq!(windows[1].resets_at_ms, Some(1_792_454_400_000));
    let seconds: Vec<_> = windows
        .iter()
        .map(|w| w.source.as_ref().unwrap().window_seconds)
        .collect();
    assert_eq!(seconds, [Some(18_000), Some(604_800), None]);
    for window in &windows {
        let source = window.source.as_ref().unwrap();
        assert_eq!(source.field, "used_ratio");
        assert!(!window.tool_only && window.model_pattern.is_none());
    }
    assert_eq!(windows[0].source.as_ref().unwrap().value, Some(0.25));
    // An exhausted monthly pool blocks every Kimi model until its reset.
    assert!(quota_applies(&windows[2], "kimi-k3"));
    assert!(quota_is_exhausted(&windows[2], 1001));
    assert!(!quota_is_exhausted(&windows[2], 1_793_491_200_000));
}

#[test]
fn kimi_code_ratio_outside_unit_interval_or_missing_stays_unknown() {
    let windows = parse_usage(
        "kimi",
        br#"{"usages":{
          "limit_5h":{"used_ratio":1.5},
          "limit_7d":{"used_ratio":"NaN","reset_time":"not-a-time"},
          "limit_month_total":{"reset_time":"2026-11-01T00:00:00Z"}
        }}"#,
        1000,
    )
    .unwrap();
    assert_eq!(windows.len(), 3);
    assert!(windows.iter().all(|w| w.remaining_percent.is_none()));
    assert!(windows
        .iter()
        .all(|w| w.source.as_ref().unwrap().value.is_none()));
    assert_eq!(windows[1].resets_at_ms, None);
    assert!(windows.iter().all(|w| !quota_is_exhausted(w, 1001)));
    assert!(parse_usage("kimi", br#"{"usages":[]}"#, 1000).is_none());
}

#[test]
fn kimi_code_older_usage_and_limits_shape_is_read_only_without_usages() {
    // Shape of MoonshotAI/kimi-cli src/kimi_cli/ui/shell/usage.py.
    let legacy = br#"{
      "usage":{"limit":"100","used":"40","remaining":"60","resetTime":"2026-10-20T00:00:00Z"},
      "limits":[
        {"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
         "detail":{"limit":"200","remaining":"50","resetTime":"2026-10-15T20:00:00Z"}},
        {"window":{"duration":7,"timeUnit":"TIME_UNIT_DAY"},"detail":{"limit":10,"used":12}},
        {"window":{"duration":3,"timeUnit":"TIME_UNIT_FORTNIGHT"},"detail":{"limit":0,"used":0}}
      ]
    }"#;
    let windows = parse_usage("kimi", legacy, 1000).unwrap();
    assert_eq!(windows.len(), 4);
    assert_eq!(windows[0].name, "usage");
    assert_eq!(windows[0].remaining_percent, Some(60.0));
    assert_eq!(windows[0].resets_at_ms, Some(1_792_454_400_000));
    assert_eq!(windows[0].source.as_ref().unwrap().window_seconds, None);
    assert_eq!(windows[1].remaining_percent, Some(25.0));
    assert_eq!(
        windows[1].source.as_ref().unwrap().window_seconds,
        Some(18_000)
    );
    // Over-use is clamped exactly like the vendor CLI: nothing left.
    assert_eq!(windows[2].remaining_percent, Some(0.0));
    assert_eq!(
        windows[2].source.as_ref().unwrap().window_seconds,
        Some(604_800)
    );
    // A zero limit or unknown unit is not a percentage or a duration.
    assert_eq!(windows[3].remaining_percent, None);
    assert_eq!(windows[3].source.as_ref().unwrap().window_seconds, None);
    assert!(windows
        .iter()
        .all(|w| w.source.as_ref().unwrap().field == "limit_used_ratio"));

    // When the current shape is present, the older fields are ignored.
    let mixed = br#"{"usages":{"limit_5h":{"used_ratio":0.5}},"usage":{"limit":100,"used":100}}"#;
    let windows = parse_usage("kimi", mixed, 1000).unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].remaining_percent, Some(50.0));
}

#[test]
fn moonshot_balance_response_still_yields_no_usage_percentage() {
    // Exact Moonshot platform balance body (tests/kimi_balance.rs POSITIVE).
    let balance = br#"{"code":0,"status":true,"scode":"0x0","data":{"available_balance":49.58894,"cash_balance":-3,"voucher_balance":49.58894}}"#;
    assert!(parse_usage("kimi", balance, 1000).is_none());
    assert!(parse_usage("xai", balance, 1000).is_none());
}

// Shape of xai-org/grok-build crates/codegen/xai-grok-shell/src/extensions/
// billing.rs @2bdd1d6a (`BillingConfigResponse` from `/billing?format=credits`).
#[test]
fn supergrok_credits_become_exactly_one_weekly_or_monthly_window() {
    let weekly = br#"{"config":{
      "creditUsagePercent":37.5,
      "currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-10-13T00:00:00Z","end":"2026-10-20T00:00:00Z"},
      "onDemandCap":{"val":500},"onDemandUsed":{"val":500},
      "prepaidBalance":{"val":1200},"isUnifiedBillingUser":true
    }}"#;
    let windows = parse_usage("xai", weekly, 1000).unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].name, "weekly");
    assert_eq!(windows[0].remaining_percent, Some(62.5));
    assert_eq!(windows[0].resets_at_ms, Some(1_792_454_400_000));
    let source = windows[0].source.as_ref().unwrap();
    assert_eq!(source.field, "creditUsagePercent");
    assert_eq!(source.value, Some(37.5));
    assert_eq!(source.window_seconds, Some(604_800));
    // Exhausted on-demand spend is not the subscription pool.
    assert!(!quota_is_exhausted(&windows[0], 1001));
    assert!(quota_applies(&windows[0], "grok-4.7"));

    let monthly = br#"{"config":{
      "creditUsagePercent":100,
      "currentPeriod":{"type":"USAGE_PERIOD_TYPE_MONTHLY","start":"2026-10-01T00:00:00Z","end":"2026-11-01T00:00:00Z"}
    }}"#;
    let windows = parse_usage("xai", monthly, 1000).unwrap();
    assert_eq!(windows[0].name, "monthly");
    assert_eq!(windows[0].remaining_percent, Some(0.0));
    assert_eq!(
        windows[0].source.as_ref().unwrap().window_seconds,
        Some(31 * 86_400)
    );
    assert!(quota_is_exhausted(&windows[0], 1001));
}

#[test]
fn supergrok_missing_percent_stays_unknown_and_legacy_period_end_is_the_reset() {
    let legacy = br#"{"config":{
      "monthlyLimit":{"val":2000},"used":{"val":1234},"onDemandCap":{"val":500},
      "billingPeriodStart":"2025-04-01T00:00:00Z","billingPeriodEnd":"2025-05-01T00:00:00Z"
    }}"#;
    let windows = parse_usage("xai", legacy, 1000).unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].remaining_percent, None);
    assert_eq!(windows[0].source.as_ref().unwrap().value, None);
    assert_eq!(windows[0].resets_at_ms, Some(1_746_057_600_000));
    assert!(!quota_is_exhausted(&windows[0], 1001));
    for body in [
        &br#"{"config":{"creditUsagePercent":140}}"#[..],
        &br#"{"config":{"creditUsagePercent":-1}}"#[..],
        &br#"{"config":{"creditUsagePercent":"50"}}"#[..],
    ] {
        assert_eq!(
            parse_usage("xai", body, 1000).unwrap()[0].remaining_percent,
            None
        );
    }
    assert!(parse_usage("xai", br#"{"config":null}"#, 1000).is_none());
    assert!(parse_usage("xai", br#"{"error":"unauthorized"}"#, 1000).is_none());
}

#[test]
fn grok_credits_read_only_targets_the_subscription_chat_proxy() {
    use workjet_provider_gateway::internal::auth::xai::CLI_CHAT_PROXY_BASE_URL;
    use workjet_provider_gateway_host::account_health::{reads_balance, GROK_CREDITS_URL};
    assert_eq!(
        GROK_CREDITS_URL,
        format!("{CLI_CHAT_PROXY_BASE_URL}/billing?format=credits")
    );
    assert!(!reads_balance(GROK_CREDITS_URL));
    // xAI API keys have no quota endpoint: no bars, nothing invented.
    assert!(api_quota_endpoint("xai", "https://api.x.ai/v1").is_none());
}
