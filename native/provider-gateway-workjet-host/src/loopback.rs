//! Single-shot loopback redirect listeners for provider OAuth.
//!
//! The identity providers behind `anthropic` and `codex` only accept the exact
//! redirect targets their official CLIs register. Neither of them accepts this
//! host's management listener (arbitrary port, `/management/oauth/<provider>/
//! callback` path), so the host binds a dedicated loopback listener per login
//! that serves precisely the official path and hands the redirect result to the
//! session authority. The listener lives exactly as long as its login: it stops
//! after the first accepted callback, on cancellation, or on the bounded
//! timeout.
//!
//! Nothing here is persisted and nothing is logged: the authorization code
//! travels straight into the pending session's token exchange.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::oauth::HostOAuthAuthority;

/// Bounded lifetime of a loopback redirect listener. A browser tab that is
/// never completed must not keep a privileged fixed port (codex: 1455) bound
/// forever.
const CALLBACK_DEADLINE: Duration = Duration::from_secs(10 * 60);
const MAX_REQUEST_HEAD_BYTES: usize = 8 * 1024;

/// Why a login could not be started on the loopback redirect the provider
/// requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackBindError {
    /// The provider pins a fixed callback port and something else holds it -
    /// most commonly the official CLI's own login server.
    PortUnavailable(u16),
    /// The listener could not be bound or registered with the runtime.
    Unavailable,
}

/// A bound, not yet serving loopback redirect target.
#[derive(Debug)]
pub struct BoundCallback {
    listener: TcpListener,
    redirect_uri: String,
    path: &'static str,
}

impl BoundCallback {
    /// Binds `127.0.0.1:port` (port `0` picks an ephemeral port) and derives
    /// the redirect URI the provider will be asked to redirect to.
    ///
    /// The host part is the literal `localhost`, exactly as the official CLIs
    /// register it; `127.0.0.1` is a different string to an OAuth client's
    /// redirect matcher even though it resolves to the same interface.
    pub fn bind(port: u16, path: &'static str) -> Result<Self, CallbackBindError> {
        debug_assert!(path.starts_with('/'));
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let listener = StdTcpListener::bind(address).map_err(|error| match error.kind() {
            ErrorKind::AddrInUse | ErrorKind::PermissionDenied if port != 0 => {
                CallbackBindError::PortUnavailable(port)
            }
            _ => CallbackBindError::Unavailable,
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|_| CallbackBindError::Unavailable)?;
        let bound_port = listener
            .local_addr()
            .map_err(|_| CallbackBindError::Unavailable)?
            .port();
        let listener =
            TcpListener::from_std(listener).map_err(|_| CallbackBindError::Unavailable)?;
        Ok(Self {
            listener,
            redirect_uri: format!("http://localhost:{bound_port}{path}"),
            path,
        })
    }

    #[must_use]
    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// Serves the redirect until the provider delivers this session's result.
    #[must_use]
    pub fn serve(
        self,
        authority: Arc<HostOAuthAuthority>,
        provider: String,
        state: String,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let _ = tokio::time::timeout(CALLBACK_DEADLINE, async move {
                loop {
                    let Ok((mut stream, peer)) = self.listener.accept().await else {
                        continue;
                    };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    if serve_one(&mut stream, self.path, &authority, &provider, &state).await {
                        break;
                    }
                }
            })
            .await;
        })
    }
}

