use anyhow::{Context, Result};
use ctox_web_stack::{
    execute_web_stack_capability, WebStackCapabilityLimits, WebStackCapabilityTool,
    WebStackContext, WorkjetRuntimeConfigStore,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const SEARCH_SURFACE_VERSION: &str = "workjet-web-stack-json-v1";
const BROWSER_SURFACE_VERSION: &str = "workjet-web-stack-browser-json-v1";
const RESEARCH_SURFACE_VERSION: &str = "workjet-web-stack-research-json-v1";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const FIXED_ERROR: &str = "workjet-web-stack request failed";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestEnvelope {
    request: Value,
    #[serde(default)]
    config: BTreeMap<String, String>,
}

enum Command {
    SearchSurfaceVersion,
    BrowserSurfaceVersion,
    ResearchSurfaceVersion,
    Execute {
        root: PathBuf,
        tool: WebStackCapabilityTool,
    },
}

fn main() {
    if run(
        std::env::args().skip(1),
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        execute,
    )
    .is_err()
    {
        eprintln!("{FIXED_ERROR}");
        std::process::exit(1);
    }
}

fn execute(root: &Path, tool: WebStackCapabilityTool, envelope: RequestEnvelope) -> Result<Value> {
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    execute_web_stack_capability(
        WebStackContext::new(root, &store),
        tool,
        envelope.request,
        WebStackCapabilityLimits {
            max_response_bytes: MAX_RESPONSE_BYTES,
        },
    )
    .map_err(anyhow::Error::new)
}

fn run<I, R, W, F>(args: I, input: R, mut output: W, executor: F) -> Result<()>
where
    I: IntoIterator<Item = String>,
    R: Read,
    W: Write,
    F: FnOnce(&Path, WebStackCapabilityTool, RequestEnvelope) -> Result<Value>,
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
        Command::ResearchSurfaceVersion => {
            writeln!(output, "{RESEARCH_SURFACE_VERSION}").context("surface output failed")?;
            return Ok(());
        }
        Command::Execute { root, tool } => executor(&root, tool, read_request(input)?)?,
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
        [flag] if flag == "--research-surface-version" => Ok(Command::ResearchSurfaceVersion),
        [command, root_flag, root]
            if matches!(
                command.as_str(),
                "search" | "read" | "deep-research" | "browser-prepare" | "browser-automate"
            ) && root_flag == "--root" =>
        {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                anyhow::bail!("invalid invocation");
            }
            let tool = match command.as_str() {
                "search" => WebStackCapabilityTool::Search,
                "read" => WebStackCapabilityTool::Read,
                "deep-research" => WebStackCapabilityTool::DeepResearch,
                "browser-prepare" => WebStackCapabilityTool::BrowserPrepare,
                "browser-automate" => WebStackCapabilityTool::BrowserAutomate,
                _ => unreachable!(),
            };
            Ok(Command::Execute { root, tool })
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
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn unused(_: &Path, _: WebStackCapabilityTool, _: RequestEnvelope) -> Result<Value> {
        panic!("executor must not run")
    }

    #[test]
    fn surface_versions_and_exact_cli_commands_remain_stable() {
        for (args, expected) in [
            (
                ["--surface-version"],
                b"workjet-web-stack-json-v1\n".as_slice(),
            ),
            (
                ["--browser-surface-version"],
                b"workjet-web-stack-browser-json-v1\n".as_slice(),
            ),
            (
                ["--research-surface-version"],
                b"workjet-web-stack-research-json-v1\n".as_slice(),
            ),
        ] {
            let mut output = Vec::new();
            run(
                args.map(str::to_string),
                Cursor::new(Vec::<u8>::new()),
                &mut output,
                unused,
            )
            .unwrap();
            assert_eq!(output, expected);
        }
        assert!(
            parse_command(["--browser-surface-version".to_string(), "extra".to_string()]).is_err()
        );
        for command in [
            "search",
            "read",
            "deep-research",
            "browser-prepare",
            "browser-automate",
        ] {
            assert!(parse_command([
                command.to_string(),
                "--root".to_string(),
                "relative/root".to_string(),
            ])
            .is_err());
        }
    }

    #[test]
    fn transport_keeps_one_strict_bounded_config_envelope_and_json_newline() {
        let valid = read_request(Cursor::new(
            br#"{"request":{"query":" rust "},"config":{"KEY":"value"}}   "#,
        ))
        .unwrap();
        assert_eq!(valid.request["query"], " rust ");
        assert_eq!(valid.config.get("KEY").map(String::as_str), Some("value"));

        for invalid in [
            br#"{"request":{"query":"rust"}} {}"#.as_slice(),
            br#"{"request":{"query":"rust"},"unknown":true}"#.as_slice(),
            br#"{"request":{},"config":null}"#.as_slice(),
        ] {
            assert!(read_request(Cursor::new(invalid)).is_err());
        }
        assert!(read_request(Cursor::new(vec![b' '; MAX_REQUEST_BYTES + 1])).is_err());

        let root = std::env::temp_dir().join("workjet-web-stack-thin-transport");
        let expected_root = root.clone();
        let mut output = Vec::new();
        run(
            [
                "search".to_string(),
                "--root".to_string(),
                root.to_string_lossy().into_owned(),
            ],
            Cursor::new(br#"{"request":{"query":"rust"},"config":{"KEY":"value"}}"#),
            &mut output,
            move |actual_root, tool, envelope| {
                assert_eq!(actual_root, expected_root);
                assert_eq!(tool, WebStackCapabilityTool::Search);
                assert_eq!(envelope.request["query"], "rust");
                assert_eq!(
                    envelope.config.get("KEY").map(String::as_str),
                    Some("value")
                );
                Ok(json!({"results": []}))
            },
        )
        .unwrap();
        assert_eq!(output, b"{\"results\":[]}\n");
    }
}
