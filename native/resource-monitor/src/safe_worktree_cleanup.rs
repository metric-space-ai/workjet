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
    use std::io::{Read, Write};
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
        // A pinned descriptor is still usable after the checkout is renamed.
        // Reject a replacement before unlinking any original contents, rather
        // than discovering the replacement only after deleting the moved tree.
        // This path check does not fence writes through an already-open file descriptor.
        require_named_identity(&parent, &name, expected)?;
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

        require_named_identity(
            &worktree_parent,
            &worktree_name,
            (worktree_dev, worktree_ino),
        )?;
        require_named_identity(&admin_parent, &admin_name, (admin_dev, admin_ino))?;
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

    fn rename_exclusive(
        from_parent: &OwnedFd,
        from: &CStr,
        to_parent: &OwnedFd,
        to: &CStr,
    ) -> io::Result<()> {
        // Never overwrite a concurrently created recovery destination.
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                from_parent.as_raw_fd(),
                from.as_ptr(),
                to_parent.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                from_parent.as_raw_fd(),
                from.as_ptr(),
                to_parent.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn sync_directory(fd: &OwnedFd) -> io::Result<()> {
        if unsafe { libc::fsync(fd.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    // Rejected dispatches have no durable merge authority. Quarantine keeps
    // every byte, including writes racing the final Git check or still using
    // an open file descriptor. Neither directory's contents are unlinked.
    pub(super) fn quarantine_with_hook(
        worktree_path: &Path,
        worktree_identity: (u64, u64),
        admin_path: &Path,
        admin_identity: (u64, u64),
        head_oid: &str,
        branch_ref: &str,
        before_move: impl FnOnce(),
    ) -> io::Result<()> {
        if admin_path.parent().and_then(Path::file_name) != Some(OsStr::new("worktrees"))
            || admin_path.starts_with(worktree_path)
            || worktree_path.starts_with(admin_path)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid worktree paths",
            ));
        }
        let (worktree_parent, worktree_name) = parent_and_name(worktree_path)?;
        let worktree = open_dir_at(&worktree_parent, &worktree_name)?;
        let (admin_parent, admin_name) = parent_and_name(admin_path)?;
        let admin = open_dir_at(&admin_parent, &admin_name)?;
        if identity(&worktree)? != worktree_identity || identity(&admin)? != admin_identity {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "worktree identity changed",
            ));
        }
        if read_regular_file_at(&worktree, c".git")?.trim_end()
            != format!("gitdir: {}", admin_path.display())
            || read_regular_file_at(&admin, c"gitdir")?.trim_end()
                != worktree_path.join(".git").display().to_string()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Git backlinks changed",
            ));
        }

        let mut recovery_name = worktree_path.file_name().unwrap().to_os_string();
        recovery_name.push(format!(".workjet-rejected-{}", worktree_identity.1));
        let recovery_worktree = worktree_path.with_file_name(&recovery_name);
        let recovery_name = c_name(&recovery_name)?;
        // The admin may live on a different filesystem from its checkout.
        // Each rename stays beside its own source; the receipt links both.
        let common_path = admin_path.parent().and_then(Path::parent).unwrap();
        let (common_parent, common_name) = parent_and_name(common_path)?;
        let common = open_dir_at(&common_parent, &common_name)?;
        let recovery_admin_root = c"workjet-rejected";
        if unsafe { libc::mkdirat(common.as_raw_fd(), recovery_admin_root.as_ptr(), 0o700) } != 0
            && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
        {
            return Err(io::Error::last_os_error());
        }
        let recovery_admin_parent = open_dir_at(&common, recovery_admin_root)?;
        // Persist the new destination parent before unlinking any old name.
        sync_directory(&common)?;
        let mut recovery_admin_name = admin_path.file_name().unwrap().to_os_string();
        recovery_admin_name.push(format!("-{}", admin_identity.1));
        let recovery_admin_path = common_path
            .join("workjet-rejected")
            .join(&recovery_admin_name);
        let recovery_admin_name = c_name(&recovery_admin_name)?;
        let receipt = serde_json::json!({
            "schemaVersion": 1,
            "reason": "rejected-dispatch",
            "originalWorktreePath": worktree_path,
            "originalAdminPath": admin_path,
            "recoveryWorktreePath": recovery_worktree,
            "recoveryAdminPath": recovery_admin_path,
            "originalHeadOid": head_oid,
            "originalBranchRef": branch_ref,
            "worktreeIdentity": { "dev": worktree_identity.0, "ino": worktree_identity.1 },
            "adminIdentity": { "dev": admin_identity.0, "ino": admin_identity.1 },
            "automaticContentDeletion": false,
        });
        let receipt_fd = opened_fd(unsafe {
            libc::openat(
                admin.as_raw_fd(),
                c"workjet-rollback-receipt.json".as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        })?;
        let mut receipt_file = std::fs::File::from(receipt_fd);
        receipt_file.write_all(serde_json::to_string(&receipt)?.as_bytes())?;
        receipt_file.sync_all()?;
        let progress_fd = opened_fd(unsafe {
            libc::openat(
                admin.as_raw_fd(),
                c"workjet-rollback-progress.jsonl".as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        })?;
        let mut progress_file = std::fs::File::from(progress_fd);
        let mut record_phase = |phase: &str| -> io::Result<()> {
            writeln!(progress_file, "{}", serde_json::json!({ "phase": phase }))?;
            progress_file.sync_all()
        };
        record_phase("prepared")?;
        sync_directory(&admin)?;

        before_move();
        require_named_identity(&worktree_parent, &worktree_name, worktree_identity)?;
        rename_exclusive(
            &worktree_parent,
            &worktree_name,
            &worktree_parent,
            &recovery_name,
        )?;
        require_named_identity(&worktree_parent, &recovery_name, worktree_identity)?;
        sync_directory(&worktree_parent)?;
        record_phase("checkout-quarantined")?;
        require_named_identity(&admin_parent, &admin_name, admin_identity)?;
        rename_exclusive(
            &admin_parent,
            &admin_name,
            &recovery_admin_parent,
            &recovery_admin_name,
        )?;
        require_named_identity(&recovery_admin_parent, &recovery_admin_name, admin_identity)?;
        sync_directory(&recovery_admin_parent)?;
        sync_directory(&admin_parent)?;
        sync_directory(&common)?;
        record_phase("checkout-and-admin-quarantined")?;
        Ok(())
    }

    struct IsolatedRepository {
        parent: OwnedFd,
        name: CString,
        worktree: OwnedFd,
        admin: OwnedFd,
    }

    fn reject_shared_metadata(admin: &OwnedFd) -> io::Result<()> {
        let absent = |parent: &OwnedFd, name: &CStr| -> io::Result<()> {
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } == 0
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "shared Git metadata is not isolated",
                ));
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
            Ok(())
        };
        absent(admin, c"commondir")?;
        let objects = open_dir_at(admin, c"objects")?;
        let info = open_dir_at(&objects, c"info")?;
        absent(&info, c"alternates")
    }

    fn open_isolated_repository(
        worktree_path: &Path,
        worktree_identity: (u64, u64),
        admin_path: &Path,
        admin_identity: (u64, u64),
    ) -> io::Result<IsolatedRepository> {
        if admin_path != worktree_path.join(".git") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Git metadata must be inside the isolated worktree",
            ));
        }
        let (parent, name) = parent_and_name(worktree_path)?;
        let worktree = open_dir_at(&parent, &name)?;
        let admin = open_dir_at(&worktree, c".git")?;
        if identity(&worktree)? != worktree_identity || identity(&admin)? != admin_identity {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "isolated worktree identity changed",
            ));
        }
        require_same_device(&worktree, worktree_identity.0)?;
        require_same_device(&admin, worktree_identity.0)?;
        reject_shared_metadata(&admin)?;
        Ok(IsolatedRepository {
            parent,
            name,
            worktree,
            admin,
        })
    }

    pub(super) fn publish_isolated_with_hook(
        worktree_path: &Path,
        worktree_identity: (u64, u64),
        admin_path: &Path,
        admin_identity: (u64, u64),
        destination: &Path,
        before_move: impl FnOnce(),
    ) -> io::Result<()> {
        // Publication is one no-replace rename beside the prepared checkout.
        // The caller persists these identities before issuing this operation.
        if worktree_path.parent() != destination.parent() || worktree_path == destination {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "publication must stay in the same parent",
            ));
        }
        let source =
            open_isolated_repository(worktree_path, worktree_identity, admin_path, admin_identity)?;
        let (destination_parent, destination_name) = parent_and_name(destination)?;
        if identity(&source.parent)? != identity(&destination_parent)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "publication parent changed",
            ));
        }
        before_move();
        require_named_identity(&source.parent, &source.name, worktree_identity)?;
        require_named_identity(&source.worktree, c".git", admin_identity)?;
        reject_shared_metadata(&source.admin)?;
        sync_directory(&source.admin)?;
        sync_directory(&source.worktree)?;
        rename_exclusive(
            &source.parent,
            &source.name,
            &destination_parent,
            &destination_name,
        )?;
        require_named_identity(&destination_parent, &destination_name, worktree_identity)?;
        require_named_identity(&source.worktree, c".git", admin_identity)?;
        sync_directory(&destination_parent)
    }

    pub(super) fn quarantine_isolated_with_hook(
        worktree_path: &Path,
        worktree_identity: (u64, u64),
        admin_path: &Path,
        admin_identity: (u64, u64),
        head_oid: &str,
        branch_ref: &str,
        before_move: impl FnOnce(),
    ) -> io::Result<()> {
        let source =
            open_isolated_repository(worktree_path, worktree_identity, admin_path, admin_identity)?;
        let mut recovery_name = worktree_path.file_name().unwrap().to_os_string();
        recovery_name.push(format!(".workjet-rejected-{}", worktree_identity.1));
        let recovery_worktree = worktree_path.with_file_name(&recovery_name);
        let recovery_admin = recovery_worktree.join(".git");
        let recovery_name = c_name(&recovery_name)?;
        let receipt = serde_json::json!({
            "schemaVersion": 1, "kind": "isolated", "reason": "rejected-dispatch",
            "originalWorktreePath": worktree_path, "originalAdminPath": admin_path,
            "recoveryWorktreePath": recovery_worktree, "recoveryAdminPath": recovery_admin,
            "originalHeadOid": head_oid, "originalBranchRef": branch_ref,
            "worktreeIdentity": { "dev": worktree_identity.0, "ino": worktree_identity.1 },
            "adminIdentity": { "dev": admin_identity.0, "ino": admin_identity.1 },
            "automaticContentDeletion": false,
        });
        let create_receipt = |name: &CStr| -> io::Result<std::fs::File> {
            opened_fd(unsafe {
                libc::openat(
                    source.admin.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            })
            .map(std::fs::File::from)
        };
        let mut receipt_file = create_receipt(c"workjet-rollback-receipt.json")?;
        receipt_file.write_all(serde_json::to_string(&receipt)?.as_bytes())?;
        receipt_file.sync_all()?;
        let mut progress = create_receipt(c"workjet-rollback-progress.jsonl")?;
        writeln!(progress, "{}", serde_json::json!({ "phase": "prepared" }))?;
        progress.sync_all()?;
        sync_directory(&source.admin)?;
        before_move();
        require_named_identity(&source.parent, &source.name, worktree_identity)?;
        require_named_identity(&source.worktree, c".git", admin_identity)?;
        rename_exclusive(&source.parent, &source.name, &source.parent, &recovery_name)?;
        require_named_identity(&source.parent, &recovery_name, worktree_identity)?;
        require_named_identity(&source.worktree, c".git", admin_identity)?;
        sync_directory(&source.parent)?;
        writeln!(
            progress,
            "{}",
            serde_json::json!({ "phase": "checkout-and-admin-quarantined" })
        )?;
        progress.sync_all()
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

        fn isolated_fixture(
            label: &str,
        ) -> (
            std::path::PathBuf,
            std::path::PathBuf,
            (u64, u64),
            (u64, u64),
        ) {
            let root = fixture(label);
            let worker = root.join("prepared");
            std::fs::create_dir_all(worker.join(".git/objects/info")).unwrap();
            std::fs::write(worker.join("tracked"), "original").unwrap();
            let wt = std::fs::metadata(&worker).unwrap();
            let ad = std::fs::metadata(worker.join(".git")).unwrap();
            (root, worker, (wt.dev(), wt.ino()), (ad.dev(), ad.ino()))
        }

        #[test]
        fn isolated_publication_preserves_both_identities_and_never_replaces_destination() {
            let (root, worker, wt, ad) = isolated_fixture("publish-private");
            let destination = root.join("published");
            std::fs::create_dir(&destination).unwrap();
            std::fs::write(destination.join("foreign"), "retained").unwrap();
            assert!(
                publish_isolated_with_hook(
                    &worker,
                    wt,
                    &worker.join(".git"),
                    ad,
                    &destination,
                    || ()
                )
                .is_err()
            );
            assert_eq!(
                std::fs::read_to_string(destination.join("foreign")).unwrap(),
                "retained"
            );
            assert!(worker.join("tracked").exists());
            std::fs::remove_file(destination.join("foreign")).unwrap();
            assert!(
                publish_isolated_with_hook(
                    &worker,
                    wt,
                    &worker.join(".git"),
                    ad,
                    &destination,
                    || ()
                )
                .is_err()
            );
            std::fs::remove_dir(&destination).unwrap();
            publish_isolated_with_hook(&worker, wt, &worker.join(".git"), ad, &destination, || ())
                .unwrap();
            let actual = std::fs::metadata(&destination).unwrap();
            let actual_admin = std::fs::metadata(destination.join(".git")).unwrap();
            assert_eq!((actual.dev(), actual.ino()), wt);
            assert_eq!((actual_admin.dev(), actual_admin.ino()), ad);
            assert!(!worker.exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn isolated_publication_rejects_replaced_root_or_admin() {
            for replace_admin in [false, true] {
                let (root, worker, wt, ad) = isolated_fixture("publish-swap");
                let destination = root.join("published");
                let swap = if replace_admin {
                    worker.join(".git")
                } else {
                    worker.clone()
                };
                let retained = root.join("retained");
                assert!(
                    publish_isolated_with_hook(
                        &worker,
                        wt,
                        &worker.join(".git"),
                        ad,
                        &destination,
                        || {
                            std::fs::rename(&swap, &retained).unwrap();
                            std::fs::create_dir(&swap).unwrap();
                            std::fs::write(swap.join("foreign"), "retained").unwrap();
                        }
                    )
                    .is_err()
                );
                assert!(!destination.exists());
                assert!(retained.exists());
                assert_eq!(
                    std::fs::read_to_string(swap.join("foreign")).unwrap(),
                    "retained"
                );
                std::fs::remove_dir_all(root).unwrap();
            }
        }

        #[test]
        fn isolated_operations_reject_shared_metadata_and_symlinks() {
            for shared in ["commondir", "objects/info/alternates"] {
                let (root, worker, wt, ad) = isolated_fixture("publish-shared");
                std::fs::write(worker.join(".git").join(shared), "/outside").unwrap();
                assert!(
                    publish_isolated_with_hook(
                        &worker,
                        wt,
                        &worker.join(".git"),
                        ad,
                        &root.join("published"),
                        || ()
                    )
                    .is_err()
                );
                assert!(
                    quarantine_isolated_with_hook(
                        &worker,
                        wt,
                        &worker.join(".git"),
                        ad,
                        "head",
                        "ref",
                        || ()
                    )
                    .is_err()
                );
                assert!(worker.join("tracked").exists());
                std::fs::remove_dir_all(root).unwrap();
            }
            let (root, worker, wt, ad) = isolated_fixture("publish-symlink");
            let retained = root.join("retained");
            std::fs::rename(worker.join(".git"), &retained).unwrap();
            symlink(&retained, worker.join(".git")).unwrap();
            assert!(
                publish_isolated_with_hook(
                    &worker,
                    wt,
                    &worker.join(".git"),
                    ad,
                    &root.join("published"),
                    || ()
                )
                .is_err()
            );
            assert!(
                quarantine_isolated_with_hook(
                    &worker,
                    wt,
                    &worker.join(".git"),
                    ad,
                    "head",
                    "ref",
                    || ()
                )
                .is_err()
            );
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn isolated_quarantine_keeps_git_and_late_writes_together() {
            let (root, worker, wt, ad) = isolated_fixture("private-late-write");
            let mut editor = std::fs::OpenOptions::new()
                .append(true)
                .open(worker.join("tracked"))
                .unwrap();
            let recovery = root.join(format!("prepared.workjet-rejected-{}", wt.1));
            quarantine_isolated_with_hook(
                &worker,
                wt,
                &worker.join(".git"),
                ad,
                "original-commit",
                "workjet/worker/one",
                || {
                    std::fs::write(worker.join("late"), "late writer").unwrap();
                },
            )
            .unwrap();
            editor.write_all(b" after rename").unwrap();
            assert_eq!(
                std::fs::read_to_string(recovery.join("tracked")).unwrap(),
                "original after rename"
            );
            assert_eq!(
                std::fs::read_to_string(recovery.join("late")).unwrap(),
                "late writer"
            );
            let receipt: serde_json::Value = serde_json::from_slice(
                &std::fs::read(recovery.join(".git/workjet-rollback-receipt.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                receipt["recoveryAdminPath"],
                recovery.join(".git").to_str().unwrap()
            );
            assert_eq!(receipt["automaticContentDeletion"], false);
            assert!(!worker.exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn isolated_quarantine_collision_keeps_original_and_foreign_data() {
            let (root, worker, wt, ad) = isolated_fixture("private-collision");
            let recovery = root.join(format!("prepared.workjet-rejected-{}", wt.1));
            std::fs::create_dir(&recovery).unwrap();
            std::fs::write(recovery.join("foreign"), "retained").unwrap();
            assert!(
                quarantine_isolated_with_hook(
                    &worker,
                    wt,
                    &worker.join(".git"),
                    ad,
                    "head",
                    "ref",
                    || ()
                )
                .is_err()
            );
            assert_eq!(
                std::fs::read_to_string(recovery.join("foreign")).unwrap(),
                "retained"
            );
            assert_eq!(
                std::fs::read_to_string(worker.join("tracked")).unwrap(),
                "original"
            );
            assert!(worker.join(".git/workjet-rollback-receipt.json").exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn quarantine_preserves_writes_after_the_final_check_and_after_rename() {
            let root = fixture("late-write");
            let worktree = root.join("worker");
            let admin = root.join("repo/.git/worktrees/one");
            std::fs::create_dir_all(&worktree).unwrap();
            std::fs::create_dir_all(&admin).unwrap();
            std::fs::write(
                worktree.join(".git"),
                format!("gitdir: {}\n", admin.display()),
            )
            .unwrap();
            std::fs::write(
                admin.join("gitdir"),
                worktree.join(".git").display().to_string(),
            )
            .unwrap();
            std::fs::write(worktree.join("tracked"), b"original").unwrap();
            let mut open_editor = std::fs::OpenOptions::new()
                .append(true)
                .open(worktree.join("tracked"))
                .unwrap();
            let wt = std::fs::metadata(&worktree).unwrap();
            let ad = std::fs::metadata(&admin).unwrap();
            let recovery = root.join(format!("worker.workjet-rejected-{}", wt.ino()));
            let recovery_admin = root.join(format!("repo/.git/workjet-rejected/one-{}", ad.ino()));
            quarantine_with_hook(
                &worktree,
                (wt.dev(), wt.ino()),
                &admin,
                (ad.dev(), ad.ino()),
                "original-commit",
                "workjet/worker/one",
                || {
                    // This deterministic write occurs after all preflight/identity
                    // checks at the old recursive-deletion boundary.
                    std::fs::write(worktree.join("late-user-file"), b"must survive").unwrap();
                    std::fs::write(admin.join("late-admin-file"), b"keep metadata too").unwrap();
                },
            )
            .unwrap();
            open_editor.write_all(b"-after-rename").unwrap();
            open_editor.sync_all().unwrap();
            assert!(!worktree.exists());
            assert!(!admin.exists());
            assert_eq!(
                std::fs::read(recovery.join("late-user-file")).unwrap(),
                b"must survive"
            );
            assert_eq!(
                std::fs::read(recovery.join("tracked")).unwrap(),
                b"original-after-rename"
            );
            assert_eq!(
                std::fs::read(recovery_admin.join("late-admin-file")).unwrap(),
                b"keep metadata too"
            );
            let receipt: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(recovery_admin.join("workjet-rollback-receipt.json"))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(receipt["originalHeadOid"], "original-commit");
            assert_eq!(receipt["originalBranchRef"], "workjet/worker/one");
            assert_eq!(receipt["recoveryWorktreePath"], recovery.to_str().unwrap());
            assert_eq!(receipt["originalAdminPath"], admin.to_str().unwrap());
            assert!(
                std::fs::read_to_string(recovery_admin.join("workjet-rollback-progress.jsonl"))
                    .unwrap()
                    .contains("checkout-and-admin-quarantined")
            );
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn quarantine_records_partial_move_without_overwriting_recovery() {
            let root = fixture("partial-quarantine");
            let worktree = root.join("worker");
            let admin = root.join("repo/.git/worktrees/one");
            std::fs::create_dir_all(&worktree).unwrap();
            std::fs::create_dir_all(&admin).unwrap();
            std::fs::write(
                worktree.join(".git"),
                format!("gitdir: {}\n", admin.display()),
            )
            .unwrap();
            std::fs::write(
                admin.join("gitdir"),
                worktree.join(".git").display().to_string(),
            )
            .unwrap();
            std::fs::write(worktree.join("user-file"), b"preserve").unwrap();
            let wt = std::fs::metadata(&worktree).unwrap();
            let ad = std::fs::metadata(&admin).unwrap();
            let recovery = root.join(format!("worker.workjet-rejected-{}", wt.ino()));
            let recovery_admin = root.join(format!("repo/.git/workjet-rejected/one-{}", ad.ino()));
            let result = quarantine_with_hook(
                &worktree,
                (wt.dev(), wt.ino()),
                &admin,
                (ad.dev(), ad.ino()),
                "original-commit",
                "workjet/worker/one",
                || {
                    std::fs::create_dir(&recovery_admin).unwrap();
                    std::fs::write(recovery_admin.join("sentinel"), b"not ours").unwrap();
                },
            );
            assert!(result.is_err());
            assert!(!worktree.exists());
            assert!(admin.exists());
            assert_eq!(
                std::fs::read(recovery.join("user-file")).unwrap(),
                b"preserve"
            );
            assert_eq!(
                std::fs::read(recovery_admin.join("sentinel")).unwrap(),
                b"not ours"
            );
            let receipt: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(admin.join("workjet-rollback-receipt.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(receipt["originalAdminPath"], admin.to_str().unwrap());
            assert_eq!(receipt["recoveryWorktreePath"], recovery.to_str().unwrap());
            let progress =
                std::fs::read_to_string(admin.join("workjet-rollback-progress.jsonl")).unwrap();
            assert!(progress.contains("checkout-quarantined"));
            assert!(!progress.contains("checkout-and-admin-quarantined"));
            std::fs::remove_dir_all(root).unwrap();
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
            assert_eq!(std::fs::read(moved.join("owned")).unwrap(), b"merged");
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
            assert_eq!(std::fs::read(moved.join("owned")).unwrap(), b"merged");
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

        #[test]
        fn removes_a_real_git_worktree_and_its_exact_registration() {
            use std::process::Command;

            let root = std::fs::canonicalize(fixture("real-git")).unwrap();
            let repo = root.join("repo");
            let worktree = root.join("worker");
            let run = |args: &[&str]| {
                let output = Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(args)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "git {:?}: {}",
                    args,
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout).unwrap()
            };
            Command::new("git")
                .args(["init", "-q", "--initial-branch=main"])
                .arg(&repo)
                .status()
                .unwrap();
            run(&["config", "user.name", "Workjet test"]);
            run(&["config", "user.email", "workjet-test@example.invalid"]);
            std::fs::write(repo.join("file"), b"merged").unwrap();
            run(&["add", "file"]);
            run(&["-c", "commit.gpgsign=false", "commit", "-qm", "initial"]);
            let output = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["worktree", "add", "-q", "-b", "worker"])
                .arg(&worktree)
                .output()
                .unwrap();
            assert!(output.status.success());
            let backlink = std::fs::read_to_string(worktree.join(".git")).unwrap();
            let admin = std::path::PathBuf::from(backlink.trim().strip_prefix("gitdir: ").unwrap());
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
            assert!(
                !run(&["worktree", "list", "--porcelain"])
                    .contains(&worktree.display().to_string())
            );
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn quarantine_rejected_worktree(
    worktree_path: &Path,
    worktree_identity: (u64, u64),
    admin_path: &Path,
    admin_identity: (u64, u64),
    head_oid: &str,
    branch_ref: &str,
) -> io::Result<()> {
    unix::quarantine_with_hook(
        worktree_path,
        worktree_identity,
        admin_path,
        admin_identity,
        head_oid,
        branch_ref,
        || (),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn quarantine_rejected_worktree(
    _worktree_path: &Path,
    _worktree_identity: (u64, u64),
    _admin_path: &Path,
    _admin_identity: (u64, u64),
    _head_oid: &str,
    _branch_ref: &str,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "worktree quarantine is unavailable on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn publish_isolated_worktree(
    worktree_path: &Path,
    worktree_identity: (u64, u64),
    admin_path: &Path,
    admin_identity: (u64, u64),
    destination: &Path,
) -> io::Result<()> {
    unix::publish_isolated_with_hook(
        worktree_path,
        worktree_identity,
        admin_path,
        admin_identity,
        destination,
        || (),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn publish_isolated_worktree(
    _worktree_path: &Path,
    _worktree_identity: (u64, u64),
    _admin_path: &Path,
    _admin_identity: (u64, u64),
    _destination: &Path,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "isolated worktree publication is unavailable on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn quarantine_isolated_worktree(
    worktree_path: &Path,
    worktree_identity: (u64, u64),
    admin_path: &Path,
    admin_identity: (u64, u64),
    head_oid: &str,
    branch_ref: &str,
) -> io::Result<()> {
    unix::quarantine_isolated_with_hook(
        worktree_path,
        worktree_identity,
        admin_path,
        admin_identity,
        head_oid,
        branch_ref,
        || (),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn quarantine_isolated_worktree(
    _worktree_path: &Path,
    _worktree_identity: (u64, u64),
    _admin_path: &Path,
    _admin_identity: (u64, u64),
    _head_oid: &str,
    _branch_ref: &str,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "isolated worktree quarantine is unavailable on this platform",
    ))
}