/// Returns `true` once the session's own redirect has been consumed and the
/// listener may stop.
async fn serve_one(
    stream: &mut TcpStream,
    path: &str,
    authority: &Arc<HostOAuthAuthority>,
    provider: &str,
    state: &str,
) -> bool {
    let Some(target) = read_request_target(stream).await else {
        respond(
            stream,
            400,
            "Sign-in failed",
            "The request could not be read. Start the sign-in again from the CTOX Desktop App.",
        )
        .await;
        return false;
    };
    let (request_path, query) = match target.split_once('?') {
        Some((request_path, query)) => (request_path, query),
        None => (target.as_str(), ""),
    };
    if request_path != path {
        respond(
            stream,
            404,
            "Not found",
            "This address is not part of the sign-in flow.",
        )
        .await;
        return false;
    }
    let mut code = None;
    let mut callback_state = None;
    let mut error = None;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = decode_component(value);
        match key {
            "code" => code = Some(value),
            "state" => callback_state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    if callback_state.as_deref() != Some(state) {
        // A redirect for a different (or missing) session must not complete
        // this one, and must not stop this login's listener either.
        respond(
            stream,
            400,
            "Sign-in failed",
            "This link belongs to a different sign-in session. Start the sign-in again from the CTOX Desktop App.",
        )
        .await;
        return false;
    }
    if code.is_none() && error.is_none() {
        respond(
            stream,
            400,
            "Sign-in failed",
            "The provider returned no authorization result. Start the sign-in again from the CTOX Desktop App.",
        )
        .await;
        return false;
    }
    let recorded = authority
        .record_callback(provider, state, code.as_deref(), error.as_deref())
        .is_ok();
    if recorded {
        respond(
            stream,
            200,
            "Sign-in received",
            "You can close this window and return to the CTOX Desktop App.",
        )
        .await;
    } else {
        respond(
            stream,
            400,
            "Sign-in expired",
            "This sign-in is no longer active. Start it again from the CTOX Desktop App.",
        )
        .await;
    }
    recorded
}

async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > MAX_REQUEST_HEAD_BYTES {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buffer);
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    (method == "GET").then(|| target.to_owned())
}

