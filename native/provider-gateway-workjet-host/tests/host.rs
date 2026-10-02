use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt as _;
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use workjet_provider_gateway::internal::config::{
    CliproxyRuntimeConfig, CodexSubscriptionAccountConfig, RuntimeSecretRef,
};
use workjet_provider_gateway::sdk::cliproxy::auth::SchedulerStrategy;
use workjet_provider_gateway_host::config::{HostConfig, ALLOWED_SECRET_SCOPE, HOST_CONFIG_SCHEMA};

const SECRET: &str = "provider-secret-must-never-escape";

fn secret(name: &str) -> RuntimeSecretRef {
    RuntimeSecretRef {
        scope: ALLOWED_SECRET_SCOPE.to_owned(),
        name: name.to_owned(),
    }
}

fn write_secret(root: &std::path::Path, name: &str, value: &[u8]) {
    let path = root.join(format!("{ALLOWED_SECRET_SCOPE}.{name}.bin"));
    fs::write(&path, value).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn config(root: &std::path::Path) -> HostConfig {
    HostConfig {
        schema: HOST_CONFIG_SCHEMA.to_owned(),
        provider_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        management_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        secret_root: root.to_path_buf(),
        management_secret: secret("management"),
        antigravity_oauth_client_id_secret: None,
        antigravity_oauth_client_secret_secret: None,
        default_provider: Some("codex".to_owned()),
        // Tests must never bind the officially registered codex callback port:
        // it is fixed machine-wide and shared with the official CLI.
        codex_callback_port: Some(0),
        runtime: CliproxyRuntimeConfig {
            request_timeout_ms: 1_000,
            routing_strategy: SchedulerStrategy::RoundRobin,
            claude_accounts: Vec::new(),
            codex_accounts: vec![CodexSubscriptionAccountConfig {
                id: "account-1".to_owned(),
                disabled: false,
                priority: 10,
                weight: 1,
                websockets: false,
                models: vec!["gpt-test".to_owned()],
                id_token_secret: secret("codex.id"),
                access_token_secret: secret("codex.access"),
                refresh_token_secret: secret("codex.refresh"),
                upstream_base_url: "https://chatgpt.com/backend-api/codex".to_owned(),
                plan_type: "pro".to_owned(),
                proxy_url_secret: None,
            }],
            antigravity_accounts: Vec::new(),
            api_key_accounts: Vec::new(),
        },
    }
}

async fn management_get(address: SocketAddr, key: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "GET {path} HTTP/1.1\r\nHost: localhost\r\nX-Management-Key: {key}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8(response).unwrap()
}

#[tokio::test]
async fn starts_on_loopback_port_zero_serves_redacted_control_plane_and_stops_cleanly() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root.path(), "management", &[7_u8; 32]);
    write_secret(root.path(), "codex.id", SECRET.as_bytes());
    write_secret(root.path(), "codex.access", SECRET.as_bytes());
    write_secret(root.path(), "codex.refresh", SECRET.as_bytes());

    let serialized_config = serde_json::to_string(&config(root.path())).unwrap();
    assert!(!serialized_config.contains(SECRET));
    let mut host = workjet_provider_gateway_host::start(config(root.path()).validate().unwrap())
        .await
        .unwrap();
    assert!(host.provider_address().ip().is_loopback());
    assert!(host.management_address().ip().is_loopback());
    assert_ne!(host.provider_address().port(), 0);
    assert_ne!(host.management_address().port(), 0);

    let readiness = serde_json::to_string(host.readiness()).unwrap();
    assert!(!readiness.contains(SECRET));
    assert_eq!(host.readiness().phase, "ready");

    let management_key = "07".repeat(32);
    let status = management_get(
        host.management_address(),
        &management_key,
        "/v0/management/runtime-status",
    )
    .await;
    let catalog = management_get(
        host.management_address(),
        &management_key,
        "/v0/management/runtime-config",
    )
    .await;
    assert!(status.starts_with("HTTP/1.1 200"));
    assert!(status.contains("workjet.provider-gateway.runtime-status.v1"));
    assert!(catalog.starts_with("HTTP/1.1 200"));
    assert!(catalog.contains("gpt-test"));
    assert!(catalog.contains("account_count"));
    assert!(!format!("{status}{catalog}").contains(SECRET));

    let provider_address = host.provider_address();
    let management_address = host.management_address();
    host.shutdown().await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(TcpStream::connect(provider_address).await.is_err());
    assert!(TcpStream::connect(management_address).await.is_err());
}

