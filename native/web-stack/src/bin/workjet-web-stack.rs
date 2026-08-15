use anyhow::{Context, Result};
use ctox_web_stack::{
    assert_browser_egress_url_with_context, browser_doctor_report_with_context,
    browser_egress_allow_hosts_from_context, prepare_browser_environment_with_context,
    run_web_search_tool_with_context, spawn_persistent_browser_with_context, BrowserPrepareOptions,
    CanonicalWebSearchRequest, PersistentBrowserSpawn, WebStackContext, WorkjetRuntimeConfigStore,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SEARCH_SURFACE_VERSION: &str = "workjet-web-stack-json-v1";
const BROWSER_SURFACE_VERSION: &str = "workjet-web-stack-browser-json-v1";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_ACTIONS: usize = 32;
const MAX_URL_CHARS: usize = 8_000;
const MAX_TARGET_CHARS: usize = 2_000;
const MAX_ROLE_CHARS: usize = 200;
const MAX_VALUE_CHARS: usize = 8_000;
const MAX_KEY_CHARS: usize = 200;
const MAX_OBSERVATIONS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 8_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const FIXED_ERROR: &str = "workjet-web-stack request failed";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestEnvelope<T> {
    request: T,
    #[serde(default)]
    config: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BrowserPrepareRequest {
    #[serde(default)]
    install_reference: bool,
    #[serde(default)]
    install_browser: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum BrowserTarget {
    Selector(SelectorTarget),
    TestId(TestIdTarget),
    Role(RoleTarget),
    Label(LabelTarget),
    Placeholder(PlaceholderTarget),
    Text(TextTarget),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SelectorTarget {
    selector: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TestIdTarget {
    test_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RoleTarget {
    role: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LabelTarget {
    label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PlaceholderTarget {
    placeholder: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TextTarget {
    text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum BrowserAction {
    Navigate {
        url: String,
    },
    Observe {},
    Click {
        target: BrowserTarget,
    },
    Fill {
        target: BrowserTarget,
        value: String,
    },
    Press {
        target: BrowserTarget,
        key: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BrowserAutomationRequest {
    actions: Vec<BrowserAction>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPrepareResponse {
    ok: bool,
    ready: bool,
    dependency_installed: bool,
    browser_installed: bool,
    install_attempted: bool,
    dependency_install_ran: bool,
    browser_install_ran: bool,
    reason: &'static str,
}

#[derive(Debug, Serialize)]
struct BrowserAutomationResponse {
    ok: bool,
    observations: Vec<BrowserObservation>,
}

#[derive(Debug, Serialize)]
struct BrowserObservation {
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

enum Command {
    SearchSurfaceVersion,
    BrowserSurfaceVersion,
    Search { root: PathBuf },
    BrowserPrepare { root: PathBuf },
    BrowserAutomate { root: PathBuf },
}

fn main() {
    if run(
        std::env::args().skip(1),
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        execute_search,
        execute_browser_prepare,
        execute_browser_automation,
    )
    .is_err()
    {
        eprintln!("{FIXED_ERROR}");
        std::process::exit(1);
    }
}

fn run<I, R, W, FS, FP, FA>(
    args: I,
    input: R,
    mut output: W,
    execute_search: FS,
    execute_prepare: FP,
    execute_automation: FA,
) -> Result<()>
where
    I: IntoIterator<Item = String>,
    R: Read,
    W: Write,
    FS: FnOnce(&Path, RequestEnvelope<SearchRequest>) -> Result<Value>,
    FP: FnOnce(&Path, RequestEnvelope<BrowserPrepareRequest>) -> Result<Value>,
    FA: FnOnce(&Path, RequestEnvelope<BrowserAutomationRequest>) -> Result<Value>,
{
    let value = match parse_command(args)? {
        Command::SearchSurfaceVersion => {
            writeln!(output, "{SEARCH_SURFACE_VERSION}").context("surface output failed")?;
            return Ok(());
        }
        Command::BrowserSurfaceVersion => {
            writeln!(output, "{BROWSER_SURFACE_VERSION}").context("surface output failed")?;
            return Ok(());
        }
        Command::Search { root } => execute_search(&root, read_request(input)?)?,
        Command::BrowserPrepare { root } => execute_prepare(&root, read_request(input)?)?,
        Command::BrowserAutomate { root } => {
            let envelope = read_request(input)?;
            validate_browser_automation_request(&envelope.request)?;
            execute_automation(&root, envelope)?
        }
    };
    serde_json::to_writer(&mut output, &value).context("response encoding failed")?;
    writeln!(output).context("response output failed")?;
    Ok(())
}

fn parse_command<I>(args: I) -> Result<Command>
where
    I: IntoIterator<Item = String>,
{
    let args = args.into_iter().collect::<Vec<_>>();
    match args.as_slice() {
        [flag] if flag == "--surface-version" => Ok(Command::SearchSurfaceVersion),
        [flag] if flag == "--browser-surface-version" => Ok(Command::BrowserSurfaceVersion),
        [command, root_flag, root]
            if matches!(
                command.as_str(),
                "search" | "browser-prepare" | "browser-automate"
            ) && root_flag == "--root" =>
        {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                anyhow::bail!("invalid invocation");
            }
            match command.as_str() {
                "search" => Ok(Command::Search { root }),
                "browser-prepare" => Ok(Command::BrowserPrepare { root }),
                "browser-automate" => Ok(Command::BrowserAutomate { root }),
                _ => unreachable!(),
            }
        }
        _ => anyhow::bail!("invalid invocation"),
    }
}

fn read_request<R: Read, T: DeserializeOwned>(input: R) -> Result<RequestEnvelope<T>> {
    let mut bytes = Vec::with_capacity(MAX_REQUEST_BYTES.min(8 * 1024));
    input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("request read failed")?;
    if bytes.len() > MAX_REQUEST_BYTES {
        anyhow::bail!("request too large");
    }

    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    let envelope =
        RequestEnvelope::<T>::deserialize(&mut deserializer).context("invalid request")?;
    deserializer
        .end()
        .context("invalid trailing request data")?;
    Ok(envelope)
}

fn char_len(value: &str) -> usize {
    value.chars().count()
}

fn validate_text(value: &str, maximum: usize, allow_empty: bool) -> Result<()> {
    let length = char_len(value);
    if (!allow_empty && value.trim().is_empty()) || length > maximum {
        anyhow::bail!("invalid request");
    }
    Ok(())
}

fn validate_target(target: &BrowserTarget) -> Result<()> {
    match target {
        BrowserTarget::Selector(value) => validate_text(&value.selector, MAX_TARGET_CHARS, false),
        BrowserTarget::TestId(value) => validate_text(&value.test_id, MAX_TARGET_CHARS, false),
        BrowserTarget::Role(value) => {
            validate_text(&value.role, MAX_ROLE_CHARS, false)?;
            validate_text(&value.name, MAX_TARGET_CHARS, false)
        }
        BrowserTarget::Label(value) => validate_text(&value.label, MAX_TARGET_CHARS, false),
        BrowserTarget::Placeholder(value) => {
            validate_text(&value.placeholder, MAX_TARGET_CHARS, false)
        }
        BrowserTarget::Text(value) => validate_text(&value.text, MAX_TARGET_CHARS, false),
    }
}

fn validate_browser_automation_request(request: &BrowserAutomationRequest) -> Result<()> {
    if request.actions.is_empty() || request.actions.len() > MAX_ACTIONS {
        anyhow::bail!("invalid request");
    }
    if let Some(timeout_ms) = request.timeout_ms {
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
            anyhow::bail!("invalid request");
        }
    }
    for action in &request.actions {
        match action {
            BrowserAction::Navigate { url } => validate_text(url, MAX_URL_CHARS, false)?,
            BrowserAction::Observe {} => {}
            BrowserAction::Click { target } => validate_target(target)?,
            BrowserAction::Fill { target, value } => {
                validate_target(target)?;
                validate_text(value, MAX_VALUE_CHARS, true)?;
            }
            BrowserAction::Press { target, key } => {
                validate_target(target)?;
                validate_text(key, MAX_KEY_CHARS, false)?;
            }
        }
    }
    Ok(())
}

fn execute_search(root: &Path, envelope: RequestEnvelope<SearchRequest>) -> Result<Value> {
    if envelope.request.query.trim().is_empty() {
        anyhow::bail!("invalid request");
    }
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    run_web_search_tool_with_context(
        WebStackContext::new(root, &store),
        &CanonicalWebSearchRequest {
            query: envelope.request.query,
            ..CanonicalWebSearchRequest::default()
        },
    )
}

fn execute_browser_prepare(
    root: &Path,
    envelope: RequestEnvelope<BrowserPrepareRequest>,
) -> Result<Value> {
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    let context = WebStackContext::new(root, &store);
    let install_attempted = envelope.request.install_reference || envelope.request.install_browser;
    let report = prepare_browser_environment_with_context(
        context,
        &BrowserPrepareOptions {
            dir: None,
            install_reference: install_attempted,
            install_browser: envelope.request.install_browser,
            skip_npm_install: false,
        },
    )?;
    let doctor = report.get("doctor").unwrap_or(&Value::Null);
    let install = report.get("install").unwrap_or(&Value::Null);
    let ready = doctor
        .get("automation_ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let dependency_installed = doctor
        .get("runner_dependency_installed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let browser_installed = doctor
        .get("runner_browser_installed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runtime_available = doctor
        .get("node_version_compatible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reason = if ready {
        "ready"
    } else if !runtime_available {
        "runtime-unavailable"
    } else if !dependency_installed {
        "dependency-missing"
    } else if !browser_installed {
        "browser-missing"
    } else {
        "not-ready"
    };
    Ok(serde_json::to_value(BrowserPrepareResponse {
        ok: true,
        ready,
        dependency_installed,
        browser_installed,
        install_attempted,
        dependency_install_ran: install
            .get("npm_install_ran")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        browser_install_ran: install
            .get("browser_install_ran")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reason,
    })?)
}

fn browser_is_ready(context: WebStackContext<'_>) -> Result<bool> {
    Ok(browser_doctor_report_with_context(context, None)?
        .get("automation_ready")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn hex_encode(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn build_browser_action_source(actions: &[BrowserAction], timeout_ms: u64) -> Result<String> {
    let encoded_actions = hex_encode(&serde_json::to_vec(actions)?);
    Ok(format!(
        r#"const actionHex = "{encoded_actions}";
const actions = JSON.parse(new TextDecoder().decode(Uint8Array.from(actionHex.match(/../g) || [], (pair) => Number.parseInt(pair, 16))));
const observations = [];
const remember = (action, observed) => {{
  const description = JSON.stringify({{
    action,
    title: observed && typeof observed.title === "string" ? observed.title : "",
    documentText: observed && typeof observed.documentText === "string" ? observed.documentText : "",
    targets: observed && Array.isArray(observed.targets) ? observed.targets : [],
  }});
  const entry = {{ description }};
  if (observed && typeof observed.url === "string" && observed.url) entry.url = observed.url;
  observations.push(entry);
}};
for (const action of actions) {{
  let observed;
  if (action.action === "navigate") observed = await ctoxBrowser.goto(action.url, {{ timeoutMs: {timeout_ms}, limit: 80, textMax: 400 }});
  else if (action.action === "observe") observed = await ctoxBrowser.observe({{ limit: 80, textMax: 400 }});
  else if (action.action === "click") observed = await ctoxBrowser.click(action.target, {{ timeout: {timeout_ms}, limit: 80, textMax: 400 }});
  else if (action.action === "fill") observed = await ctoxBrowser.fill(action.target, action.value, {{ timeout: {timeout_ms}, limit: 80, textMax: 400 }});
  else if (action.action === "press") observed = await ctoxBrowser.press(action.target, action.key, {{ timeout: {timeout_ms}, limit: 80, textMax: 400 }});
  else throw new Error("unsupported browser action");
  remember(action.action, observed);
}}
return observations;"#
    ))
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn normalize_browser_automation_response(value: Value) -> Result<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("browser automation failed");
    }
    let raw = value
        .get("result")
        .and_then(Value::as_array)
        .context("browser automation response missing observations")?;
    let mut observations = Vec::new();
    for item in raw.iter().take(MAX_OBSERVATIONS) {
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .context("browser automation response has invalid observation")?;
        let url = match item.get("url") {
            Some(Value::String(value)) if !value.is_empty() => {
                Some(truncate_chars(value, MAX_URL_CHARS))
            }
            Some(Value::String(_)) | None => None,
            _ => anyhow::bail!("browser automation response has invalid observation URL"),
        };
        observations.push(BrowserObservation {
            description: truncate_chars(description, MAX_DESCRIPTION_CHARS),
            url,
        });
    }
    Ok(serde_json::to_value(BrowserAutomationResponse {
        ok: true,
        observations,
    })?)
}

fn execute_browser_automation(
    root: &Path,
    envelope: RequestEnvelope<BrowserAutomationRequest>,
) -> Result<Value> {
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    let context = WebStackContext::new(root, &store);
    if !browser_is_ready(context)? {
        anyhow::bail!("browser runtime is not ready");
    }
    for action in &envelope.request.actions {
        if let BrowserAction::Navigate { url } = action {
            assert_browser_egress_url_with_context(context, url)?;
        }
    }
    let timeout_ms = envelope
        .request
        .timeout_ms
        .unwrap_or(30_000)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let source = build_browser_action_source(&envelope.request.actions, timeout_ms)?;
    let mut browser = spawn_persistent_browser_with_context(
        context,
        &PersistentBrowserSpawn {
            dir: None,
            viewport_w: 1280,
            viewport_h: 720,
            profile_dir: None,
            private_profile: true,
            egress_allow_hosts: browser_egress_allow_hosts_from_context(context),
            downloads_dir: None,
        },
    )?;
    let result = browser.request_with_timeout(
        "automation",
        json!({ "source": source, "timeoutMs": timeout_ms }),
        Duration::from_millis(timeout_ms.saturating_add(5_000)),
    );
    browser.shutdown();
    normalize_browser_automation_response(result?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;

    fn absolute_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "workjet-web-stack-boundary-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    fn unused_search(_: &Path, _: RequestEnvelope<SearchRequest>) -> Result<Value> {
        panic!("search must not run")
    }

    fn unused_prepare(_: &Path, _: RequestEnvelope<BrowserPrepareRequest>) -> Result<Value> {
        panic!("prepare must not run")
    }

    fn unused_automation(_: &Path, _: RequestEnvelope<BrowserAutomationRequest>) -> Result<Value> {
        panic!("automation must not run")
    }

    #[test]
    fn exact_surface_probes_reject_extra_arguments() {
        for (args, expected) in [
            (
                ["--surface-version"],
                b"workjet-web-stack-json-v1\n".as_slice(),
            ),
            (
                ["--browser-surface-version"],
                b"workjet-web-stack-browser-json-v1\n".as_slice(),
            ),
        ] {
            let mut output = Vec::new();
            run(
                args.map(str::to_string),
                Cursor::new(Vec::<u8>::new()),
                &mut output,
                unused_search,
                unused_prepare,
                unused_automation,
            )
            .expect("surface probe");
            assert_eq!(output, expected);
        }
        assert!(
            parse_command(["--browser-surface-version".to_string(), "extra".to_string()]).is_err()
        );
    }

    #[test]
    fn commands_require_absolute_root_and_one_strict_bounded_envelope() {
        for command in ["search", "browser-prepare", "browser-automate"] {
            assert!(parse_command([
                command.to_string(),
                "--root".to_string(),
                "relative/root".to_string(),
            ])
            .is_err());
        }

        let valid: RequestEnvelope<SearchRequest> =
            read_request(Cursor::new(br#"{"request":{"query":" rust "}}   "#))
                .expect("valid request");
        assert_eq!(valid.request.query, " rust ");
        assert!(valid.config.is_empty());

        for invalid in [
            br#"{"request":{"query":"rust"}} {}"#.as_slice(),
            br#"{"request":{"query":7}}"#.as_slice(),
            br#"{"request":{"query":"rust"},"unknown":true}"#.as_slice(),
        ] {
            assert!(read_request::<_, SearchRequest>(Cursor::new(invalid)).is_err());
        }
        let oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
        assert!(read_request::<_, SearchRequest>(Cursor::new(oversized)).is_err());
    }

    #[test]
    fn browser_decoder_rejects_source_unknown_actions_paths_and_invalid_targets() {
        let invalid = [
            br#"{"request":{"source":"return process.env"}}"#.as_slice(),
            br#"{"request":{"actions":[{"action":"evaluate","source":"1+1"}]}}"#.as_slice(),
            br#"{"request":{"actions":[{"action":"observe","dir":"/tmp"}]}}"#.as_slice(),
            br#"{"request":{"actions":[{"action":"click","target":{"role":"button"}}]}}"#.as_slice(),
            br##"{"request":{"actions":[{"action":"click","target":{"selector":"#x","text":"x"}}]}}"##.as_slice(),
        ];
        for (index, raw) in invalid.into_iter().enumerate() {
            assert!(
                read_request::<_, BrowserAutomationRequest>(Cursor::new(raw)).is_err(),
                "invalid case {index} decoded"
            );
        }

        let too_many = json!({
            "request": { "actions": (0..33).map(|_| json!({"action":"observe"})).collect::<Vec<_>>() }
        });
        let request: RequestEnvelope<BrowserAutomationRequest> =
            read_request(Cursor::new(serde_json::to_vec(&too_many).expect("encode")))
                .expect("decode shape");
        assert!(validate_browser_automation_request(&request.request).is_err());
    }

    #[test]
    fn generated_source_encodes_every_caller_string_as_inert_hex_json() {
        let marker = r#"\"); globalThis.pwned = process.env.SECRET; //"#;
        let actions = vec![
            BrowserAction::Navigate {
                url: format!("https://example.test/{marker}"),
            },
            BrowserAction::Fill {
                target: BrowserTarget::Selector(SelectorTarget {
                    selector: marker.to_string(),
                }),
                value: marker.to_string(),
            },
            BrowserAction::Press {
                target: BrowserTarget::Text(TextTarget {
                    text: marker.to_string(),
                }),
                key: marker.to_string(),
            },
        ];
        let source = build_browser_action_source(&actions, 30_000).expect("source");
        assert!(!source.contains(marker));
        assert!(!source.contains("process.env.SECRET"));
        let prefix = "const actionHex = \"";
        let encoded = source
            .strip_prefix(prefix)
            .and_then(|rest| rest.split_once("\";\n"))
            .map(|(value, _)| value)
            .expect("encoded action literal");
        let bytes = encoded
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).expect("hex pair"), 16)
                    .expect("hex byte")
            })
            .collect::<Vec<_>>();
        let decoded: Vec<BrowserAction> = serde_json::from_slice(&bytes).expect("actions");
        assert_eq!(decoded, actions);
    }

    #[test]
    fn browser_response_is_bounded_and_drops_native_fields() {
        let raw = json!({
            "ok": true,
            "result": (0..205).map(|index| json!({
                "description": if index == 0 { "d".repeat(MAX_DESCRIPTION_CHARS + 1) } else { format!("observed {index}") },
                "url": format!("https://example.test/{index}"),
                "nativePath": "/private/browser/profile"
            })).collect::<Vec<_>>(),
            "logs": ["secret"],
            "nav": {"profile": "/private/browser/profile"}
        });
        let normalized = normalize_browser_automation_response(raw).expect("normalize");
        let observations = normalized["observations"].as_array().expect("observations");
        assert_eq!(observations.len(), MAX_OBSERVATIONS);
        assert_eq!(
            observations[0]["description"]
                .as_str()
                .expect("description")
                .chars()
                .count(),
            MAX_DESCRIPTION_CHARS
        );
        assert!(normalized.get("logs").is_none());
        assert!(!normalized.to_string().contains("/private/browser/profile"));
    }

    #[test]
    fn workjet_browser_prepare_isolated_from_ctox_sqlite_without_network() {
        let root = absolute_root();
        let database = root.join("runtime/ctox.sqlite3");
        fs::create_dir_all(database.parent().expect("database parent")).expect("runtime dir");
        fs::write(&database, b"not a sqlite database").expect("broken CTOX database");

        let value = execute_browser_prepare(
            &root,
            RequestEnvelope {
                request: BrowserPrepareRequest {
                    install_reference: false,
                    install_browser: false,
                },
                config: BTreeMap::new(),
            },
        )
        .expect("browser preparation probe");
        assert_eq!(value["ok"], true);
        assert_eq!(
            fs::read(&database).expect("CTOX database unchanged"),
            b"not a sqlite database"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_dispatch_keeps_existing_wire_shape() {
        let root = absolute_root();
        let mut output = Vec::new();
        let expected_root = root.clone();
        run(
            [
                "search".to_string(),
                "--root".to_string(),
                root.to_string_lossy().into_owned(),
            ],
            Cursor::new(br#"{"request":{"query":"rust"},"config":{"KEY":"value"}}"#),
            &mut output,
            move |actual_root, envelope| {
                assert_eq!(actual_root, expected_root);
                assert_eq!(envelope.request.query, "rust");
                assert_eq!(
                    envelope.config.get("KEY").map(String::as_str),
                    Some("value")
                );
                Ok(json!({"ok": true, "results": []}))
            },
            unused_prepare,
            unused_automation,
        )
        .expect("search dispatch");
        assert_eq!(output, b"{\"ok\":true,\"results\":[]}\n");
    }
}
