//! Scoped model forwarding inside an already isolated Linux network namespace.
//! This is not native team admission or a filesystem sandbox launcher.
#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::OsString;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    const MAX_CONNECTIONS: usize = 2;
    const IO_INTERVAL: Duration = Duration::from_millis(100);
    const BUFFER_BYTES: usize = 32 * 1024;

    fn invalid(message: &'static str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> io::Result<i32> {
        let socket = PathBuf::from(args.next().ok_or_else(|| invalid("missing model socket"))?);
        let mut integer = || {
            args.next()
                .and_then(|part| part.to_str().and_then(|value| value.parse::<u64>().ok()))
                .ok_or_else(|| invalid("invalid model bridge identity"))
        };
        let device = integer()?;
        let inode = integer()?;
        let port = u16::try_from(integer()?).map_err(|_| invalid("invalid model bridge port"))?;
        let parent_net_device = integer()?;
        let parent_net_inode = integer()?;
        if port < 1024 || args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
            return Err(invalid("invalid model bridge command"));
        }
        let executable = args.next().ok_or_else(|| invalid("missing worker executable"))?;
        if !PathBuf::from(&executable).is_absolute() {
            return Err(invalid("worker executable must be absolute"));
        }
        let metadata = fs::symlink_metadata(&socket)?;
        if !metadata.file_type().is_socket()
            || metadata.dev() != device
            || metadata.ino() != inode
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "model socket identity changed"));
        }
        let network = fs::metadata("/proc/self/ns/net")?;
        if network.dev() == parent_net_device && network.ino() == parent_net_inode {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "worker network namespace is not isolated"));
        }
        let listener = TcpListener::bind(("127.0.0.1", port))?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let bridge_stop = Arc::clone(&stop);
        let bridge_failed = Arc::clone(&failed);
        let bridge = thread::Builder::new().name("worker-model-bridge".into()).spawn(move || {
            let result = serve(listener, socket, bridge_stop);
            if result.is_err() {
                bridge_failed.store(true, Ordering::Release);
            }
            result
        })?;
        let child = Command::new(executable)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn();
        let status = match child {
            Ok(mut child) => loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) if failed.load(Ordering::Acquire) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break Err(io::Error::other("worker model bridge failed"));
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(25)),
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break Err(error);
                    }
                }
            },
            Err(error) => Err(error),
        };
        stop.store(true, Ordering::Release);
        let result = bridge.join().map_err(|_| io::Error::other("worker model bridge panicked"))?;
        let status = status?;
        result?;
        Ok(status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
    }

    fn serve(listener: TcpListener, socket: PathBuf, stop: Arc<AtomicBool>) -> io::Result<()> {
        let mut connections: Vec<thread::JoinHandle<io::Result<()>>> = Vec::new();
        let mut result = Ok(());
        while !stop.load(Ordering::Acquire) {
            let mut index = 0;
            while index < connections.len() {
                if connections[index].is_finished() {
                    let _ = connections.swap_remove(index).join();
                } else {
                    index += 1;
                }
            }
            match listener.accept() {
                Ok((mut client, _)) => {
                    client.set_write_timeout(Some(IO_INTERVAL))?;
                    if connections.len() >= MAX_CONNECTIONS {
                        let _ = client.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        continue;
                    }
                    let endpoint = socket.clone();
                    let cancelled = Arc::clone(&stop);
                    match thread::Builder::new().name("worker-model-relay".into()).spawn(move || {
                        relay(client, &endpoint, cancelled)
                    }) {
                        Ok(connection) => connections.push(connection),
                        Err(error) => { result = Err(error); break; }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                Err(error) => { result = Err(error); break; }
            }
        }
        stop.store(true, Ordering::Release);
        for connection in connections {
            let _ = connection.join();
        }
        result
    }

    fn relay(client: TcpStream, socket: &PathBuf, stop: Arc<AtomicBool>) -> io::Result<()> {
        let upstream = UnixStream::connect(socket)?;
        client.set_read_timeout(Some(IO_INTERVAL))?;
        client.set_write_timeout(Some(IO_INTERVAL))?;
        upstream.set_read_timeout(Some(IO_INTERVAL))?;
        upstream.set_write_timeout(Some(IO_INTERVAL))?;
        let mut request = client.try_clone()?;
        let mut target = upstream.try_clone()?;
        let local_stop = Arc::new(AtomicBool::new(false));
        let request_stop = Arc::clone(&local_stop);
        let global_stop = Arc::clone(&stop);
        let forward = thread::Builder::new().name("worker-model-request".into()).spawn(move || {
            let result = pump(&mut request, &mut target, &global_stop, &request_stop);
            let _ = target.shutdown(Shutdown::Write);
            if result.is_err() { request_stop.store(true, Ordering::Release); }
            result
        })?;
        let mut response = upstream;
        let mut destination = client;
        let result = pump(&mut response, &mut destination, &stop, &local_stop);
        local_stop.store(true, Ordering::Release);
        let _ = destination.shutdown(Shutdown::Both);
        let _ = response.shutdown(Shutdown::Both);
        let request_result = forward.join().map_err(|_| io::Error::other("worker model relay panicked"))?;
        result?;
        request_result
    }

    fn pump(from: &mut impl Read, to: &mut impl Write, stop: &AtomicBool, local_stop: &AtomicBool) -> io::Result<()> {
        let mut buffer = [0_u8; BUFFER_BYTES];
        while !stop.load(Ordering::Acquire) && !local_stop.load(Ordering::Acquire) {
            match from.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(length) => {
                    let mut written = 0;
                    while written < length && !stop.load(Ordering::Acquire) && !local_stop.load(Ordering::Acquire) {
                        match to.write(&buffer[written..length]) {
                            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "worker model stream closed")),
                            Ok(count) => written += count,
                            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted) => continue,
                            Err(error) => return Err(error),
                        }
                    }
                },
                Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted) => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn rejects_missing_and_invalid_bridge_arguments() {
            assert!(run(Vec::<OsString>::new().into_iter()).is_err());
            assert!(run(["/socket", "not-an-inode"].map(OsString::from).into_iter()).is_err());
            assert!(run(["/socket", "1", "2", "0", "1", "2", "--", "/bin/true"].map(OsString::from).into_iter()).is_err());
        }
    }
}

pub fn run(args: impl Iterator<Item = std::ffi::OsString>) -> std::io::Result<i32> {
    #[cfg(target_os = "linux")]
    { linux::run(args) }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "private worker model bridge requires Linux"))
    }
}