#[tokio::test]
async fn rejects_missing_provider_secrets_with_a_redacted_error() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root.path(), "management", &[9_u8; 32]);
    let error = workjet_provider_gateway_host::start(config(root.path()).validate().unwrap())
        .await
        .err()
        .unwrap();
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains(SECRET));
    assert!(!rendered.contains("codex.access"));
}

async fn management_request(
    address: SocketAddr,
    method: &str,
    path: &str,
    key: Option<&str>,
) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let authorization = key
        .map(|key| format!("X-Management-Key: {key}\r\n"))
        .unwrap_or_default();
    let length = if method == "POST" || method == "PUT" || method == "PATCH" {
        "Content-Length: 0\r\n"
    } else {
        ""
    };
    stream
        .write_all(
            format!(
                "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}{length}Connection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8(response).unwrap()
}

fn body_of(response: &str) -> &str {
    response.split("\r\n\r\n").nth(1).unwrap_or_default()
}

fn oauth_config(root: &std::path::Path) -> HostConfig {
    let mut config = config(root);
    config.antigravity_oauth_client_id_secret = Some(secret("antigravity.client-id"));
    config.antigravity_oauth_client_secret_secret = Some(secret("antigravity.client-secret"));
    config
}

async fn start_oauth_host(root: &std::path::Path) -> workjet_provider_gateway_host::RunningHost {
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root, "management", &[7_u8; 32]);
    write_secret(root, "codex.id", SECRET.as_bytes());
    write_secret(root, "codex.access", SECRET.as_bytes());
    write_secret(root, "codex.refresh", SECRET.as_bytes());
    write_secret(root, "antigravity.client-id", b"antigravity-client-id");
    write_secret(
        root,
        "antigravity.client-secret",
        b"antigravity-client-secret",
    );
    workjet_provider_gateway_host::start(oauth_config(root).validate().unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn begins_a_loopback_oauth_session_for_every_supported_provider() {
    let root = tempfile::tempdir().unwrap();
    let mut host = start_oauth_host(root.path()).await;
    let key = "07".repeat(32);
    let management_address = host.management_address();

    for (path, provider, authorize_host) in [
        (
            "/v0/management/anthropic-auth-url?state=state-anthropic",
            "anthropic",
            "https://claude.ai/oauth/authorize",
        ),
        (
            "/v0/management/codex-auth-url?state=state-codex",
            "codex",
            "https://auth.openai.com/oauth/authorize",
        ),
        (
            "/v0/management/antigravity-auth-url?state=state-antigravity",
            "antigravity",
            "https://accounts.google.com",
        ),
    ] {
        let response = management_request(management_address, "GET", path, Some(&key)).await;
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "{provider}: {response}"
        );
        let payload: serde_json::Value = serde_json::from_str(body_of(&response)).unwrap();
        assert_eq!(payload["provider"], provider);
        assert_eq!(payload["state"], format!("state-{provider}"));
        let authorization_url = payload["authorization_url"].as_str().unwrap();
        assert!(
            authorization_url.starts_with(authorize_host),
            "{provider}: {authorization_url}"
        );
        // The redirect target must be exactly what the provider's OAuth client
        // registers: a loopback listener this host binds for the flow for
        // anthropic and codex, and the management listener for antigravity,
        // whose client is operator-supplied.
        let expected_redirect = match provider {
            "anthropic" => "http://localhost:".to_owned(),
            "codex" => "http://localhost:".to_owned(),
            _ => format!("http://{management_address}/management/oauth/{provider}/callback"),
        };
        assert!(
            authorization_url.contains(&url_encoded(&expected_redirect)),
            "{provider}: {authorization_url}"
        );
        match provider {
            "anthropic" => assert!(
                authorization_url.contains(&url_encoded("/callback"))
                    && !authorization_url.contains("management"),
                "{provider}: {authorization_url}"
            ),
            "codex" => assert!(
                authorization_url.contains(&url_encoded("/auth/callback"))
                    && !authorization_url.contains("management"),
                "{provider}: {authorization_url}"
            ),
            _ => {}
        }
        assert!(authorization_url.contains(&format!("state-{provider}")));
    }

    // A session without a caller-supplied state gets one minted for it.
    let minted = management_request(
        management_address,
        "GET",
        "/v0/management/codex-auth-url",
        Some(&key),
    )
    .await;
    let payload: serde_json::Value = serde_json::from_str(body_of(&minted)).unwrap();
    assert!(payload["state"]
        .as_str()
        .is_some_and(|state| !state.is_empty()));

    host.shutdown().await.unwrap();
}

fn url_encoded(value: &str) -> String {
    value.replace(':', "%3A").replace('/', "%2F")
}

#[tokio::test]
async fn polls_cancels_and_gates_the_oauth_surface_on_the_management_key() {
    let root = tempfile::tempdir().unwrap();
    let mut host = start_oauth_host(root.path()).await;
    let key = "07".repeat(32);
    let address = host.management_address();

    // Management key is required for begin, poll and cancel.
    for (method, path) in [
        ("GET", "/v0/management/codex-auth-url?state=unauthenticated"),
        ("GET", "/v0/management/oauth/status?state=unauthenticated"),
        ("DELETE", "/v0/management/oauth/session/unauthenticated"),
    ] {
        let response = management_request(address, method, path, None).await;
        assert!(
            response.starts_with("HTTP/1.1 401"),
            "{method} {path}: {response}"
        );
    }

    // Polling an unknown session is a clean 404, not a panic or a 500.
    let unknown = management_request(
        address,
        "GET",
        "/v0/management/oauth/status?state=never-started",
        Some(&key),
    )
    .await;
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");
    assert!(body_of(&unknown).contains("oauth session not found"));

    // An invalid state is rejected before any session lookup.
    let invalid = management_request(
        address,
        "GET",
        "/v0/management/oauth/status?state=%2e%2e%2fescape",
        Some(&key),
    )
    .await;
    assert!(invalid.starts_with("HTTP/1.1 400"), "{invalid}");

    // Begin, then poll it as pending, then cancel it.
    let started = management_request(
        address,
        "GET",
        "/v0/management/codex-auth-url?state=cancel-me",
        Some(&key),
    )
    .await;
    assert!(started.starts_with("HTTP/1.1 200"), "{started}");

    let pending = management_request(
        address,
        "GET",
        "/v0/management/oauth/status?state=cancel-me",
        Some(&key),
    )
    .await;
    assert!(pending.starts_with("HTTP/1.1 200"), "{pending}");
    let payload: serde_json::Value = serde_json::from_str(body_of(&pending)).unwrap();
    assert_eq!(payload["pending"], true);
    assert_eq!(payload["credentials"].as_array().unwrap().len(), 0);

    let cancelled = management_request(
        address,
        "DELETE",
        "/v0/management/oauth/session/cancel-me",
        Some(&key),
    )
    .await;
    assert!(cancelled.starts_with("HTTP/1.1 200"), "{cancelled}");

    let after_cancel = management_request(
        address,
        "GET",
        "/v0/management/oauth/status?state=cancel-me",
        Some(&key),
    )
    .await;
    assert!(after_cancel.starts_with("HTTP/1.1 404"), "{after_cancel}");

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn serves_the_canonical_oauth_callback_unauthenticated_on_the_management_listener() {
    let root = tempfile::tempdir().unwrap();
    let mut host = start_oauth_host(root.path()).await;
    let key = "07".repeat(32);
    let address = host.management_address();

    let started = management_request(
        address,
        "GET",
        "/v0/management/anthropic-auth-url?state=callback-state",
        Some(&key),
    )
    .await;
    assert!(started.starts_with("HTTP/1.1 200"), "{started}");

    // A callback without any authorization result is rejected.
    let empty = management_request(
        address,
        "GET",
        "/management/oauth/anthropic/callback?state=callback-state",
        None,
    )
    .await;
    assert!(empty.starts_with("HTTP/1.1 400"), "{empty}");

    // A callback for an unknown session is a clean 404.
    let unknown = management_request(
        address,
        "GET",
        "/management/oauth/anthropic/callback?state=other-state&error=denied",
        None,
    )
    .await;
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");

    // The real redirect carries no management key and is still accepted.
    let denied = management_request(
        address,
        "GET",
        "/management/oauth/anthropic/callback?state=callback-state&error=access_denied",
        None,
    )
    .await;
    assert!(denied.starts_with("HTTP/1.1 200"), "{denied}");

    let polled = management_request(
        address,
        "GET",
        "/v0/management/oauth/status?state=callback-state",
        Some(&key),
    )
    .await;
    assert!(polled.starts_with("HTTP/1.1 200"), "{polled}");
    let payload: serde_json::Value = serde_json::from_str(body_of(&polled)).unwrap();
    assert_eq!(payload["pending"], false);
    assert_eq!(payload["error"], "access_denied");

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn gates_the_one_time_credential_claim_on_the_key_and_on_session_completion() {
    let root = tempfile::tempdir().unwrap();
    let mut host = start_oauth_host(root.path()).await;
    let key = "07".repeat(32);
    let address = host.management_address();

    // The claim needs the management key.
    let unauthenticated = management_request(
        address,
        "POST",
        "/v0/management/oauth/session/claim-state/claim",
        None,
    )
    .await;
    assert!(
        unauthenticated.starts_with("HTTP/1.1 401"),
        "{unauthenticated}"
    );

    // Claiming a session that was never started is a clean 404.
    let unknown = management_request(
        address,
        "POST",
        "/v0/management/oauth/session/never-started/claim",
        Some(&key),
    )
    .await;
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");

    // A started but uncompleted session has nothing to hand over.
    let started = management_request(
        address,
        "GET",
        "/v0/management/codex-auth-url?state=claim-state",
        Some(&key),
    )
    .await;
    assert!(started.starts_with("HTTP/1.1 200"), "{started}");
    let premature = management_request(
        address,
        "POST",
        "/v0/management/oauth/session/claim-state/claim",
        Some(&key),
    )
    .await;
    assert!(premature.starts_with("HTTP/1.1 409"), "{premature}");
    assert!(body_of(&premature).contains("oauth session is not claimable"));

    // A failed session is finished, not claimable.
    let denied = management_request(
        address,
        "GET",
        "/management/oauth/codex/callback?state=claim-state&error=access_denied",
        None,
    )
    .await;
    assert!(denied.starts_with("HTTP/1.1 200"), "{denied}");
    let polled = management_request(
        address,
        "GET",
        "/v0/management/oauth/status?state=claim-state",
        Some(&key),
    )
    .await;
    let payload: serde_json::Value = serde_json::from_str(body_of(&polled)).unwrap();
    assert_eq!(payload["pending"], false);
    let after_failure = management_request(
        address,
        "POST",
        "/v0/management/oauth/session/claim-state/claim",
        Some(&key),
    )
    .await;
    assert!(after_failure.starts_with("HTTP/1.1 409"), "{after_failure}");

    host.shutdown().await.unwrap();
}

fn bootstrap_config(root: &std::path::Path) -> HostConfig {
    let mut config = config(root);
    config.default_provider = None;
    config.runtime.codex_accounts = Vec::new();
    config
}

#[tokio::test]
async fn boots_a_bootstrap_host_without_any_configured_account() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root.path(), "management", &[7_u8; 32]);

    // The minimal bootstrap document carries no accounts and no default
    // provider at all; `defaultProvider` is simply absent.
    let serialized = serde_json::to_value(bootstrap_config(root.path())).unwrap();
    assert!(serialized.get("defaultProvider").is_none(), "{serialized}");

    let mut host =
        workjet_provider_gateway_host::start(bootstrap_config(root.path()).validate().unwrap())
            .await
            .unwrap();
    let key = "07".repeat(32);
    let address = host.management_address();

    // Readiness is still emitted.
    assert_eq!(host.readiness().phase, "ready");
    assert!(host.management_address().ip().is_loopback());

    // Runtime status is served and reports honestly that nothing routes yet.
    let status =
        management_request(address, "GET", "/v0/management/runtime-status", Some(&key)).await;
    assert!(status.starts_with("HTTP/1.1 200"), "{status}");
    let payload: serde_json::Value = serde_json::from_str(body_of(&status)).unwrap();
    assert_eq!(payload["management_gateway"]["phase"], "ready");
    assert_eq!(
        payload["main_responses_gateway"]["phase"],
        "waiting_for_subscription"
    );
    assert!(payload.get("active_provider").is_none(), "{payload}");

    // The runtime summary is served with no providers and no default provider.
    let summary =
        management_request(address, "GET", "/v0/management/runtime-config", Some(&key)).await;
    assert!(summary.starts_with("HTTP/1.1 200"), "{summary}");
    let payload: serde_json::Value = serde_json::from_str(body_of(&summary)).unwrap();
    assert_eq!(
        payload["schema"],
        "workjet.provider-gateway.runtime-summary.v1"
    );
    assert_eq!(payload["providers"].as_array().unwrap().len(), 0);
    assert!(payload.get("default_provider").is_none(), "{payload}");

    // The whole OAuth surface works, which is the point of booting empty.
    let started = management_request(
        address,
        "GET",
        "/v0/management/codex-auth-url?state=bootstrap-state",
        Some(&key),
    )
    .await;
    assert!(started.starts_with("HTTP/1.1 200"), "{started}");
    let payload: serde_json::Value = serde_json::from_str(body_of(&started)).unwrap();
    assert_eq!(payload["provider"], "codex");
    assert!(payload["authorization_url"]
        .as_str()
        .unwrap()
        .contains("state=bootstrap-state"));

    let claim = management_request(
        address,
        "POST",
        "/v0/management/oauth/session/bootstrap-state/claim",
        Some(&key),
    )
    .await;
    assert!(claim.starts_with("HTTP/1.1 409"), "{claim}");

    // The provider endpoint refuses cleanly instead of routing.
    let refused = management_request(host.provider_address(), "GET", "/v1/models", None).await;
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    assert!(body_of(&refused).contains("no provider account is configured"));

    host.shutdown().await.unwrap();
}

#[test]
fn rejects_a_named_default_provider_that_has_no_enabled_account() {
    let root = tempfile::tempdir().unwrap();
    let mut config = bootstrap_config(root.path());
    config.default_provider = Some("codex".to_owned());
    assert_eq!(
        config.validate().err().unwrap(),
        workjet_provider_gateway_host::config::HostConfigError::InvalidDefaultProvider
    );
}

// --- API-key provider accounts ---------------------------------------------
//
// An API-key account is an account whose only credential is a user-pasted key
// held in the host secret store. These tests pin the three properties that
// matter at host level: the configuration decodes and validates, the key never
// leaves the secret store through any serialized surface, and the host boots
// and routes with an API-key provider as the default provider.

const API_KEY_VALUE: &str = "test-not-a-real-api-key-0000";

/// A provider-endpoint POST with a real JSON body. Provider selection is the
/// `X-CTOX-Provider` header, not the model name. The request deliberately
/// carries a client `Authorization` header: the gateway must never forward it.
async fn provider_post(address: SocketAddr, provider: &str, body: &[u8]) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let head = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nX-CTOX-Provider: {provider}\r\nAuthorization: Bearer client-token-not-real\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}

