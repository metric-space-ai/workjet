use anyhow::Context;
use anyhow::Result;
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

const DEFAULT_RUNTIME_CONFIG_RELATIVE_PATH: &str = "runtime/ctox-runtime.sqlite3";

/// Call-scoped runtime configuration lookup.
///
/// Implementations must treat missing, blank, and unreadable values as absent.
pub trait RuntimeConfigStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
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
}

impl CtoxRuntimeConfigStore {
    pub fn from_root(root: &Path) -> Self {
        Self::from_database_path(runtime_config_path(root))
    }

    pub fn from_database_path(database_path: PathBuf) -> Self {
        Self { database_path }
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
