use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::PathBuf;

use workjet_provider_gateway::internal::auth::{antigravity, claude, codex};
use workjet_provider_gateway::internal::config::RuntimeSecretRef;
use zeroize::Zeroizing;

use crate::config::ALLOWED_SECRET_SCOPE;

const MAX_SECRET_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretResolveError {
    InvalidScope,
    InvalidName,
    UnsafeRoot,
    Missing,
    Symlink,
    NotFile,
    UnsafePermissions,
    Oversized,
    Empty,
    InvalidEncoding,
    Read,
    Write,
}

impl fmt::Display for SecretResolveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidScope | Self::InvalidName => "secret reference is invalid",
            Self::UnsafeRoot | Self::Symlink | Self::NotFile | Self::UnsafePermissions => {
                "secret storage is unsafe"
            }
            Self::Missing => "secret is unavailable",
            Self::Oversized | Self::Empty | Self::InvalidEncoding => "secret value is invalid",
            Self::Read => "secret could not be read",
            Self::Write => "secret could not be written",
        })
    }
}

impl std::error::Error for SecretResolveError {}

#[derive(Clone)]
pub struct WorkjetSecretStore {
    root: PathBuf,
}

impl fmt::Debug for WorkjetSecretStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkjetSecretStore")
            .field("backend", &"server-secret-store-files")
            .finish()
    }
}

