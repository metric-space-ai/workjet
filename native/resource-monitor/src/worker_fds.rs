//! Extra descriptors must never carry host filesystem authority into a worker.
#[cfg(target_os = "linux")]
pub fn close_inherited() -> std::io::Result<()> {
    // This command is entered before threads or worker-owned descriptors exist.
    if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ENOSYS) {
        return Err(error);
    }
    let descriptors = std::fs::read_dir("/proc/self/fd")?
        .map(|entry| {
            entry?.file_name().to_str().and_then(|name| name.parse::<i32>().ok())
                .ok_or_else(|| std::io::Error::other("invalid process descriptor"))
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    for fd in descriptors.into_iter().filter(|fd| *fd >= 3) {
        unsafe { libc::close(fd) };
    }
    Ok(())
}