fn api_key_account(
    id: &str,
    provider: &str,
) -> workjet_provider_gateway::internal::config::ApiKeyAccountConfig {
    workjet_provider_gateway::internal::config::ApiKeyAccountConfig {
        id: id.to_owned(),
        provider: provider.to_owned(),
        disabled: false,
        priority: 5,
        weight: 1,
        models: vec![format!("{provider}-test-model")],
        api_key_secret: secret(&format!("{id}.api-key")),
        upstream_base_url: String::new(),
        proxy_url_secret: None,
    }
}

fn api_key_config(root: &std::path::Path, provider: &str) -> HostConfig {
    let mut config = config(root);
    config.default_provider = Some(provider.to_owned());
    config.runtime.codex_accounts = Vec::new();
    config.runtime.api_key_accounts = vec![api_key_account(&format!("{provider}-1"), provider)];
    config
}

#[test]
fn every_api_key_provider_is_an_acceptable_default_provider() {
    let root = tempfile::tempdir().unwrap();
    for provider in workjet_provider_gateway::internal::config::API_KEY_PROVIDERS {
        assert!(
            api_key_config(root.path(), provider).validate().is_ok(),
            "{provider} must validate as a default provider"
        );
    }
    // A provider outside the allow-list is still refused.
    let mut unsupported = api_key_config(root.path(), "zai");
    unsupported.default_provider = Some("openrouter".to_owned());
    assert_eq!(
        unsupported.validate().err().unwrap(),
        workjet_provider_gateway_host::config::HostConfigError::InvalidDefaultProvider
    );
    // Naming an API-key provider that has no enabled account still fails.
    // A configuration whose only account is disabled fails in the portable
    // runtime validation (`NoEnabledAccounts`), exactly as for an OAuth
    // provider, so the host reports it as an invalid runtime.
    let mut disabled = api_key_config(root.path(), "xai");
    disabled.runtime.api_key_accounts[0].disabled = true;
    assert_eq!(
        disabled.validate().err().unwrap(),
        workjet_provider_gateway_host::config::HostConfigError::InvalidRuntime
    );
}

