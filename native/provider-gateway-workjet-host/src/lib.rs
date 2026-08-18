pub mod config;
pub mod oauth;
pub mod runtime;
pub mod secret_store;

use std::fmt;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use workjet_provider_gateway::internal::api::handlers::management::{
    ManagementAuthenticator, SystemManagementAuthClock,
};
use workjet_provider_gateway::internal::api::server::serve_provider_connection;
use workjet_provider_gateway::internal::api::server_management::{
    serve_management_connection, ManagementHandler,
};
use workjet_provider_gateway::internal::auth::antigravity::AntigravityOAuthClientCredentials;
use workjet_provider_gateway::internal::config::RuntimeSecretRef;

use config::ValidatedHostConfig;
use oauth::HostOAuthSource;
use runtime::{build_provider_routes, HostManagementSource};
use secret_store::WorkjetSecretStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostError {
    Secret,
    Bind,
    Runtime,
    Management,
    Task,
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider gateway host failed")
    }
}

impl std::error::Error for HostError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessRecord {
    pub schema: &'static str,
    pub pid: u32,
    pub provider_endpoint: String,
    pub management_endpoint: String,
    pub phase: &'static str,
}

pub struct RunningHost {
    readiness: ReadinessRecord,
    provider_address: SocketAddr,
    management_address: SocketAddr,
    tasks: Vec<JoinHandle<Result<(), HostError>>>,
}

impl RunningHost {
    pub fn readiness(&self) -> &ReadinessRecord {
        &self.readiness
    }

    pub fn provider_address(&self) -> SocketAddr {
        self.provider_address
    }

    pub fn management_address(&self) -> SocketAddr {
        self.management_address
    }

    pub async fn shutdown(&mut self) -> Result<(), HostError> {
        for task in &self.tasks {
            task.abort();
        }
        while let Some(task) = self.tasks.pop() {
            match task.await {
                Ok(Ok(())) | Err(_) => {}
                Ok(Err(error)) => return Err(error),
            }
        }
        Ok(())
    }

    pub async fn run_until<F>(mut self, cancellation: F) -> Result<(), HostError>
    where
        F: Future<Output = ()>,
    {
        tokio::pin!(cancellation);
        let listener_result = {
            let (provider, remaining) = self.tasks.split_first_mut().ok_or(HostError::Task)?;
            let management = remaining.first_mut().ok_or(HostError::Task)?;
            tokio::select! {
                () = &mut cancellation => None,
                result = provider => Some(result),
                result = management => Some(result),
            }
        };
        self.shutdown().await?;
        match listener_result {
            None => Ok(()),
            Some(Ok(Ok(()))) => Err(HostError::Task),
            Some(Ok(Err(error))) => Err(error),
            Some(Err(_)) => Err(HostError::Task),
        }
    }
}