/// Renders the one page a person actually sees in this flow: the browser tab
/// the provider redirects to. It is the CTOX Desktop App's face for a moment,
/// so it looks like the app — a centered card, the app's name, a clear
/// verdict — instead of an unstyled paragraph. Title and message are
/// compile-time strings from this module, never provider-controlled text, so
/// no escaping question arises.
async fn respond(stream: &mut TcpStream, status: u16, title: &str, message: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let (badge_glyph, badge_class) = if status == 200 {
        ("&#10003;", "ok")
    } else {
        ("&#10005;", "bad")
    };
    let body = format!(
        r##"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTOX Desktop App</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f5; color: #18181b;
  }}
  main {{
    text-align: center; padding: 48px 44px; max-width: 420px; margin: 16px;
    background: #ffffff; border: 1px solid #e4e4e7; border-radius: 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
  }}
  .badge {{
    width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%;
    display: grid; place-items: center; font-size: 26px; line-height: 1;
  }}
  .badge.ok  {{ background: rgba(34, 197, 94, 0.14); color: #16a34a; }}
  .badge.bad {{ background: rgba(239, 68, 68, 0.14); color: #dc2626; }}
  h1 {{ font-size: 18px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; }}
  p  {{ font-size: 14px; line-height: 1.55; color: #71717a; margin: 0; }}
  .app {{
    margin-top: 28px; font-size: 11px; font-weight: 500;
    letter-spacing: 0.1em; text-transform: uppercase; color: #a1a1aa;
  }}
  .logo {{ margin-bottom: 14px; }}
  .logo svg {{ border-radius: 16px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #09090b; color: #fafafa; }}
    main {{ background: #131316; border-color: #27272a; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); }}
    p    {{ color: #a1a1aa; }}
    .badge.ok  {{ background: rgba(34, 197, 94, 0.12); color: #4ade80; }}
    .badge.bad {{ background: rgba(239, 68, 68, 0.12); color: #f87171; }}
    .app {{ color: #52525b; }}
  }}
</style></head><body>
<main>
  <div class="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="20 20 216 216" role="img" aria-label="CTOX" width="64" height="64"> <defs>  <radialGradient id="bg" cx="40%" cy="34%" r="80%">   <stop offset="0" stop-color="#14202f"/>   <stop offset="1" stop-color="#060b12"/>  </radialGradient>  <radialGradient id="chamber" cx="46%" cy="42%" r="70%">   <stop offset="0" stop-color="#0e1a29"/>   <stop offset="0.85" stop-color="#070d16"/>   <stop offset="1" stop-color="#040810"/>  </radialGradient>  <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">   <stop offset="0" stop-color="#e3ecf4"/>   <stop offset="0.45" stop-color="#a3b6c9"/>   <stop offset="1" stop-color="#46586c"/>  </linearGradient>  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">   <stop offset="0" stop-color="#3a4a5d"/>   <stop offset="0.5" stop-color="#141e2b"/>   <stop offset="1" stop-color="#2c3a4b"/>  </linearGradient>  <radialGradient id="cone" cx="40%" cy="36%" r="90%">   <stop offset="0" stop-color="#d7e2ec"/>   <stop offset="0.6" stop-color="#8298ad"/>   <stop offset="1" stop-color="#33455a"/>  </radialGradient> </defs>  <circle cx="128" cy="128" r="96" fill="url(#rim)"/> <circle cx="128" cy="128" r="87" fill="#0a121d"/> <circle cx="128" cy="128" r="85" fill="url(#chamber)"/> <circle cx="128" cy="128" r="96" fill="none" stroke="#aebfd0" stroke-width="1.4" opacity="0.85"/> <circle cx="128" cy="128" r="87" fill="none" stroke="#03070c" stroke-width="2"/> <g transform="rotate(0 128 128)"><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22 A 79.0 79.0 0 0 1 206.81 133.51 C 189.24 119.39 154.10 110.40 134.89 116.98 A 13.0 13.0 0 0 0 121.90 116.52 Z" fill="url(#steel)"/><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22" fill="none" stroke="#f2f7fc" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/></g><g transform="rotate(90 128 128)"><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22 A 79.0 79.0 0 0 1 206.81 133.51 C 189.24 119.39 154.10 110.40 134.89 116.98 A 13.0 13.0 0 0 0 121.90 116.52 Z" fill="url(#steel)"/><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22" fill="none" stroke="#f2f7fc" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/></g><g transform="rotate(180 128 128)"><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22 A 79.0 79.0 0 0 1 206.81 133.51 C 189.24 119.39 154.10 110.40 134.89 116.98 A 13.0 13.0 0 0 0 121.90 116.52 Z" fill="url(#steel)"/><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22" fill="none" stroke="#f2f7fc" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/></g><g transform="rotate(270 128 128)"><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22 A 79.0 79.0 0 0 1 206.81 133.51 C 189.24 119.39 154.10 110.40 134.89 116.98 A 13.0 13.0 0 0 0 121.90 116.52 Z" fill="url(#steel)"/><path d="M 121.90 116.52 C 119.43 93.61 154.76 67.89 188.52 77.22" fill="none" stroke="#f2f7fc" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/></g> <circle cx="128" cy="128" r="18" fill="url(#cone)"/> <circle cx="128" cy="128" r="18" fill="none" stroke="#0a1119" stroke-width="1.2"/> <circle cx="128" cy="128" r="2.6" fill="#1b2836"/></svg></div>
  <div class="badge {badge_class}">{badge_glyph}</div>
  <h1>{title}</h1>
  <p>{message}</p>
  <div class="app">CTOX Desktop App</div>
</main>
</body></html>
"##
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

fn decode_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = (bytes[index + 1] as char).to_digit(16);
                let low = (bytes[index + 2] as char).to_digit(16);
                match (high, low) {
                    (Some(high), Some(low)) => {
                        decoded.push((high * 16 + low) as u8);
                        index += 3;
                    }
                    _ => {
                        decoded.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Percent-decoding helper exposed to this crate's tests so an authorize URL
/// can be inspected without pulling in a URL dependency.
#[cfg(test)]
pub(crate) fn decode_component_for_test(value: &str) -> String {
    decode_component(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_and_plus_escapes() {
        assert_eq!(decode_component("a%20b+c"), "a b c");
        assert_eq!(decode_component("plain"), "plain");
        assert_eq!(decode_component("%zz"), "%zz");
    }

    #[tokio::test]
    async fn binds_localhost_with_the_official_path() {
        let bound = BoundCallback::bind(0, "/auth/callback").unwrap();
        assert!(bound.redirect_uri().starts_with("http://localhost:"));
        assert!(bound.redirect_uri().ends_with("/auth/callback"));
    }

    #[tokio::test]
    async fn reports_a_taken_fixed_port_as_such() {
        let held = BoundCallback::bind(0, "/auth/callback").unwrap();
        let port: u16 = held
            .redirect_uri()
            .trim_start_matches("http://localhost:")
            .trim_end_matches("/auth/callback")
            .parse()
            .unwrap();
        assert_eq!(
            BoundCallback::bind(port, "/auth/callback").unwrap_err(),
            CallbackBindError::PortUnavailable(port)
        );
    }
}
