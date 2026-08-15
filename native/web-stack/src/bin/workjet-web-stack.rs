use anyhow::{Context, Result};
use ctox_web_stack::{
    run_web_search_tool_with_context, CanonicalWebSearchRequest, WebStackContext,
    WorkjetRuntimeConfigStore,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const SURFACE_VERSION: &str = "workjet-web-stack-json-v1";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const FIXED_ERROR: &str = "workjet-web-stack request failed";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestEnvelope {
    request: SearchRequest,
    #[serde(default)]
    config: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
}

enum Command {
    SurfaceVersion,
    Search { root: PathBuf },
}

fn main() {
    if run(
        std::env::args().skip(1),
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        execute_search,
    )
    .is_err()
    {
        eprintln!("{FIXED_ERROR}");
        std::process::exit(1);
    }
}

fn run<I, R, W, F>(args: I, input: R, mut output: W, execute: F) -> Result<()>
where
    I: IntoIterator<Item = String>,
    R: Read,
    W: Write,
    F: FnOnce(&Path, RequestEnvelope) -> Result<Value>,
{
    match parse_command(args)? {
        Command::SurfaceVersion => {
            writeln!(output, "{SURFACE_VERSION}").context("surface output failed")?;
        }
        Command::Search { root } => {
            let envelope = read_request(input)?;
            let value = execute(&root, envelope)?;
            serde_json::to_writer(&mut output, &value).context("response encoding failed")?;
            writeln!(output).context("response output failed")?;
        }
    }
    Ok(())
}

fn parse_command<I>(args: I) -> Result<Command>
where
    I: IntoIterator<Item = String>,
{
    let args = args.into_iter().collect::<Vec<_>>();
    match args.as_slice() {
        [flag] if flag == "--surface-version" => Ok(Command::SurfaceVersion),
        [command, root_flag, root] if command == "search" && root_flag == "--root" => {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                anyhow::bail!("invalid invocation");
            }
            Ok(Command::Search { root })
        }
        _ => anyhow::bail!("invalid invocation"),
    }
}

fn read_request<R: Read>(input: R) -> Result<RequestEnvelope> {
    let mut bytes = Vec::with_capacity(MAX_REQUEST_BYTES.min(8 * 1024));
    input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("request read failed")?;
    if bytes.len() > MAX_REQUEST_BYTES {
        anyhow::bail!("request too large");
    }

    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    let envelope = RequestEnvelope::deserialize(&mut deserializer).context("invalid request")?;
    deserializer
        .end()
        .context("invalid trailing request data")?;
    if envelope.request.query.trim().is_empty() {
        anyhow::bail!("invalid request");
    }
    Ok(envelope)
}

fn execute_search(root: &Path, envelope: RequestEnvelope) -> Result<Value> {
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    run_web_search_tool_with_context(
        WebStackContext::new(root, &store),
        &CanonicalWebSearchRequest {
            query: envelope.request.query,
            ..CanonicalWebSearchRequest::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Cursor;

    fn absolute_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "workjet-web-stack-boundary-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    #[test]
    fn surface_probe_is_exact_and_rejects_extra_arguments() {
        let mut output = Vec::new();
        run(
            ["--surface-version".to_string()],
            Cursor::new(Vec::<u8>::new()),
            &mut output,
            |_, _| panic!("surface probe must not execute search"),
        )
        .expect("surface probe");
        assert_eq!(output, b"workjet-web-stack-json-v1\n");

        assert!(parse_command(["--surface-version".to_string(), "extra".to_string()]).is_err());
        assert!(parse_command(["unknown".to_string()]).is_err());
    }

    #[test]
    fn search_protocol_requires_absolute_root_and_one_strict_request() {
        assert!(parse_command([
            "search".to_string(),
            "--root".to_string(),
            "relative/root".to_string(),
        ])
        .is_err());
        assert!(parse_command(["search".to_string()]).is_err());

        let valid = read_request(Cursor::new(br#"{"request":{"query":" rust "}}   "#))
            .expect("valid request");
        assert_eq!(valid.request.query, " rust ");
        assert!(valid.config.is_empty());

        for invalid in [
            br#"{"request":{"query":" "}}"#.as_slice(),
            br#"{"request":{"query":"rust"}} {}"#.as_slice(),
            br#"{"request":{"query":7}}"#.as_slice(),
            br#"{"request":{"query":"rust"},"unknown":true}"#.as_slice(),
        ] {
            assert!(read_request(Cursor::new(invalid)).is_err());
        }

        let oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
        assert!(read_request(Cursor::new(oversized)).is_err());
    }

    #[test]
    fn dispatch_passes_only_the_parsed_envelope_to_search() {
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
        )
        .expect("search dispatch");
        assert_eq!(output, b"{\"ok\":true,\"results\":[]}\n");
    }

    #[test]
    fn workjet_config_isolated_from_ctox_sqlite_without_network() {
        let root = absolute_root();
        let database = root.join("runtime/ctox.sqlite3");
        fs::create_dir_all(database.parent().expect("database parent")).expect("runtime dir");
        fs::write(&database, b"not a sqlite database").expect("broken CTOX database");

        let envelope = RequestEnvelope {
            request: SearchRequest {
                query: "no network should run".to_string(),
            },
            config: BTreeMap::from([("CTOX_WEB_SEARCH_ENABLED".to_string(), "false".to_string())]),
        };
        let value = execute_search(&root, envelope).expect("disabled Workjet search");
        assert_eq!(value["ok"], false);
        assert_eq!(
            fs::read(&database).expect("CTOX database unchanged"),
            b"not a sqlite database"
        );
        let _ = fs::remove_dir_all(root);
    }
}