impl WorkjetSecretStore {
    pub fn new(root: PathBuf) -> Result<Self, SecretResolveError> {
        let metadata = fs::symlink_metadata(&root).map_err(|_| SecretResolveError::UnsafeRoot)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(SecretResolveError::UnsafeRoot);
        }
        reject_unsafe_permissions(&metadata).map_err(|_| SecretResolveError::UnsafeRoot)?;
        Ok(Self { root })
    }

    pub fn resolve_bytes(
        &self,
        secret_ref: &RuntimeSecretRef,
    ) -> Result<Zeroizing<Vec<u8>>, SecretResolveError> {
        let path = self.path_for(secret_ref)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SecretResolveError::Missing
            } else {
                SecretResolveError::Read
            }
        })?;
        if metadata.file_type().is_symlink() {
            return Err(SecretResolveError::Symlink);
        }
        if !metadata.is_file() {
            return Err(SecretResolveError::NotFile);
        }
        reject_unsafe_permissions(&metadata)?;
        let file = OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|_| SecretResolveError::Read)?;
        let opened_metadata = file.metadata().map_err(|_| SecretResolveError::Read)?;
        if !opened_metadata.is_file() || !same_file_identity(&metadata, &opened_metadata) {
            return Err(SecretResolveError::Symlink);
        }
        reject_unsafe_permissions(&opened_metadata)?;
        let length =
            usize::try_from(opened_metadata.len()).map_err(|_| SecretResolveError::Oversized)?;
        if length > MAX_SECRET_BYTES {
            return Err(SecretResolveError::Oversized);
        }
        let mut bytes = Vec::with_capacity(length);
        file.take((MAX_SECRET_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| SecretResolveError::Read)?;
        if bytes.len() > MAX_SECRET_BYTES {
            return Err(SecretResolveError::Oversized);
        }
        let value = Zeroizing::new(bytes);
        if value.is_empty() {
            return Err(SecretResolveError::Empty);
        }
        Ok(value)
    }

    pub fn resolve_text(
        &self,
        secret_ref: &RuntimeSecretRef,
    ) -> Result<Zeroizing<String>, SecretResolveError> {
        let bytes = self.resolve_bytes(secret_ref)?;
        let value =
            String::from_utf8(bytes.to_vec()).map_err(|_| SecretResolveError::InvalidEncoding)?;
        if value.trim().is_empty() {
            return Err(SecretResolveError::Empty);
        }
        Ok(Zeroizing::new(value))
    }

    pub fn management_key(
        &self,
        secret_ref: &RuntimeSecretRef,
    ) -> Result<Zeroizing<String>, SecretResolveError> {
        let bytes = self.resolve_bytes(secret_ref)?;
        if bytes.len() < 32 {
            return Err(SecretResolveError::Empty);
        }
        let mut value = String::with_capacity(bytes.len() * 2);
        for byte in bytes.iter() {
            use std::fmt::Write as _;
            write!(&mut value, "{byte:02x}").map_err(|_| SecretResolveError::Read)?;
        }
        Ok(Zeroizing::new(value))
    }

    fn path_for(&self, secret_ref: &RuntimeSecretRef) -> Result<PathBuf, SecretResolveError> {
        validate_reference(secret_ref)?;
        Ok(self
            .root
            .join(format!("{}.{}.bin", secret_ref.scope, secret_ref.name)))
    }

    fn write_text(
        &self,
        secret_ref: &RuntimeSecretRef,
        value: &str,
    ) -> Result<(), SecretResolveError> {
        if value.is_empty() || value.len() > MAX_SECRET_BYTES {
            return Err(SecretResolveError::Empty);
        }
        let path = self.path_for(secret_ref)?;
        let temporary = path.with_extension(format!("bin.{}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| SecretResolveError::Write)?;
        let result = (|| {
            file.write_all(value.as_bytes())
                .map_err(|_| SecretResolveError::Write)?;
            file.sync_all().map_err(|_| SecretResolveError::Write)?;
            fs::rename(&temporary, &path).map_err(|_| SecretResolveError::Write)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

fn validate_reference(secret_ref: &RuntimeSecretRef) -> Result<(), SecretResolveError> {
    if secret_ref.scope != ALLOWED_SECRET_SCOPE {
        return Err(SecretResolveError::InvalidScope);
    }
    let name = secret_ref.name.as_str();
    if name.is_empty()
        || name.len() > 160
        || name == "."
        || name == ".."
        || name.contains("..")
        || name.chars().any(|character| {
            !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | '-')
        })
    {
        return Err(SecretResolveError::InvalidName);
    }
    Ok(())
}

#[cfg(unix)]
fn same_file_identity(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    expected.dev() == opened.dev() && expected.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_file_identity(_expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
    opened.is_file()
}

#[cfg(unix)]
fn reject_unsafe_permissions(metadata: &fs::Metadata) -> Result<(), SecretResolveError> {
    use std::os::unix::fs::MetadataExt as _;
    if metadata.mode() & 0o077 != 0 {
        return Err(SecretResolveError::UnsafePermissions);
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_unsafe_permissions(_metadata: &fs::Metadata) -> Result<(), SecretResolveError> {
    Ok(())
}

fn runtime_ref(scope: &str, name: &str) -> RuntimeSecretRef {
    RuntimeSecretRef {
        scope: scope.to_owned(),
        name: name.to_owned(),
    }
}

impl claude::ClaudeSecretStore for WorkjetSecretStore {
    fn load_credentials(
        &self,
        handles: &claude::ClaudeCredentialHandles,
    ) -> Result<claude::ClaudeStoredCredentials, claude::SecretStoreError> {
        let access = self
            .resolve_text(&runtime_ref(
                handles.access_token().scope(),
                handles.access_token().name(),
            ))
            .map_err(map_claude_read)?;
        let refresh = self
            .resolve_text(&runtime_ref(
                handles.refresh_token().scope(),
                handles.refresh_token().name(),
            ))
            .map_err(map_claude_read)?;
        Ok(claude::ClaudeStoredCredentials::new(
            claude::SecretString::new(access.to_string())
                .map_err(|_| claude::SecretStoreError::InvalidValue)?,
            claude::SecretString::new(refresh.to_string())
                .map_err(|_| claude::SecretStoreError::InvalidValue)?,
        ))
    }

    fn store_credentials(
        &self,
        handles: &claude::ClaudeCredentialHandles,
        credentials: &claude::ClaudeStoredCredentials,
    ) -> Result<(), claude::SecretStoreError> {
        self.write_text(
            &runtime_ref(
                handles.access_token().scope(),
                handles.access_token().name(),
            ),
            credentials.access_token().expose_secret(),
        )
        .map_err(|_| claude::SecretStoreError::Write)?;
        self.write_text(
            &runtime_ref(
                handles.refresh_token().scope(),
                handles.refresh_token().name(),
            ),
            credentials.refresh_token().expose_secret(),
        )
        .map_err(|_| claude::SecretStoreError::Write)
    }
}

fn map_claude_read(error: SecretResolveError) -> claude::SecretStoreError {
    match error {
        SecretResolveError::Missing => claude::SecretStoreError::Missing,
        SecretResolveError::Empty | SecretResolveError::InvalidEncoding => {
            claude::SecretStoreError::InvalidValue
        }
        _ => claude::SecretStoreError::Read,
    }
}

impl codex::CodexSecretStore for WorkjetSecretStore {
    fn load_credentials(
        &self,
        handles: &codex::CodexCredentialHandles,
    ) -> Result<codex::CodexStoredCredentials, codex::SecretStoreError> {
        let read = |handle: &codex::CodexSecretHandle| {
            self.resolve_text(&runtime_ref(handle.scope(), handle.name()))
                .map_err(map_codex_read)
                .and_then(|value| {
                    codex::SecretString::new(value.to_string())
                        .map_err(|_| codex::SecretStoreError::InvalidValue)
                })
        };
        Ok(codex::CodexStoredCredentials::new(
            read(handles.id_token())?,
            read(handles.access_token())?,
            read(handles.refresh_token())?,
        ))
    }

    fn store_credentials(
        &self,
        handles: &codex::CodexCredentialHandles,
        credentials: &codex::CodexStoredCredentials,
    ) -> Result<(), codex::SecretStoreError> {
        for (handle, value) in [
            (handles.id_token(), credentials.id_token()),
            (handles.access_token(), credentials.access_token()),
            (handles.refresh_token(), credentials.refresh_token()),
        ] {
            self.write_text(
                &runtime_ref(handle.scope(), handle.name()),
                value.expose_secret(),
            )
            .map_err(|_| codex::SecretStoreError::Write)?;
        }
        Ok(())
    }
}

fn map_codex_read(error: SecretResolveError) -> codex::SecretStoreError {
    match error {
        SecretResolveError::Missing => codex::SecretStoreError::Missing,
        SecretResolveError::Empty | SecretResolveError::InvalidEncoding => {
            codex::SecretStoreError::InvalidValue
        }
        _ => codex::SecretStoreError::Read,
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AntigravityState {
    expires_at_unix_ms: u64,
    project_id: String,
}

/// Renders the antigravity `state_secret` payload in exactly the form
/// [`antigravity::AntigravitySecretStore::load_credentials`] parses back. The
/// single definition above is the contract; a claiming control plane stores
/// this string byte-for-byte.
pub(crate) fn antigravity_state_secret(
    expires_at_unix_ms: u64,
    project_id: &str,
) -> Result<String, SecretResolveError> {
    serde_json::to_string(&AntigravityState {
        expires_at_unix_ms,
        project_id: project_id.to_owned(),
    })
    .map_err(|_| SecretResolveError::InvalidEncoding)
}

impl antigravity::AntigravitySecretStore for WorkjetSecretStore {
    fn load_credentials(
        &self,
        handles: &antigravity::AntigravityCredentialHandles,
    ) -> Result<antigravity::AntigravityStoredCredentials, antigravity::AntigravityTokenError> {
        let read = |handle: &antigravity::AntigravitySecretHandle| {
            self.resolve_text(&runtime_ref(handle.scope(), handle.name()))
                .map_err(map_antigravity_read)
        };
        let access = read(handles.access_token())?;
        let refresh = read(handles.refresh_token())?;
        let state_raw = read(handles.state())?;
        let state: AntigravityState = serde_json::from_str(&state_raw)
            .map_err(|_| antigravity::AntigravityTokenError::Read)?;
        let expires_at = std::time::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(state.expires_at_unix_ms))
            .ok_or(antigravity::AntigravityTokenError::ExpiryOverflow)?;
        antigravity::AntigravityStoredCredentials::new(
            antigravity::SecretString::new(access.to_string())?,
            antigravity::SecretString::new(refresh.to_string())?,
            expires_at,
            state.project_id,
        )
    }

    fn store_credentials(
        &self,
        handles: &antigravity::AntigravityCredentialHandles,
        credentials: &antigravity::AntigravityStoredCredentials,
    ) -> Result<(), antigravity::AntigravityTokenError> {
        self.write_text(
            &runtime_ref(
                handles.access_token().scope(),
                handles.access_token().name(),
            ),
            credentials.access_token().expose_secret(),
        )
        .map_err(|_| antigravity::AntigravityTokenError::Write)?;
        self.write_text(
            &runtime_ref(
                handles.refresh_token().scope(),
                handles.refresh_token().name(),
            ),
            credentials.refresh_token().expose_secret(),
        )
        .map_err(|_| antigravity::AntigravityTokenError::Write)?;
        let expires_at_unix_ms = credentials
            .expires_at()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| antigravity::AntigravityTokenError::Write)?
            .as_millis();
        let expires_at_unix_ms = u64::try_from(expires_at_unix_ms)
            .map_err(|_| antigravity::AntigravityTokenError::Write)?;
        let state = serde_json::to_string(&AntigravityState {
            expires_at_unix_ms,
            project_id: credentials.project_id().to_owned(),
        })
        .map_err(|_| antigravity::AntigravityTokenError::Write)?;
        self.write_text(
            &runtime_ref(handles.state().scope(), handles.state().name()),
            &state,
        )
        .map_err(|_| antigravity::AntigravityTokenError::Write)
    }
}

fn map_antigravity_read(error: SecretResolveError) -> antigravity::AntigravityTokenError {
    match error {
        SecretResolveError::Missing => antigravity::AntigravityTokenError::Missing,
        _ => antigravity::AntigravityTokenError::Read,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt as _};
    use tempfile::TempDir;

    fn reference(name: &str) -> RuntimeSecretRef {
        runtime_ref(ALLOWED_SECRET_SCOPE, name)
    }

    fn store() -> (TempDir, WorkjetSecretStore) {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let store = WorkjetSecretStore::new(root.path().to_path_buf()).unwrap();
        (root, store)
    }

    #[test]
    fn rejects_scope_traversal_separators_and_empty_names_without_rendering_values() {
        let (_root, store) = store();
        for secret_ref in [
            runtime_ref("foreign", "token"),
            reference("../token"),
            reference("nested/token"),
            reference("nested\\token"),
            reference(""),
        ] {
            let error = store.resolve_text(&secret_ref).unwrap_err();
            assert!(!format!("{error:?} {error}").contains("provider-value"));
        }
    }

    #[test]
    fn antigravity_state_secret_round_trips_through_the_credential_loader() {
        use workjet_provider_gateway::internal::auth::antigravity::AntigravitySecretStore as _;

        let (root, store) = store();
        let handle = |name: &str, kind| {
            antigravity::AntigravitySecretHandle::new(ALLOWED_SECRET_SCOPE, name, kind).unwrap()
        };
        let handles = antigravity::AntigravityCredentialHandles::new(
            handle("ag.access", antigravity::AntigravitySecretKind::AccessToken),
            handle(
                "ag.refresh",
                antigravity::AntigravitySecretKind::RefreshToken,
            ),
            handle("ag.state", antigravity::AntigravitySecretKind::State),
        )
        .unwrap();

        let state = antigravity_state_secret(1_700_000_000_000, "projects/demo").unwrap();
        assert_eq!(
            state,
            r#"{"expiresAtUnixMs":1700000000000,"projectId":"projects/demo"}"#
        );
        for (name, value) in [
            ("ag.access", "ag-access-token"),
            ("ag.refresh", "ag-refresh-token"),
            ("ag.state", state.as_str()),
        ] {
            let path = root
                .path()
                .join(format!("{ALLOWED_SECRET_SCOPE}.{name}.bin"));
            fs::write(&path, value).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }

        let loaded = store.load_credentials(&handles).unwrap();
        assert_eq!(loaded.project_id(), "projects/demo");
        assert_eq!(
            loaded
                .expires_at()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
            1_700_000_000_000
        );
        assert_eq!(loaded.access_token().expose_secret(), "ag-access-token");
        assert_eq!(loaded.refresh_token().expose_secret(), "ag-refresh-token");
    }

    #[test]
    fn rejects_symlinks_unsafe_permissions_and_empty_values() {
        let (root, store) = store();
        let target = root.path().join("target");
        fs::write(&target, "provider-value").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(
            &target,
            root.path().join(format!("{ALLOWED_SECRET_SCOPE}.link.bin")),
        )
        .unwrap();
        assert_eq!(
            store.resolve_text(&reference("link")),
            Err(SecretResolveError::Symlink)
        );

        let unsafe_path = root
            .path()
            .join(format!("{ALLOWED_SECRET_SCOPE}.unsafe.bin"));
        fs::write(&unsafe_path, "provider-value").unwrap();
        fs::set_permissions(&unsafe_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            store.resolve_text(&reference("unsafe")),
            Err(SecretResolveError::UnsafePermissions)
        );

        let empty_path = root
            .path()
            .join(format!("{ALLOWED_SECRET_SCOPE}.empty.bin"));
        fs::write(&empty_path, "").unwrap();
        fs::set_permissions(&empty_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            store.resolve_text(&reference("empty")),
            Err(SecretResolveError::Empty)
        );
    }
}