#[test]
fn an_api_key_account_only_ever_carries_a_secret_reference_in_its_configuration() {
    let root = tempfile::tempdir().unwrap();
    let serialized = serde_json::to_string(&api_key_config(root.path(), "zai")).unwrap();
    assert!(serialized.contains("zai-1.api-key"));
    assert!(!serialized.contains(API_KEY_VALUE));
    assert!(!serialized.to_ascii_lowercase().contains("bearer"));
}

#[test]
fn an_api_key_secret_reference_outside_the_gateway_scope_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let mut config = api_key_config(root.path(), "kimi");
    config.runtime.api_key_accounts[0].api_key_secret =
        workjet_provider_gateway::internal::config::RuntimeSecretRef {
            scope: "some-other-scope".to_owned(),
            name: "kimi.api-key".to_owned(),
        };
    assert_eq!(
        config.validate().err().unwrap(),
        workjet_provider_gateway_host::config::HostConfigError::InvalidSecretReference
    );
}

#[tokio::test]
async fn a_missing_api_key_secret_fails_startup_before_anything_binds() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root.path(), "management", &[7_u8; 32]);
    // The api-key secret is deliberately not written.
    let error = workjet_provider_gateway_host::start(
        api_key_config(root.path(), "minimax").validate().unwrap(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error, workjet_provider_gateway_host::HostError::Secret);
}

