//! Linux process boundary for an originally captured private worker checkout.
//! The capture is supplied by the server, not a native Owner/team admission.
#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use serde::Deserialize;
    use std::collections::BTreeSet;
    use std::ffi::{CString, OsString};
    use std::fs::{self, File};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Component, Path, PathBuf};
    use std::process::Command;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct Identity {
        pub(crate) device: String,
        pub(crate) inode: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct Capture {
        pub(crate) path: PathBuf,
        pub(crate) identity: Identity,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Plan {
        version: u32,
        worktree: Capture,
        git_identity: Identity,
        profile: Capture,
        model_socket: Capture,
        host_network: Identity,
        runtime_files: Vec<Capture>,
        #[serde(default)]
        runtime_directories: Vec<Capture>,
    }

    fn denied(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::PermissionDenied, message)
    }
    fn identity_matches(file: &File, expected: &Identity) -> io::Result<bool> {
        let stat = file.metadata()?;
        Ok(stat.dev().to_string() == expected.device && stat.ino().to_string() == expected.inode)
    }
    pub(crate) fn open_at(parent: &File, name: &std::ffi::OsStr, flags: i32) -> io::Result<File> {
        let name = CString::new(name.as_bytes()).map_err(|_| denied("invalid capture path"))?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn open_directory(path: &Path) -> io::Result<File> {
        let mut components = path.components();
        if components.next() != Some(Component::RootDir) {
            return Err(denied("capture path must be absolute"));
        }
        let fd = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut directory = unsafe { File::from_raw_fd(fd) };
        let mut count = 0;
        for component in components {
            let Component::Normal(name) = component else {
                return Err(denied("capture path is not canonical"));
            };
            directory = open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY)?;
            count += 1;
        }
        if count == 0 {
            return Err(denied("filesystem root is not a worker capture"));
        }
        Ok(directory)
    }
    pub(crate) fn captured_directory(capture: &Capture) -> io::Result<File> {
        let directory = open_directory(&capture.path)?;
        if !identity_matches(&directory, &capture.identity)? {
            return Err(denied("captured directory identity changed"));
        }
        Ok(directory)
    }
    fn runtime_file(capture: &Capture) -> io::Result<File> {
        let parent = capture
            .path
            .parent()
            .ok_or_else(|| denied("runtime file has no parent"))?;
        let name = capture
            .path
            .file_name()
            .ok_or_else(|| denied("runtime file has no name"))?;
        let directory = open_directory(parent)?;
        let file = open_at(&directory, name, libc::O_PATH)?;
        if !file.metadata()?.is_file() || !identity_matches(&file, &capture.identity)? {
            return Err(denied("runtime file identity changed"));
        }
        Ok(file)
    }
    fn forbid_entry(directory: &File, name: &std::ffi::OsStr) -> io::Result<()> {
        match open_at(directory, name, libc::O_PATH) {
            Ok(_) => Err(denied(
                "shared Git metadata is not a private worker checkout",
            )),
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(()),
            Err(error) => Err(error),
        }
    }
    fn private_git(worktree: &File, expected: &Identity) -> io::Result<()> {
        let git = open_at(
            worktree,
            std::ffi::OsStr::new(".git"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        if !identity_matches(&git, expected)? {
            return Err(denied("captured Git identity changed"));
        }
        forbid_entry(&git, std::ffi::OsStr::new("commondir"))?;
        let objects = open_at(
            &git,
            std::ffi::OsStr::new("objects"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let info = open_at(
            &objects,
            std::ffi::OsStr::new("info"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        forbid_entry(&info, std::ffi::OsStr::new("alternates"))?;
        forbid_entry(&info, std::ffi::OsStr::new("http-alternates"))
    }
    fn bind(
        command: &mut Command,
        file: &File,
        destination: &Path,
        readonly: bool,
    ) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        if flags < 0
            || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, flags & !libc::FD_CLOEXEC) }
                < 0
        {
            return Err(io::Error::last_os_error());
        }
        command
            .arg(if readonly {
                "--ro-bind-fd"
            } else {
                "--bind-fd"
            })
            .arg(file.as_raw_fd().to_string())
            .arg(destination);
        Ok(())
    }
    fn parent_directories(command: &mut Command, paths: impl Iterator<Item = PathBuf>) {
        // Debian tool names such as cc and awk point through /etc/alternatives.
        // Recreate only symlinks whose final executable is already in read-only /usr.
        // Never mount the host's /etc directory or alternatives contents.
        let mut aliases = std::collections::BTreeMap::new();
        if let Ok(entries) = fs::read_dir("/usr/bin") {
            for entry in entries.flatten() {
                let Ok(alias) = fs::read_link(entry.path()) else {
                    continue;
                };
                if alias.parent() != Some(Path::new("/etc/alternatives")) {
                    continue;
                }
                let Ok(executable) = fs::canonicalize(entry.path()) else {
                    continue;
                };
                let Ok(metadata) = fs::metadata(&executable) else {
                    continue;
                };
                if executable.starts_with("/usr")
                    && metadata.is_file()
                    && metadata.mode() & 0o111 != 0
                {
                    aliases.insert(alias, executable);
                }
            }
        }
        if !aliases.is_empty() {
            command.args(["--dir", "/etc/alternatives"]);
            for (alias, executable) in aliases {
                command.arg("--symlink").arg(executable).arg(alias);
            }
        }
        let mut directories = BTreeSet::new();
        for path in paths {
            for parent in path.ancestors().skip(1) {
                if parent != Path::new("/") && parent != Path::new("/usr") {
                    directories.insert(parent.to_path_buf());
                }
            }
        }
        for directory in directories {
            command.arg("--dir").arg(directory);
        }
    }

    pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<i32> {
        crate::worker_fds::close_inherited()?;
        let encoded = args
            .next()
            .ok_or_else(|| denied("missing worker namespace capture"))?;
        let encoded = encoded
            .to_str()
            .filter(|value| value.len() <= 32 * 1024)
            .ok_or_else(|| denied("invalid worker namespace capture"))?;
        let plan: Plan = serde_json::from_str(encoded)
            .map_err(|_| denied("invalid worker namespace capture"))?;
        if plan.version != 1
            || plan.runtime_files.len() > 16
            || plan.runtime_directories.len() > 8
            || args.next().as_deref() != Some(std::ffi::OsStr::new("--"))
        {
            return Err(denied("unsupported worker namespace capture"));
        }
        let program = PathBuf::from(
            args.next()
                .ok_or_else(|| denied("missing worker command"))?,
        );
        if !program.is_absolute() {
            return Err(denied("worker command must be absolute"));
        }
        let worktree = captured_directory(&plan.worktree)?;
        private_git(&worktree, &plan.git_identity)?;
        let profile = captured_directory(&plan.profile)?;
        let profile_stat = profile.metadata()?;
        if profile_stat.uid() != unsafe { libc::geteuid() } || profile_stat.mode() & 0o077 != 0 {
            return Err(denied("worker profile must be private"));
        }
        if plan.profile.path.starts_with(&plan.worktree.path)
            || plan.worktree.path.starts_with(&plan.profile.path)
        {
            return Err(denied("worker checkout and profile must be separate"));
        }
        let socket_name = CString::new(plan.model_socket.path.as_os_str().as_bytes())
            .map_err(|_| denied("invalid model socket"))?;
        let socket_fd = unsafe {
            libc::open(
                socket_name.as_ptr(),
                libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if socket_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let socket = unsafe { File::from_raw_fd(socket_fd) };
        let socket_stat = socket.metadata()?;
        if socket_stat.mode() & libc::S_IFMT != libc::S_IFSOCK
            || socket_stat.uid() != unsafe { libc::geteuid() }
            || socket_stat.mode() & 0o077 != 0
            || !identity_matches(&socket, &plan.model_socket.identity)?
        {
            return Err(denied("model socket identity changed"));
        }
        let network = fs::metadata("/proc/self/ns/net")?;
        if network.dev().to_string() != plan.host_network.device
            || network.ino().to_string() != plan.host_network.inode
        {
            return Err(denied("original host network identity changed"));
        }
        let runtimes = plan
            .runtime_files
            .iter()
            .map(runtime_file)
            .collect::<io::Result<Vec<_>>>()?;
        let runtime_directories = plan
            .runtime_directories
            .iter()
            .map(captured_directory)
            .collect::<io::Result<Vec<_>>>()?;
        if program != Path::new("/run/workjet/helper")
            && !program.starts_with("/usr")
            && !plan.runtime_files.iter().any(|file| file.path == program)
            && !plan
                .runtime_directories
                .iter()
                .any(|directory| program.starts_with(&directory.path))
        {
            return Err(denied("worker executable is not captured"));
        }
        let usr = open_directory(Path::new("/usr"))?;
        let helper = File::open("/proc/self/exe")?;
        let mut command = Command::new("/usr/bin/bwrap");
        command.args([
            "--unshare-user",
            "--unshare-pid",
            "--unshare-net",
            "--unshare-uts",
            "--unshare-ipc",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/run/workjet",
        ]);
        bind(&mut command, &usr, Path::new("/usr"), true)?;
        for (target, source) in [
            ("/bin", "usr/bin"),
            ("/sbin", "usr/sbin"),
            ("/lib", "usr/lib"),
            ("/lib64", "usr/lib64"),
        ] {
            command.args(["--symlink", source, target]);
        }
        parent_directories(
            &mut command,
            std::iter::once(plan.worktree.path.clone())
                .chain(std::iter::once(plan.profile.path.clone()))
                .chain(plan.runtime_files.iter().map(|file| file.path.clone()))
                .chain(
                    plan.runtime_directories
                        .iter()
                        .map(|directory| directory.path.clone()),
                ),
        );
        bind(&mut command, &worktree, &plan.worktree.path, false)?;
        bind(&mut command, &profile, &plan.profile.path, false)?;
        bind(
            &mut command,
            &socket,
            Path::new("/run/workjet/model.sock"),
            true,
        )?;
        bind(
            &mut command,
            &helper,
            Path::new("/run/workjet/helper"),
            true,
        )?;
        for (capture, directory) in plan.runtime_directories.iter().zip(&runtime_directories) {
            bind(&mut command, directory, &capture.path, true)?;
        }
        for (capture, file) in plan.runtime_files.iter().zip(&runtimes) {
            bind(&mut command, file, &capture.path, true)?;
        }
        command
            .arg("--chdir")
            .arg(&plan.worktree.path)
            .args([
                "--remount-ro",
                "/",
                "--",
                "/run/workjet/helper",
                "--worker-model-bridge",
                "/run/workjet/model.sock",
            ])
            .arg(&plan.model_socket.identity.device)
            .arg(&plan.model_socket.identity.inode)
            .arg("23197")
            .arg(&plan.host_network.device)
            .arg(&plan.host_network.inode)
            .arg("--")
            .arg(program)
            .args(args);
        command.env_clear();
        for name in [
            "PATH",
            "LANG",
            "LC_ALL",
            "TERM",
            "HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "WORKJET_SOURCE_ISOLATED",
            "WORKJET_WORKER_SOURCE_URL",
            "WORKJET_WORKER_SOURCE_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
            "GROK_MODELS_BASE_URL",
            "XAI_API_KEY",
            "GREPPY_ENDPOINT",
            "GREPPY_API_KEY",
            "OPENCODE_CONFIG_CONTENT",
            "MINIMAX_DATA_DIR",
            "PI_CODING_AGENT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("TMPDIR", "/tmp")
            .env("TMP", "/tmp")
            .env("TEMP", "/tmp");
        if let Some(home) = std::env::var_os("HOME")
            && !PathBuf::from(home).starts_with(&plan.profile.path)
        {
            return Err(denied("worker HOME is outside its private profile"));
        }
        Err(command.exec())
    }
}
#[cfg(target_os = "linux")]
pub fn run(args: impl Iterator<Item = std::ffi::OsString>) -> std::io::Result<i32> {
    linux::run(args)
}
#[cfg(not(target_os = "linux"))]
pub fn run(_args: impl Iterator<Item = std::ffi::OsString>) -> std::io::Result<i32> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "worker process namespaces are unavailable on this host",
    ))
}
