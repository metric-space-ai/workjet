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
        default_provider: "codex".to_owned(),
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