#[tokio::test]
async fn boots_with_an_api_key_provider_as_default_and_never_serves_the_key() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root.path(), "management", &[7_u8; 32]);
    write_secret(root.path(), "zai-1.api-key", API_KEY_VALUE.as_bytes());

    let mut host = workjet_provider_gateway_host::start(
        api_key_config(root.path(), "zai").validate().unwrap(),
    )
    .await
    .unwrap();
    let key = "07".repeat(32);
    let address = host.management_address();
    assert_eq!(host.readiness().phase, "ready");

    let status =
        management_request(address, "GET", "/v0/management/runtime-status", Some(&key)).await;
    let payload: serde_json::Value = serde_json::from_str(body_of(&status)).unwrap();
    assert_eq!(payload["main_responses_gateway"]["phase"], "ready");
    assert_eq!(payload["active_provider"], "zai");

    // The runtime summary lists the API-key provider exactly like an OAuth one.
    let summary =
        management_request(address, "GET", "/v0/management/runtime-config", Some(&key)).await;
    let payload: serde_json::Value = serde_json::from_str(body_of(&summary)).unwrap();
    let providers = payload["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0]["provider"], "zai");
    assert_eq!(providers[0]["account_count"], 1);
    assert_eq!(providers[0]["enabled_account_count"], 1);
    assert_eq!(providers[0]["models"][0], "zai-test-model");

    // No management surface renders the key.
    assert!(!format!("{status}{summary}").contains(API_KEY_VALUE));

    // The provider endpoint is routing (it no longer refuses as a bootstrap
    // host), and the model catalog carries the api-key provider's model.
    let models = management_request(host.provider_address(), "GET", "/v1/models", None).await;
    assert!(models.starts_with("HTTP/1.1 200"), "{models}");
    assert!(models.contains("zai-test-model"), "{models}");
    assert!(!models.contains(API_KEY_VALUE));

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn routes_only_the_configured_api_key_providers() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    write_secret(root.path(), "management", &[7_u8; 32]);
    write_secret(root.path(), "xai-1.api-key", API_KEY_VALUE.as_bytes());

    let mut host = workjet_provider_gateway_host::start(
        api_key_config(root.path(), "xai").validate().unwrap(),
    )
    .await
    .unwrap();
    // A provider with no account configured is refused by the allow-list
    // router rather than falling through to another provider's credential.
    let refused = provider_post(
        host.provider_address(),
        "minimax",
        br#"{"model":"minimax-test-model","input":"hi"}"#,
    )
    .await;
    assert!(refused.starts_with("HTTP/1.1 400"), "{refused}");
    assert!(body_of(&refused).contains("requested provider is not configured"));
    assert!(!refused.contains(API_KEY_VALUE));

    host.shutdown().await.unwrap();
}
