use anyhow::Context;
use anyhow::Result;
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_RUNTIME_CONFIG_RELATIVE_PATH: &str = "runtime/ctox-runtime.sqlite3";

/// Call-scoped runtime configuration lookup.
///
/// Implementations must treat missing, blank, and unreadable values as absent.
pub trait RuntimeConfigStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;

    /// Credential lookup for keyed providers (API keys, tokens).
    ///
    /// The default treats credentials like ordinary runtime values so
    /// SQL-free adapters (Workjet, tests) can supply them directly. The CTOX
    /// adapter overrides this to read the encrypted CTOX secret store first.
    /// Implementations must never log or echo the returned value.
    fn credential(&self, name: &str) -> Option<String> {
        self.get(name)
    }
}

/// Product-neutral context for one Web Stack call tree.
#[derive(Clone, Copy)]
pub struct WebStackContext<'a> {
    pub root: &'a Path,
    pub runtime_config: &'a dyn RuntimeConfigStore,
}

impl<'a> WebStackContext<'a> {
    pub fn new(root: &'a Path, runtime_config: &'a dyn RuntimeConfigStore) -> Self {
        Self {
            root,
            runtime_config,
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.runtime_config.get(key)
    }

    /// Resolve a credential through the configured store. See
    /// [`RuntimeConfigStore::credential`].
    pub fn credential(&self, name: &str) -> Option<String> {
        self.runtime_config.credential(name)
    }
}

/// CTOX compatibility adapter for `runtime/ctox-runtime.sqlite3`.
///
/// This is the only Web Stack component that knows the CTOX runtime-config SQL
/// schema. `from_root` uses CTOX's authoritative runtime-config store without
/// consulting the consolidated core database. The adapter owns only the database
/// path and opens it for each lookup.
#[derive(Debug, Clone)]
pub struct CtoxRuntimeConfigStore {
    database_path: PathBuf,
    /// CTOX root for credential lookups in the encrypted secret store. Only
    /// stores built with [`CtoxRuntimeConfigStore::from_root`] consult it.
    secret_root: Option<PathBuf>,
}

impl CtoxRuntimeConfigStore {
    pub fn from_root(root: &Path) -> Self {
        Self {
            database_path: runtime_config_path(root),
            secret_root: Some(root.to_path_buf()),
        }
    }

    pub fn from_database_path(database_path: PathBuf) -> Self {
        Self {
            database_path,
            secret_root: None,
        }
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }
}

impl RuntimeConfigStore for CtoxRuntimeConfigStore {
    fn get(&self, key: &str) -> Option<String> {
        load_runtime_env_map(&self.database_path)
            .ok()
            .and_then(|map| map.get(key).cloned())
            .filter(|value| !value.trim().is_empty())
    }

    /// CTOX credentials live in the encrypted secret store (scope
    /// `credentials`), which only the CTOX binary can decrypt. Resolve them
    /// through `ctox secret get` when this process is the CTOX binary, then
    /// fall back to a plaintext runtime value for legacy installs.
    fn credential(&self, name: &str) -> Option<String> {
        self.secret_root
            .as_deref()
            .and_then(|root| ctox_secret_store_credential(root, name))
            .or_else(|| self.get(name))
    }
}

/// Scope under which CTOX keeps managed provider credentials.
pub const CTOX_CREDENTIAL_SCOPE: &str = "credentials";

const CTOX_SECRET_LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const CTOX_SECRET_CACHE_TTL: Duration = Duration::from_secs(300);
/// Absent credentials are re-checked sooner so a freshly stored key is picked
/// up by a long-running daemon within a minute.
const CTOX_SECRET_MISS_CACHE_TTL: Duration = Duration::from_secs(60);

type CredentialCache = Mutex<BTreeMap<(PathBuf, String), (Instant, Option<String>)>>;

fn credential_cache() -> &'static CredentialCache {
    static CACHE: OnceLock<CredentialCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Only the real CTOX CLI may be re-invoked for `secret get`. Test harnesses
/// and other embedders (e.g. `workjet-web-stack`) must never be relaunched
/// with CTOX arguments.
fn ctox_cli_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    (exe.file_stem().and_then(|stem| stem.to_str()) == Some("ctox")).then_some(exe)
}