impl Drop for RunningHost {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

pub async fn start(config: ValidatedHostConfig) -> Result<RunningHost, HostError> {
    let store = Arc::new(
        WorkjetSecretStore::new(config.secret_root.clone()).map_err(|_| HostError::Secret)?,
    );
    validate_provider_secrets(&store, &config)?;
    let antigravity_client = antigravity_oauth_client(&store, &config)?;
    let management_key = store
        .management_key(&config.management_secret)
        .map_err(|_| HostError::Secret)?;
    let provider_listener = TcpListener::bind(config.provider_address)
        .await
        .map_err(|_| HostError::Bind)?;
    let management_listener = TcpListener::bind(config.management_address)
        .await
        .map_err(|_| HostError::Bind)?;
    let provider_address = provider_listener
        .local_addr()
        .map_err(|_| HostError::Bind)?;
    let management_address = management_listener
        .local_addr()
        .map_err(|_| HostError::Bind)?;
    if !provider_address.ip().is_loopback() || !management_address.ip().is_loopback() {
        return Err(HostError::Bind);
    }
    let routes = Arc::new(
        build_provider_routes(
            &config.runtime,
            &config.default_provider,
            store,
            config.antigravity_oauth,
        )
        .map_err(|_| HostError::Runtime)?,
    );
    let provider_endpoint = format!("http://{provider_address}");
    let management_endpoint = format!("http://{management_address}");
    let management_source = Arc::new(HostManagementSource::new(
        provider_endpoint.clone(),
        management_endpoint.clone(),
        config.default_provider,
        &config.runtime,
    ));
    let authenticator = Arc::new(
        ManagementAuthenticator::new(
            management_key.as_str(),
            false,
            Arc::new(SystemManagementAuthClock),
        )
        .map_err(|_| HostError::Management)?,
    );
    drop(management_key);
    let management_handler = Arc::new(
        ManagementHandler::with_runtime_sources(
            authenticator,
            management_source.clone(),
            management_source,
        )
        .attach_oauth_source(Arc::new(HostOAuthSource::new(
            management_endpoint.clone(),
            antigravity_client,
        ))),
    );

    let provider_task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = provider_listener.accept() => {
                    let (mut stream, peer) = accepted.map_err(|_| HostError::Task)?;
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let routes = routes.clone();
                    connections.spawn(async move {
                        serve_provider_connection(
                            &mut stream,
                            routes.responses.as_ref(),
                            routes.messages.as_deref(),
                            &routes.models,
                            routes.auxiliary.as_deref(),
                        )
                        .await
                        .map_err(|_| HostError::Task)
                    });
                }
                completed = connections.join_next(), if !connections.is_empty() => {
                    // A malformed request, disconnected client, or panicking
                    // connection task must not take down listener authority.
                    let _ = completed;
                }
            }
        }
    });
    let management_task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = management_listener.accept() => {
                    let (mut stream, peer) = accepted.map_err(|_| HostError::Task)?;
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let handler = management_handler.clone();
                    connections.spawn(async move {
                        serve_management_connection(&mut stream, handler.as_ref(), peer.ip())
                            .await
                            .map_err(|_| HostError::Task)
                    });
                }
                completed = connections.join_next(), if !connections.is_empty() => {
                    // A malformed request, disconnected client, or panicking
                    // connection task must not take down listener authority.
                    let _ = completed;
                }
            }
        }
    });

    Ok(RunningHost {
        readiness: ReadinessRecord {
            schema: "workjet.provider-gateway-host.readiness.v1",
            pid: std::process::id(),
            provider_endpoint,
            management_endpoint,
            phase: "ready",
        },
        provider_address,
        management_address,
        tasks: vec![provider_task, management_task],
    })
}

fn antigravity_oauth_client(
    store: &WorkjetSecretStore,
    config: &ValidatedHostConfig,
) -> Result<Option<Arc<AntigravityOAuthClientCredentials>>, HostError> {
    let Some((client_id, client_secret)) = config.antigravity_oauth.as_ref() else {
        return Ok(None);
    };
    let client_id = store
        .resolve_text(client_id)
        .map_err(|_| HostError::Secret)?;
    let client_secret = store
        .resolve_text(client_secret)
        .map_err(|_| HostError::Secret)?;
    let credentials =
        AntigravityOAuthClientCredentials::new(client_id.to_string(), client_secret.to_string())
            .map_err(|_| HostError::Secret)?;
    Ok(Some(Arc::new(credentials)))
}

fn validate_provider_secrets(
    store: &WorkjetSecretStore,
    config: &ValidatedHostConfig,
) -> Result<(), HostError> {
    let mut references: Vec<&RuntimeSecretRef> = Vec::new();
    for account in config.runtime.claude_accounts() {
        references.extend([&account.access_token_secret, &account.refresh_token_secret]);
        references.extend(account.proxy_url_secret.iter());
    }
    for account in config.runtime.codex_accounts() {
        references.extend([
            &account.id_token_secret,
            &account.access_token_secret,
            &account.refresh_token_secret,
        ]);
        references.extend(account.proxy_url_secret.iter());
    }
    for account in config.runtime.antigravity_accounts() {
        references.extend([
            &account.access_token_secret,
            &account.refresh_token_secret,
            &account.state_secret,
        ]);
        references.extend(account.proxy_url_secret.iter());
    }
    if let Some((client_id, client_secret)) = &config.antigravity_oauth {
        references.extend([client_id, client_secret]);
    }
    for reference in references {
        store
            .resolve_text(reference)
            .map_err(|_| HostError::Secret)?;
    }
    Ok(())
}
