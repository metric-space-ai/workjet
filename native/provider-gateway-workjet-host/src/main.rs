use std::io::Write as _;
use std::path::PathBuf;

use workjet_provider_gateway_host::config::HostConfig;

const MAX_CONFIG_BYTES: u64 = 256 * 1024;

#[tokio::main]
async fn main() {
    if run().await.is_err() {
        let _ = writeln!(std::io::stderr(), "provider gateway host failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), ()> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--config")) {
        return Err(());
    }
    let config_path = PathBuf::from(arguments.next().ok_or(())?);
    if arguments.next().is_some() {
        return Err(());
    }
    let metadata = tokio::fs::symlink_metadata(&config_path)
        .await
        .map_err(|_| ())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_CONFIG_BYTES
        || config_permissions_are_unsafe(&metadata)
    {
        return Err(());
    }
    let bytes = tokio::fs::read(config_path).await.map_err(|_| ())?;
    let config: HostConfig = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let host = workjet_provider_gateway_host::start(config.validate().map_err(|_| ())?)
        .await
        .map_err(|_| ())?;
    let readiness = serde_json::to_vec(host.readiness()).map_err(|_| ())?;
    if readiness.len() > 4 * 1024 {
        return Err(());
    }
    std::io::stdout().write_all(&readiness).map_err(|_| ())?;
    std::io::stdout().write_all(b"\n").map_err(|_| ())?;
    std::io::stdout().flush().map_err(|_| ())?;
    host.run_until(shutdown_signal()).await.map_err(|_| ())
}

#[cfg(unix)]
fn config_permissions_are_unsafe(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    metadata.mode() & 0o077 != 0
}

#[cfg(not(unix))]
fn config_permissions_are_unsafe(_metadata: &std::fs::Metadata) -> bool {
    false
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
