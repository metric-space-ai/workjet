//! Descriptor-relative removal for a worktree whose Git merge was verified by
//! the server. This helper never resolves a child directory through a symlink.
//! A changed path or unsupported platform is an error: the caller retains its
//! durable cleanup receipt for recovery.

use std::io;
use std::path::Path;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use std::ffi::{CStr, CString, OsStr};
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    const DIR_FLAGS: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    fn c_name(name: &OsStr) -> io::Result<CString> {
        CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in directory name"))
    }

    fn opened_fd(raw: i32) -> io::Result<OwnedFd> {
        if raw < 0 {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: successful open/openat/dup returns a new owned descriptor.
            Ok(unsafe { OwnedFd::from_raw_fd(raw) })
        }
    }

    fn open_dir_at(parent: &OwnedFd, name: &CStr) -> io::Result<OwnedFd> {
        // SAFETY: parent is open, name is NUL terminated, and O_NOFOLLOW
        // rejects a symlink at this component.
        opened_fd(unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), DIR_FLAGS) })
    }

    fn parent_and_name(path: &Path) -> io::Result<(OwnedFd, CString)> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path is not absolute",
            ));
        }
        let mut components = path.components();
        if components.next() != Some(Component::RootDir) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path has no root",
            ));
        }
        let names = components
            .map(|component| match component {
                Component::Normal(name) => c_name(name),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path contains a non-normal component",
                )),
            })
            .collect::<io::Result<Vec<_>>>()?;
        let (basename, parents) = names.split_last().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "refusing filesystem root")
        })?;
        let mut current = opened_fd(unsafe { libc::open(c"/".as_ptr(), DIR_FLAGS) })?;
        for name in parents {
            current = open_dir_at(&current, name)?;
        }
        Ok((current, basename.clone()))
    }

    fn identity(fd: &OwnedFd) -> io::Result<(u64, u64)> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: stat points to writable storage and fd remains open.
        if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fstat initialized the value on success.
        let stat = unsafe { stat.assume_init() };
        Ok((stat.st_dev as u64, stat.st_ino as u64))
    }

    fn read_regular_file_at(parent: &OwnedFd, name: &CStr) -> io::Result<String> {
        // O_NOFOLLOW also applies to Git's backlink files. O_NONBLOCK avoids
        // waiting on a swapped FIFO before fstat rejects non-regular input.
        let fd = opened_fd(unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        })?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Git backlink is not a regular file",
            ));
        }
        let mut value = String::new();
        std::fs::File::from(fd)
            .take(4_097)
            .read_to_string(&mut value)?;
        if value.len() > 4_096 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Git backlink is too long",
            ));
        }
        Ok(value)
    }

    #[cfg(target_os = "macos")]
    fn errno_ptr() -> *mut i32 {
        // SAFETY: libc exposes the current thread's errno slot.
        unsafe { libc::__error() }
    }

    #[cfg(target_os = "linux")]
    fn errno_ptr() -> *mut i32 {
        // SAFETY: libc exposes the current thread's errno slot.
        unsafe { libc::__errno_location() }
    }

    struct DirectoryStream(*mut libc::DIR);

    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            // SAFETY: fdopendir transferred ownership of its duplicated fd.
            unsafe { libc::closedir(self.0) };
        }
    }

    fn entries(fd: &OwnedFd) -> io::Result<Vec<CString>> {
        // SAFETY: dup creates a descriptor owned by fdopendir on success.
        let duplicate = unsafe { libc::dup(fd.as_raw_fd()) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: duplicate is an open directory descriptor.
        let raw_stream = unsafe { libc::fdopendir(duplicate) };
        if raw_stream.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir did not take ownership on failure.
            unsafe { libc::close(duplicate) };
            return Err(error);
        }
        let stream = DirectoryStream(raw_stream);
        let mut result = Vec::new();
        loop {
            // SAFETY: the stream is valid, and errno is thread local.
            unsafe { *errno_ptr() = 0 };
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                // SAFETY: errno is thread local.
                let error = unsafe { *errno_ptr() };
                if error != 0 {
                    return Err(io::Error::from_raw_os_error(error));
                }
                return Ok(result);
            }
            // SAFETY: d_name is NUL terminated and valid until the next readdir.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() != b"." && name.to_bytes() != b".." {
                result.push(name.to_owned());
            }
        }
    }

    fn unlink_at(parent: &OwnedFd, name: &CStr, flags: i32) -> io::Result<()> {
        // SAFETY: unlinkat operates relative to the pinned parent descriptor;
        // it unlinks a symlink itself and cannot follow it.
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn require_same_device(fd: &OwnedFd, expected_dev: u64) -> io::Result<()> {
        if identity(fd)?.0 != expected_dev {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "directory crosses a filesystem boundary",
            ));
        }
        Ok(())
    }

    fn require_named_identity(
        parent: &OwnedFd,
        name: &CStr,
        expected: (u64, u64),
    ) -> io::Result<()> {
        let named = open_dir_at(parent, name)?;
        if identity(&named)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "directory entry changed during removal",
            ));
        }
        Ok(())
    }

    fn remove_contents(fd: &OwnedFd, expected_dev: u64) -> io::Result<()> {
        require_same_device(fd, expected_dev)?;
        for name in entries(fd)? {
            match open_dir_at(fd, &name) {
                Ok(child) => {
                    require_same_device(&child, expected_dev)?;
                    let child_identity = identity(&child)?;
                    remove_contents(&child, expected_dev)?;
                    require_named_identity(fd, &name, child_identity)?;
                    unlink_at(fd, &name, libc::AT_REMOVEDIR)?;
                }
                Err(error) if matches!(error.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {
                    unlink_at(fd, &name, 0)?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn remove_with_hook(
        path: &Path,
        expected_dev: u64,
        expected_ino: u64,
        before_contents: impl FnOnce(),
    ) -> io::Result<()> {
        let (parent, name) = parent_and_name(path)?;
        let target = open_dir_at(&parent, &name)?;
        let expected = (expected_dev, expected_ino);
        if identity(&target)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "directory identity changed",
            ));
        }
        before_contents();
        remove_contents(&target, expected_dev)?;
        require_named_identity(&parent, &name, expected)?;
        unlink_at(&parent, &name, libc::AT_REMOVEDIR)
    }

    pub(super) fn remove_verified_directory(
        path: &Path,
        expected_dev: u64,
        expected_ino: u64,
    ) -> io::Result<()> {
        remove_with_hook(path, expected_dev, expected_ino, || ())
    }

    pub(super) fn remove_verified_worktree_and_admin(
        worktree_path: &Path,
        worktree_dev: u64,
        worktree_ino: u64,
        admin_path: &Path,
        admin_dev: u64,
        admin_ino: u64,
    ) -> io::Result<()> {
        if admin_path.parent().and_then(Path::file_name) != Some(OsStr::new("worktrees"))
            || admin_path.starts_with(worktree_path)
            || worktree_path.starts_with(admin_path)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Git worktree administration path",
            ));
        }
        let (worktree_parent, worktree_name) = parent_and_name(worktree_path)?;
        let worktree = open_dir_at(&worktree_parent, &worktree_name)?;
        if identity(&worktree)? != (worktree_dev, worktree_ino) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "worktree directory identity changed",
            ));
        }
        let (admin_parent, admin_name) = parent_and_name(admin_path)?;
        let admin = open_dir_at(&admin_parent, &admin_name)?;
        if identity(&admin)? != (admin_dev, admin_ino) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Git administration identity changed",
            ));
        }

        let worktree_backlink = read_regular_file_at(&worktree, c".git")?;
        let admin_backlink = read_regular_file_at(&admin, c"gitdir")?;
        if worktree_backlink.trim_end() != format!("gitdir: {}", admin_path.display())
            || admin_backlink.trim_end() != worktree_path.join(".git").display().to_string()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Git worktree backlinks do not match",
            ));
        }

        remove_contents(&worktree, worktree_dev)?;
        require_named_identity(
            &worktree_parent,
            &worktree_name,
            (worktree_dev, worktree_ino),
        )?;
        unlink_at(&worktree_parent, &worktree_name, libc::AT_REMOVEDIR)?;

        // This removes only the matching worktree's administration directory.
        // Do not run `git worktree remove` on the now-replaceable pathname.
        remove_contents(&admin, admin_dev)?;
        require_named_identity(&admin_parent, &admin_name, (admin_dev, admin_ino))?;
        unlink_at(&admin_parent, &admin_name, libc::AT_REMOVEDIR)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{MetadataExt, symlink};

        fn fixture(label: &str) -> std::path::PathBuf {
            let path = std::env::temp_dir().join(format!(
                "workjet-safe-removal-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        #[test]
        fn unlinks_nested_symlink_without_touching_outside() {
            let root = fixture("nested");
            let target = root.join("worker");
            let outside = root.join("outside");
            std::fs::create_dir(&target).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("sentinel"), b"keep").unwrap();
            symlink(&outside, target.join("redirect")).unwrap();
            let metadata = std::fs::metadata(&target).unwrap();
            remove_verified_directory(&target, metadata.dev(), metadata.ino()).unwrap();
            assert!(!target.exists());
            assert!(outside.join("sentinel").exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn swapped_checkout_symlink_never_removes_outside() {
            let root = fixture("swap");
            let target = root.join("worker");
            let moved = root.join("moved-worker");
            let outside = root.join("outside");
            std::fs::create_dir(&target).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(target.join("owned"), b"merged").unwrap();
            std::fs::write(outside.join("sentinel"), b"keep").unwrap();
            let metadata = std::fs::metadata(&target).unwrap();
            let result = remove_with_hook(&target, metadata.dev(), metadata.ino(), || {
                std::fs::rename(&target, &moved).unwrap();
                symlink(&outside, &target).unwrap();
            });
            assert!(result.is_err());
            assert!(outside.join("sentinel").exists());
            assert!(moved.exists());
            std::fs::remove_file(&target).unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn swapped_checkout_directory_never_removes_replacement() {
            let root = fixture("replacement");
            let target = root.join("worker");
            let moved = root.join("moved-worker");
            std::fs::create_dir(&target).unwrap();
            std::fs::write(target.join("owned"), b"merged").unwrap();
            let metadata = std::fs::metadata(&target).unwrap();
            let result = remove_with_hook(&target, metadata.dev(), metadata.ino(), || {
                std::fs::rename(&target, &moved).unwrap();
                std::fs::create_dir(&target).unwrap();
            });
            assert!(result.is_err());
            assert!(target.is_dir());
            assert!(moved.is_dir());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn refuses_changed_identity_and_symlinked_ancestor() {
            let root = fixture("identity");
            let trusted = root.join("trusted");
            let target = trusted.join("worker");
            let outside = root.join("outside");
            std::fs::create_dir(&trusted).unwrap();
            std::fs::create_dir(&target).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::create_dir(outside.join("worker")).unwrap();
            std::fs::write(outside.join("worker/sentinel"), b"keep").unwrap();
            let metadata = std::fs::metadata(&target).unwrap();
            assert!(
                remove_verified_directory(&target, metadata.dev(), metadata.ino() + 1).is_err()
            );
            assert!(target.exists());
            std::fs::rename(&trusted, root.join("moved-trusted")).unwrap();
            symlink(&outside, &trusted).unwrap();
            assert!(remove_verified_directory(&target, metadata.dev(), metadata.ino()).is_err());
            assert!(outside.join("worker/sentinel").exists());
            std::fs::remove_file(&trusted).unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn removes_only_matching_worktree_and_git_admin_directories() {
            let root = fixture("worktree-admin");
            let worktree = root.join("storage/worker");
            let admin = root.join("repo/.git/worktrees/worker");
            let outside = root.join("outside");
            std::fs::create_dir_all(&worktree).unwrap();
            std::fs::create_dir_all(&admin).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(
                worktree.join(".git"),
                format!("gitdir: {}\n", admin.display()),
            )
            .unwrap();
            std::fs::write(
                admin.join("gitdir"),
                format!("{}\n", worktree.join(".git").display()),
            )
            .unwrap();
            std::fs::write(worktree.join("tracked"), b"merged").unwrap();
            std::fs::write(outside.join("sentinel"), b"keep").unwrap();
            symlink(&outside, worktree.join("redirect")).unwrap();
            let worktree_stat = std::fs::metadata(&worktree).unwrap();
            let admin_stat = std::fs::metadata(&admin).unwrap();

            remove_verified_worktree_and_admin(
                &worktree,
                worktree_stat.dev(),
                worktree_stat.ino(),
                &admin,
                admin_stat.dev(),
                admin_stat.ino(),
            )
            .unwrap();

            assert!(!worktree.exists());
            assert!(!admin.exists());
            assert!(outside.join("sentinel").exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn refuses_forged_clean_backlink_through_swapped_worktree_symlink() {
            let root = fixture("forged-backlink");
            let worktree = root.join("storage/worker");
            let admin = root.join("repo/.git/worktrees/worker");
            let outside = root.join("outside");
            std::fs::create_dir_all(&worktree).unwrap();
            std::fs::create_dir_all(&admin).unwrap();
            std::fs::create_dir(&outside).unwrap();
            let backlink = format!("gitdir: {}\n", admin.display());
            std::fs::write(worktree.join(".git"), &backlink).unwrap();
            std::fs::write(
                admin.join("gitdir"),
                format!("{}\n", worktree.join(".git").display()),
            )
            .unwrap();
            std::fs::write(worktree.join("tracked"), b"merged").unwrap();
            let worktree_stat = std::fs::metadata(&worktree).unwrap();
            let admin_stat = std::fs::metadata(&admin).unwrap();

            std::fs::write(outside.join(".git"), backlink).unwrap();
            std::fs::write(outside.join("tracked"), b"keep").unwrap();
            std::fs::remove_dir_all(&worktree).unwrap();
            symlink(&outside, &worktree).unwrap();
            assert!(
                remove_verified_worktree_and_admin(
                    &worktree,
                    worktree_stat.dev(),
                    worktree_stat.ino(),
                    &admin,
                    admin_stat.dev(),
                    admin_stat.ino(),
                )
                .is_err()
            );
            assert_eq!(std::fs::read(outside.join("tracked")).unwrap(), b"keep");
            assert!(admin.exists());
            std::fs::remove_file(&worktree).unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn remove_verified_directory(
    path: &Path,
    expected_dev: u64,
    expected_ino: u64,
) -> io::Result<()> {
    unix::remove_verified_directory(path, expected_dev, expected_ino)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn remove_verified_directory(
    _path: &Path,
    _expected_dev: u64,
    _expected_ino: u64,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "safe worktree removal is unavailable on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn remove_verified_worktree_and_admin(
    worktree_path: &Path,
    worktree_dev: u64,
    worktree_ino: u64,
    admin_path: &Path,
    admin_dev: u64,
    admin_ino: u64,
) -> io::Result<()> {
    unix::remove_verified_worktree_and_admin(
        worktree_path,
        worktree_dev,
        worktree_ino,
        admin_path,
        admin_dev,
        admin_ino,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn remove_verified_worktree_and_admin(
    _worktree_path: &Path,
    _worktree_dev: u64,
    _worktree_ino: u64,
    _admin_path: &Path,
    _admin_dev: u64,
    _admin_ino: u64,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "safe Git worktree removal is unavailable on this platform",
    ))
}
