//! ACP filesystem and terminal operations executed inside the worker namespace.
//! These operations consume server capture evidence; they do not grant Owner/team admission.
#[cfg(target_os = "linux")]
mod linux {
    use crate::worker_namespace_launcher::linux::{Capture, Identity, captured_directory, open_at};
    use serde::Deserialize;
    use std::collections::BTreeMap;
    use std::ffi::{CString, OsString};
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::process::CommandExt;
    use std::path::{Component, Path, PathBuf};
    use std::process::Command;

    const MAX_TEXT: u64 = 4 * 1024 * 1024;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        version: u32,
        worktree: Capture,
        host_network: Identity,
        operation: Operation,
    }

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
    enum Operation {
        Read { path: PathBuf, line: Option<usize>, limit: Option<usize> },
        Write { path: PathBuf },
        Terminal { command: String, args: Vec<String>, cwd: PathBuf, env: BTreeMap<String, String> },
    }

    fn denied(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::PermissionDenied, message)
    }

    fn canonical_inside(root: &Path, path: &Path) -> io::Result<PathBuf> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(denied("tool path requires an absolute worktree path"));
        }
        let canonical = fs::canonicalize(path)?;
        if !canonical.starts_with(root) {
            return Err(denied("tool path is outside the captured worktree; escalation required"));
        }
        Ok(canonical)
    }

    fn file_parent(root: &File, root_path: &Path, path: &Path) -> io::Result<(File, OsString)> {
        let relative = path.strip_prefix(root_path).map_err(|_| denied("foreign tool path"))?;
        let mut parts = relative.components().peekable();
        let mut parent = root.try_clone()?;
        while let Some(part) = parts.next() {
            let Component::Normal(name) = part else {
                return Err(denied("noncanonical tool path"));
            };
            if parts.peek().is_none() {
                return Ok((parent, name.to_os_string()));
            }
            parent = open_at(&parent, name, libc::O_RDONLY | libc::O_DIRECTORY)?;
        }
        Err(denied("tool file path is a directory"))
    }

    fn read(root: &File, root_path: &Path, path: &Path, line: Option<usize>, limit: Option<usize>) -> io::Result<()> {
        if line == Some(0) { return Err(denied("tool line numbers start at one")); }
        let canonical = canonical_inside(root_path, path)?;
        let (parent, name) = file_parent(root, root_path, &canonical)?;
        let file = open_at(&parent, &name, libc::O_RDONLY | libc::O_NONBLOCK)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_TEXT {
            return Err(denied("tool read requires a bounded private regular file"));
        }
        let mut text = String::new();
        file.take(MAX_TEXT + 1).read_to_string(&mut text)?;
        if text.len() as u64 > MAX_TEXT { return Err(denied("tool text exceeds the read limit")); }
        let content: String = text.split_inclusive('\n')
            .skip(line.unwrap_or(1) - 1).take(limit.unwrap_or(usize::MAX)).collect();
        serde_json::to_writer(io::stdout().lock(), &serde_json::json!({ "content": content }))?;
        Ok(())
    }

    fn write(root: &File, root_path: &Path, path: &Path) -> io::Result<()> {
        // Resolve the parent first. Rename replaces the directory entry atomically,
        // so an existing hard link never makes this write modify a foreign inode.
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(denied("tool path requires an absolute worktree path"));
        }
        let canonical = match fs::canonicalize(path) {
            Ok(existing) => {
                if !existing.starts_with(root_path) {
                    return Err(denied("tool path is outside the captured worktree; escalation required"));
                }
                existing
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let parent = canonical_inside(root_path, path.parent().ok_or_else(|| denied("missing file parent"))?)?;
                parent.join(path.file_name().ok_or_else(|| denied("missing file name"))?)
            }
            Err(error) => return Err(error),
        };
        let (parent, name) = file_parent(root, root_path, &canonical)?;
        let mode = match open_at(&parent, &name, libc::O_PATH) {
            Ok(file) if file.metadata()?.is_file() => file.metadata()?.mode() & 0o777,
            Ok(_) => return Err(denied("tool write requires a regular file")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0o600,
            Err(error) => return Err(error),
        };
        let mut content = Vec::new();
        io::stdin().take(MAX_TEXT + 1).read_to_end(&mut content)?;
        if content.len() as u64 > MAX_TEXT || std::str::from_utf8(&content).is_err() {
            return Err(denied("tool write requires bounded UTF-8 text"));
        }
        let mut nonce = [0u8; 16];
        File::open("/dev/urandom")?.read_exact(&mut nonce)?;
        let temp = CString::new(format!(".workjet-write-{:032x}", u128::from_ne_bytes(nonce))).unwrap();
        let name = CString::new(name.as_bytes()).map_err(|_| denied("invalid file name"))?;
        let fd = unsafe { libc::openat(parent.as_raw_fd(), temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        let result = (|| {
            let mut file = unsafe { File::from_raw_fd(fd) };
            file.write_all(&content)?;
            file.set_permissions(fs::Permissions::from_mode(mode))?;
            file.sync_all()?;
            if unsafe { libc::renameat(parent.as_raw_fd(), temp.as_ptr(), parent.as_raw_fd(), name.as_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        if result.is_err() {
            unsafe { libc::unlinkat(parent.as_raw_fd(), temp.as_ptr(), 0); }
        }
        result?;
        serde_json::to_writer(io::stdout().lock(), &serde_json::json!({}))?;
        Ok(())
    }

    fn terminal(root_path: &Path, command: String, args: Vec<String>, cwd: PathBuf, env: BTreeMap<String, String>) -> io::Result<()> {
        let cwd = canonical_inside(root_path, &cwd)?;
        if !cwd.is_dir() || command.is_empty() || args.len() > 256 || env.len() > 64 {
            return Err(denied("invalid namespace terminal request"));
        }
        for name in env.keys() {
            if !name.bytes().enumerate().all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
                || name.is_empty()
                || matches!(name.as_str(), "HOME" | "PATH" | "TMPDIR" | "TMP" | "TEMP" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_CACHE_HOME" | "ANTHROPIC_BASE_URL" | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "CLAUDE_CONFIG_DIR" | "GROK_MODELS_BASE_URL" | "XAI_API_KEY" | "GREPPY_ENDPOINT" | "GREPPY_API_KEY" | "OPENCODE_CONFIG_CONTENT" | "MINIMAX_DATA_DIR" | "PI_CODING_AGENT_DIR")
                || name.starts_with("WORKJET_") || name.starts_with("GIT_")
            {
                return Err(denied("terminal environment cannot override worker custody"));
            }
        }
        Err(Command::new(command).args(args).current_dir(cwd).envs(env).exec())
    }

    pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<i32> {
        let encoded = args.next().ok_or_else(|| denied("missing namespace tool request"))?;
        if encoded.len() > 32 * 1024 || args.next().is_some() {
            return Err(denied("invalid namespace tool envelope"));
        }
        let request: Request = serde_json::from_slice(encoded.as_bytes())?;
        if request.version != 1 { return Err(denied("unsupported namespace tool version")); }
        let network = fs::metadata("/proc/self/ns/net")?;
        if network.dev().to_string() == request.host_network.device && network.ino().to_string() == request.host_network.inode {
            return Err(denied("namespace tool cannot run on the original host network"));
        }
        let root = captured_directory(&request.worktree)?;
        match request.operation {
            Operation::Read { path, line, limit } => read(&root, &request.worktree.path, &path, line, limit)?,
            Operation::Write { path } => write(&root, &request.worktree.path, &path)?,
            Operation::Terminal { command, args, cwd, env } => terminal(&request.worktree.path, command, args, cwd, env)?,
        }
        Ok(0)
    }
}
#[cfg(target_os = "linux")]
pub fn run(args: impl Iterator<Item = std::ffi::OsString>) -> std::io::Result<i32> { linux::run(args) }
#[cfg(not(target_os = "linux"))]
pub fn run(_args: impl Iterator<Item = std::ffi::OsString>) -> std::io::Result<i32> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "worker namespace tools are unavailable on this host"))
}