fn valid_credential_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn ctox_secret_store_credential(root: &Path, name: &str) -> Option<String> {
    if !valid_credential_name(name) {
        return None;
    }
    let exe = ctox_cli_executable()?;
    let key = (root.to_path_buf(), name.to_string());
    if let Ok(cache) = credential_cache().lock() {
        if let Some((fetched_at, value)) = cache.get(&key) {
            let ttl = if value.is_some() {
                CTOX_SECRET_CACHE_TTL
            } else {
                CTOX_SECRET_MISS_CACHE_TTL
            };
            if fetched_at.elapsed() < ttl {
                return value.clone();
            }
        }
    }
    let value = read_ctox_secret_via_cli(&exe, root, name);
    if let Ok(mut cache) = credential_cache().lock() {
        cache.insert(key, (Instant::now(), value.clone()));
    }
    value
}

fn read_ctox_secret_via_cli(exe: &Path, root: &Path, name: &str) -> Option<String> {
    let mut command = Command::new(exe);
    command.current_dir(root).stdin(Stdio::null()).args([
        "secret",
        "get",
        "--scope",
        CTOX_CREDENTIAL_SCOPE,
        "--name",
        name,
    ]);
    let output =
        crate::browser::command_output_with_timeout(command, CTOX_SECRET_LOOKUP_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ctox_secret_get_output(&output.stdout)
}

/// Parse the `ctox secret get` JSON envelope (`{"ok":true,"value":"..."}`).
fn parse_ctox_secret_get_output(stdout: &[u8]) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    if payload.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    payload
        .get("value")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// SQL-free Workjet/T3 adapter backed by immutable caller-provided values.
#[derive(Debug, Clone, Default)]
pub struct WorkjetRuntimeConfigStore {
    values: BTreeMap<String, String>,
}

impl WorkjetRuntimeConfigStore {
    pub fn new<I, K, V>(values: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self {
            values: values
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        }
    }

    pub fn from_map(values: BTreeMap<String, String>) -> Self {
        Self { values }
    }
}

impl RuntimeConfigStore for WorkjetRuntimeConfigStore {
    fn get(&self, key: &str) -> Option<String> {
        self.values
            .get(key)
            .cloned()
            .filter(|value| !value.trim().is_empty())
    }
}

pub fn runtime_config_path(root: &Path) -> PathBuf {
    root.join(DEFAULT_RUNTIME_CONFIG_RELATIVE_PATH)
}

fn load_runtime_env_map(path: &Path) -> Result<BTreeMap<String, String>> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let conn = Connection::open(path)
        .with_context(|| format!("failed to open runtime config {}", path.display()))?;
    let mut stmt = conn
        .prepare("SELECT env_key, env_value FROM runtime_env_kv ORDER BY env_key")
        .context("failed to prepare runtime config query")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .context("failed to query runtime config rows")?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (key, value) = row.context("failed to decode runtime config row")?;
        out.insert(key, value);
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) fn set_ctox_value_for_test(root: &Path, key: &str, value: &str) {
    let path = runtime_config_path(root);
    std::fs::create_dir_all(path.parent().expect("runtime config parent"))
        .expect("create runtime config parent");
    let conn = Connection::open(path).expect("open runtime config");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS runtime_env_kv (
            env_key TEXT PRIMARY KEY,
            env_value TEXT NOT NULL
        );",
    )
    .expect("create runtime config table");
    conn.execute(
        "INSERT INTO runtime_env_kv(env_key, env_value)
         VALUES (?1, ?2)
         ON CONFLICT(env_key) DO UPDATE SET env_value = excluded.env_value",
        rusqlite::params![key, value],
    )
    .expect("write runtime config");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_conform_for_present_missing_and_blank_values() {
        let root = std::env::temp_dir().join(format!(
            "web-stack-runtime-config-conformance-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        set_ctox_value_for_test(&root, "PRESENT", " value ");
        set_ctox_value_for_test(&root, "BLANK", "  \n\t ");

        let ctox = CtoxRuntimeConfigStore::from_root(&root);
        let workjet =
            WorkjetRuntimeConfigStore::new([("PRESENT", " value "), ("BLANK", "  \n\t ")]);
        for key in ["PRESENT", "MISSING", "BLANK"] {
            assert_eq!(ctox.get(key), workjet.get(key), "key {key}");
        }
        assert_eq!(ctox.get("PRESENT").as_deref(), Some(" value "));
        assert_eq!(ctox.get("MISSING"), None);
        assert_eq!(ctox.get("BLANK"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_and_broken_ctox_databases_are_absent() {
        let root = std::env::temp_dir().join(format!(
            "web-stack-runtime-config-broken-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let store = CtoxRuntimeConfigStore::from_root(&root);
        assert_eq!(store.get("ANY"), None);
        let path = runtime_config_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not sqlite").unwrap();
        assert_eq!(store.get("ANY"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn credentials_default_to_runtime_values_and_never_relaunch_test_harness() {
        let workjet = WorkjetRuntimeConfigStore::new([("BRIGHTDATA_API_KEY", "k-1")]);
        assert_eq!(
            workjet.credential("BRIGHTDATA_API_KEY").as_deref(),
            Some("k-1")
        );
        assert_eq!(workjet.credential("MISSING_KEY"), None);

        // The test binary is not the CTOX CLI, so the secret-store bridge must
        // stay inert and the CTOX adapter falls back to the plaintext value.
        assert!(ctox_cli_executable().is_none());
        let root = std::env::temp_dir().join(format!(
            "web-stack-runtime-config-credential-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let ctox = CtoxRuntimeConfigStore::from_root(&root);
        assert_eq!(ctox.credential("BRIGHTDATA_API_KEY"), None);
        set_ctox_value_for_test(&root, "BRIGHTDATA_API_KEY", "plain");
        assert_eq!(
            ctox.credential("BRIGHTDATA_API_KEY").as_deref(),
            Some("plain")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ctox_secret_get_envelope_parsing_and_name_validation() {
        assert_eq!(
            parse_ctox_secret_get_output(
                br#"{"ok":true,"scope":"credentials","name":"X","value":" abc "}"#
            )
            .as_deref(),
            Some("abc")
        );
        assert_eq!(
            parse_ctox_secret_get_output(br#"{"ok":false,"value":"abc"}"#),
            None
        );
        assert_eq!(
            parse_ctox_secret_get_output(br#"{"ok":true,"value":"  "}"#),
            None
        );
        assert_eq!(parse_ctox_secret_get_output(b"secret not found"), None);
        assert!(valid_credential_name("BRIGHTDATA_API_KEY"));
        assert!(!valid_credential_name("brightdata"));
        assert!(!valid_credential_name("A;rm -rf"));
        assert!(!valid_credential_name(""));
    }

    #[test]
    fn workjet_contexts_remain_isolated_across_threads() {
        let shared_root = Path::new("shared-workjet-root");
        let store_a = WorkjetRuntimeConfigStore::new([("CONFLICT", "alpha")]);
        let store_b = WorkjetRuntimeConfigStore::new([("CONFLICT", "beta")]);
        let context_a = WebStackContext::new(shared_root, &store_a);
        let context_b = WebStackContext::new(shared_root, &store_b);

        std::thread::scope(|scope| {
            let a = scope.spawn(move || (context_a.root.to_path_buf(), context_a.get("CONFLICT")));
            let b = scope.spawn(move || (context_b.root.to_path_buf(), context_b.get("CONFLICT")));
            assert_eq!(
                a.join().unwrap(),
                (shared_root.to_path_buf(), Some("alpha".into()))
            );
            assert_eq!(
                b.join().unwrap(),
                (shared_root.to_path_buf(), Some("beta".into()))
            );
        });
    }
}
