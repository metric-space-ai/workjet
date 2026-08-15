//! Shared finite capability host for product-owned Web Stack adapters.

use crate::{
    assert_browser_egress_url_with_context, browser_doctor_report_with_context,
    browser_egress_allow_hosts_from_context, prepare_browser_environment_with_context,
    run_deep_research_tool_with_context, run_web_read_tool_with_context,
    run_web_search_tool_with_context, spawn_persistent_browser_with_context, BrowserPrepareOptions,
    CanonicalWebSearchRequest, DeepResearchDepth, DeepResearchRequest, DirectWebReadRequest,
    PersistentBrowserSpawn, WebStackContext,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fmt;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::time::Duration;

const CONTRACT_JSON: &str = include_str!("../schema/web-stack-tools.v1.json");
const MAX_GENERAL_TEXT_CHARS: usize = 16_000;
const MAX_ARRAY_ITEMS: usize = 100;
const MAX_FIND_ITEMS: usize = 32;
const MAX_FIND_TEXT_CHARS: usize = 1_000;
const MAX_QUERY_CHARS: usize = 4_000;
const MAX_SEARCH_QUERY_CHARS: usize = 2_000;
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
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The complete finite Web Stack capability vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WebStackCapabilityTool {
    Search,
    Read,
    DeepResearch,
    BrowserPrepare,
    BrowserAutomate,
}

impl WebStackCapabilityTool {
    fn name(self) -> &'static str {
        match self {
            Self::Search => "web_search",
            Self::Read => "web_read",
            Self::DeepResearch => "web_deep_research",
            Self::BrowserPrepare => "web_browser_prepare",
            Self::BrowserAutomate => "web_browser_automate",
        }
    }
}

/// Host-owned bound for the compact JSON response, including one transport newline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebStackCapabilityLimits {
    pub max_response_bytes: usize,
}

/// One descriptor loaded from the canonical embedded contract.
#[derive(Debug, Clone, PartialEq)]
pub struct WebStackCapabilityContract {
    pub tool: WebStackCapabilityTool,
    pub name: String,
    pub capability_id: String,
    pub contract_version: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub annotations: Value,
}

/// Stable error categories suitable for mapping by an embedding host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebStackCapabilityErrorKind {
    InvalidArguments,
    InvalidContract,
    ExecutionFailure,
    InvalidResponse,
    ResponseTooLarge,
}

/// Redacted capability-host failure.
///
/// This error intentionally retains no provider message, URL, path, argument,
/// browser output, or configuration value.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct WebStackCapabilityError {
    kind: WebStackCapabilityErrorKind,
}

impl WebStackCapabilityError {
    pub fn kind(self) -> WebStackCapabilityErrorKind {
        self.kind
    }

    fn new(kind: WebStackCapabilityErrorKind) -> Self {
        Self { kind }
    }
}

impl fmt::Debug for WebStackCapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebStackCapabilityError")
            .field("kind", &self.kind)
            .finish()
    }
}

impl fmt::Display for WebStackCapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self.kind {
            WebStackCapabilityErrorKind::InvalidArguments => "invalid arguments",
            WebStackCapabilityErrorKind::InvalidContract => "invalid capability contract",
            WebStackCapabilityErrorKind::ExecutionFailure => "capability execution failed",
            WebStackCapabilityErrorKind::InvalidResponse => "invalid capability response",
            WebStackCapabilityErrorKind::ResponseTooLarge => "response too large",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WebStackCapabilityError {}

type CapabilityResult<T> = Result<T, WebStackCapabilityError>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CanonicalDocument {
    schema_version: u64,
    tools: Vec<CanonicalTool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CanonicalTool {
    name: String,
    capability_id: String,
    contract_version: String,
    description: String,
    annotations: Value,
    input_schema: Value,
    output_schema: Value,
}

/// Loads and verifies the canonical embedded five-tool contract.
pub fn web_stack_capability_contracts() -> CapabilityResult<Vec<WebStackCapabilityContract>> {
    let document: CanonicalDocument = serde_json::from_str(CONTRACT_JSON)
        .map_err(|_| WebStackCapabilityError::new(WebStackCapabilityErrorKind::InvalidContract))?;
    if document.schema_version != 1 || document.tools.len() != 5 {
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::InvalidContract,
        ));
    }

    let expected = [
        (
            WebStackCapabilityTool::Search,
            "web-search",
            "Web Search",
            true,
            false,
            true,
            true,
        ),
        (
            WebStackCapabilityTool::Read,
            "web-search",
            "Read Web Page",
            true,
            false,
            true,
            true,
        ),
        (
            WebStackCapabilityTool::DeepResearch,
            "web-search",
            "Deep Web Research",
            true,
            false,
            false,
            true,
        ),
        (
            WebStackCapabilityTool::BrowserPrepare,
            "web-stack-browser",
            "Prepare Web Browser",
            false,
            true,
            true,
            true,
        ),
        (
            WebStackCapabilityTool::BrowserAutomate,
            "web-stack-browser",
            "Web Stack Browser",
            false,
            true,
            false,
            true,
        ),
    ];

    let mut contracts = Vec::with_capacity(expected.len());
    for (raw, (tool, capability_id, title, read_only, destructive, idempotent, open_world)) in
        document.tools.into_iter().zip(expected)
    {
        let expected_annotations = json!({
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": open_world,
        });
        if raw.name != tool.name()
            || raw.capability_id != capability_id
            || raw.contract_version != "1.0.0"
            || raw.description.trim().is_empty()
            || raw.annotations != expected_annotations
            || !schema_is_closed(&raw.input_schema)
            || !schema_is_closed(&raw.output_schema)
        {
            return Err(WebStackCapabilityError::new(
                WebStackCapabilityErrorKind::InvalidContract,
            ));
        }
        contracts.push(WebStackCapabilityContract {
            tool,
            name: raw.name,
            capability_id: raw.capability_id,
            contract_version: raw.contract_version,
            description: raw.description,
            input_schema: raw.input_schema,
            output_schema: raw.output_schema,
            annotations: raw.annotations,
        });
    }
    Ok(contracts)
}

fn schema_is_closed(schema: &Value) -> bool {
    match schema {
        Value::Array(values) => values.iter().all(schema_is_closed),
        Value::Object(object) => {
            let object_schema = object.get("type").and_then(Value::as_str) == Some("object")
                || object.contains_key("properties");
            (!object_schema || object.get("additionalProperties") == Some(&Value::Bool(false)))
                && object.values().all(schema_is_closed)
        }
        _ => true,
    }
}

fn deserialize_non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("null is not allowed"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    url: String,
    #[serde(default, deserialize_with = "deserialize_non_null_option")]
    query: Option<String>,
    #[serde(default)]
    find: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_non_null_option")]
    country: Option<ReadCountry>,
}

#[derive(Clone, Copy, Deserialize)]
enum ReadCountry {
    #[serde(rename = "DE")]
    Germany,
    #[serde(rename = "AT")]
    Austria,
    #[serde(rename = "CH")]
    Switzerland,
}

impl ReadCountry {
    fn as_str(self) -> &'static str {
        match self {
            Self::Germany => "DE",
            Self::Austria => "AT",
            Self::Switzerland => "CH",
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ResearchDepth {
    Quick,
    #[default]
    Standard,
    Exhaustive,
}

impl ResearchDepth {
    fn native(self) -> DeepResearchDepth {
        match self {
            Self::Quick => DeepResearchDepth::Quick,
            Self::Standard => DeepResearchDepth::Standard,
            Self::Exhaustive => DeepResearchDepth::Exhaustive,
        }
    }
}

fn default_max_sources() -> usize {
    16
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResearchRequest {
    query: String,
    #[serde(default, deserialize_with = "deserialize_non_null_option")]
    focus: Option<String>,
    #[serde(default)]
    depth: ResearchDepth,
    #[serde(default = "default_max_sources")]
    max_sources: usize,
    #[serde(default)]
    exclude_urls: Vec<String>,
    #[serde(default = "default_true")]
    include_papers: bool,
    #[serde(default)]
    include_annas_archive: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BrowserPrepareRequest {
    #[serde(default)]
    install_reference: bool,
    #[serde(default)]
    install_browser: bool,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum BrowserTarget {
    Selector(SelectorTarget),
    TestId(TestIdTarget),
    Role(RoleTarget),
    Label(LabelTarget),
    Placeholder(PlaceholderTarget),
    Text(TextTarget),
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SelectorTarget {
    selector: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TestIdTarget {
    test_id: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RoleTarget {
    role: String,
    name: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LabelTarget {
    label: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PlaceholderTarget {
    placeholder: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TextTarget {
    text: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BrowserAutomationRequest {
    actions: Vec<BrowserAction>,
    #[serde(default, deserialize_with = "deserialize_non_null_option")]
    timeout_ms: Option<u64>,
}

fn decode<T: DeserializeOwned>(arguments: Value) -> CapabilityResult<T> {
    serde_json::from_value(arguments)
        .map_err(|_| WebStackCapabilityError::new(WebStackCapabilityErrorKind::InvalidArguments))
}

fn char_len(value: &str) -> usize {
    value.chars().count()
}

fn validate_text(value: &str, maximum: usize, allow_empty: bool) -> CapabilityResult<()> {
    let length = char_len(value);
    if (!allow_empty && value.trim().is_empty()) || length > maximum {
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::InvalidArguments,
        ));
    }
    Ok(())
}

fn validate_search_request(request: &SearchRequest) -> CapabilityResult<()> {
    validate_text(&request.query, MAX_SEARCH_QUERY_CHARS, false)
}

fn validate_read_request(request: &ReadRequest) -> CapabilityResult<()> {
    validate_text(&request.url, MAX_URL_CHARS, false)?;
    if let Some(query) = &request.query {
        validate_text(query, MAX_QUERY_CHARS, false)?;
    }
    if request.find.len() > MAX_FIND_ITEMS {
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::InvalidArguments,
        ));
    }
    for pattern in &request.find {
        validate_text(pattern, MAX_FIND_TEXT_CHARS, false)?;
    }
    Ok(())
}

fn validate_research_request(request: &ResearchRequest) -> CapabilityResult<()> {
    validate_text(&request.query, MAX_QUERY_CHARS, false)?;
    if let Some(focus) = &request.focus {
        validate_text(focus, MAX_QUERY_CHARS, false)?;
    }
    if !(3..=100).contains(&request.max_sources) || request.exclude_urls.len() > MAX_ARRAY_ITEMS {
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::InvalidArguments,
        ));
    }
    for url in &request.exclude_urls {
        validate_text(url, MAX_URL_CHARS, false)?;
    }
    Ok(())
}

fn validate_target(target: &BrowserTarget) -> CapabilityResult<()> {
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

fn validate_browser_automation_request(request: &BrowserAutomationRequest) -> CapabilityResult<()> {
    if request.actions.is_empty() || request.actions.len() > MAX_ACTIONS {
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::InvalidArguments,
        ));
    }
    if request
        .timeout_ms
        .is_some_and(|timeout| !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout))
    {
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::InvalidArguments,
        ));
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

/// Strictly decodes, executes, projects, validates, and host-bounds one capability call.
pub fn execute_web_stack_capability(
    context: WebStackContext<'_>,
    tool: WebStackCapabilityTool,
    arguments: Value,
    limits: WebStackCapabilityLimits,
) -> CapabilityResult<Value> {
    let contracts = web_stack_capability_contracts()?;
    let output_schema = &contracts
        .iter()
        .find(|contract| contract.tool == tool)
        .ok_or_else(|| WebStackCapabilityError::new(WebStackCapabilityErrorKind::InvalidContract))?
        .output_schema;

    let projected = match tool {
        WebStackCapabilityTool::Search => execute_search(context, arguments),
        WebStackCapabilityTool::Read => execute_read(context, arguments),
        WebStackCapabilityTool::DeepResearch => execute_deep_research(context, arguments),
        WebStackCapabilityTool::BrowserPrepare => execute_browser_prepare(context, arguments),
        WebStackCapabilityTool::BrowserAutomate => execute_browser_automation(context, arguments),
    }?;
    finalize_response(projected, output_schema, limits.max_response_bytes)
}

fn execution_error() -> WebStackCapabilityError {
    WebStackCapabilityError::new(WebStackCapabilityErrorKind::ExecutionFailure)
}

fn invalid_response() -> WebStackCapabilityError {
    WebStackCapabilityError::new(WebStackCapabilityErrorKind::InvalidResponse)
}

fn execute_search(context: WebStackContext<'_>, arguments: Value) -> CapabilityResult<Value> {
    let request: SearchRequest = decode(arguments)?;
    validate_search_request(&request)?;
    let raw = run_web_search_tool_with_context(
        context,
        &CanonicalWebSearchRequest {
            query: request.query,
            ..CanonicalWebSearchRequest::default()
        },
    )
    .map_err(|_| execution_error())?;
    normalize_search_response(raw)
}

fn execute_read(context: WebStackContext<'_>, arguments: Value) -> CapabilityResult<Value> {
    let request: ReadRequest = decode(arguments)?;
    validate_read_request(&request)?;
    let native = DirectWebReadRequest {
        url: request.url,
        query: request.query,
        find: request.find,
        workspace: None,
        include_full_text: false,
        timeout_cap_ms: None,
        max_artifact_bytes: None,
        country: request.country.map(|country| country.as_str().to_string()),
    };
    let raw = run_web_read_tool_with_context(context, &native).map_err(|_| execution_error())?;
    normalize_read_response(raw)
}

fn execute_deep_research(
    context: WebStackContext<'_>,
    arguments: Value,
) -> CapabilityResult<Value> {
    let request: ResearchRequest = decode(arguments)?;
    validate_research_request(&request)?;
    let native = DeepResearchRequest {
        query: request.query,
        focus: request.focus,
        depth: request.depth.native(),
        max_sources: request.max_sources,
        exclude_urls: request.exclude_urls,
        include_annas_archive: request.include_annas_archive,
        include_papers: request.include_papers,
        workspace: None,
        persist_workspace: true,
    };
    let raw =
        run_deep_research_tool_with_context(context, &native).map_err(|_| execution_error())?;
    normalize_research_response(raw)
}

fn execute_browser_prepare(
    context: WebStackContext<'_>,
    arguments: Value,
) -> CapabilityResult<Value> {
    let request: BrowserPrepareRequest = decode(arguments)?;
    let install_attempted = request.install_reference || request.install_browser;
    let report = prepare_browser_environment_with_context(
        context,
        &BrowserPrepareOptions {
            dir: None,
            install_reference: install_attempted,
            install_browser: request.install_browser,
            skip_npm_install: false,
        },
    )
    .map_err(|_| execution_error())?;
    normalize_browser_prepare_response(report, install_attempted)
}

fn browser_is_ready(context: WebStackContext<'_>) -> CapabilityResult<bool> {
    Ok(browser_doctor_report_with_context(context, None)
        .map_err(|_| execution_error())?
        .get("automation_ready")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn execute_browser_automation(
    context: WebStackContext<'_>,
    arguments: Value,
) -> CapabilityResult<Value> {
    let request: BrowserAutomationRequest = decode(arguments)?;
    validate_browser_automation_request(&request)?;
    for action in &request.actions {
        if let BrowserAction::Navigate { url } = action {
            assert_browser_egress_url_with_context(context, url).map_err(|_| execution_error())?;
        }
    }
    if !browser_is_ready(context)? {
        return Err(execution_error());
    }
    let timeout_ms = request.timeout_ms.unwrap_or(30_000);
    let source = build_browser_action_source(&request.actions, timeout_ms)?;
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
    )
    .map_err(|_| execution_error())?;
    let result = browser.request_with_timeout(
        "automation",
        json!({ "source": source, "timeoutMs": timeout_ms }),
        Duration::from_millis(timeout_ms.saturating_add(5_000)),
    );
    browser.shutdown();
    normalize_browser_automation_response(result.map_err(|_| execution_error())?)
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

fn build_browser_action_source(
    actions: &[BrowserAction],
    timeout_ms: u64,
) -> CapabilityResult<String> {
    let bytes = serde_json::to_vec(actions).map_err(|_| invalid_response())?;
    let encoded_actions = hex_encode(&bytes);
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

fn value_string(value: Option<&Value>, maximum: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|text| truncate_chars(text, maximum))
}

fn object_string(value: &Value, key: &str, maximum: usize) -> Option<String> {
    value_string(value.get(key), maximum)
}

fn insert_option<T: Into<Value>>(output: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        output.insert(key.to_string(), value.into());
    }
}

fn normalize_string_array(
    value: Option<&Value>,
    maximum_items: usize,
    maximum_chars: usize,
) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(maximum_items)
            .map(|text| Value::String(truncate_chars(text, maximum_chars)))
            .collect(),
    )
}

fn normalize_search_response(value: Value) -> CapabilityResult<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(execution_error());
    }
    let raw = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?;
    let mut results = Vec::new();
    for item in raw.iter().take(MAX_ARRAY_ITEMS) {
        let title = object_string(item, "title", 2_000).ok_or_else(invalid_response)?;
        let url = object_string(item, "url", MAX_URL_CHARS).ok_or_else(invalid_response)?;
        let snippet = object_string(item, "snippet", MAX_URL_CHARS).ok_or_else(invalid_response)?;
        if url.is_empty() {
            return Err(invalid_response());
        }
        results.push(json!({"title": title, "url": url, "snippet": snippet}));
    }
    Ok(json!({"results": results}))
}

fn normalize_find_matches(value: Option<&Value>) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_FIND_ITEMS)
            .filter_map(|item| {
                Some(json!({
                    "pattern": object_string(item, "pattern", MAX_FIND_TEXT_CHARS)?,
                    "matches": normalize_string_array(item.get("matches"), 16, 2_000),
                }))
            })
            .collect(),
    )
}

fn normalize_page_sections(value: Option<&Value>) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_ARRAY_ITEMS)
            .filter_map(|item| {
                let mut section = Map::new();
                insert_option(
                    &mut section,
                    "pageNumber",
                    item.get("page_number")
                        .and_then(Value::as_u64)
                        .filter(|number| *number <= MAX_SAFE_INTEGER),
                );
                section.insert(
                    "text".into(),
                    Value::String(object_string(item, "text", 4_000)?),
                );
                Some(Value::Object(section))
            })
            .collect(),
    )
}

fn normalize_extracted_fields(value: Option<&Value>) -> Option<Value> {
    let record = value.filter(|value| value.is_object())?;
    let fields = record
        .get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_ARRAY_ITEMS)
        .filter_map(|field| {
            let mut output = Map::new();
            output.insert(
                "field".into(),
                Value::String(object_string(field, "field", 1_000)?),
            );
            output.insert(
                "value".into(),
                Value::String(object_string(field, "value", 4_000)?),
            );
            insert_option(
                &mut output,
                "confidence",
                object_string(field, "confidence", 1_000),
            );
            insert_option(&mut output, "note", object_string(field, "note", 2_000));
            insert_option(
                &mut output,
                "sourceUrl",
                object_string(field, "source_url", MAX_URL_CHARS),
            );
            Some(Value::Object(output))
        })
        .collect::<Vec<_>>();
    let mut output = Map::new();
    insert_option(
        &mut output,
        "sourceId",
        object_string(record, "source_id", 1_000),
    );
    insert_option(&mut output, "tier", object_string(record, "tier", 1_000));
    output.insert("fields".into(), Value::Array(fields));
    Some(Value::Object(output))
}

fn normalize_response_metadata(value: Option<&Value>) -> Option<Value> {
    let record = value.filter(|value| value.is_object())?;
    let mut output = Map::new();
    insert_option(
        &mut output,
        "requestedUrl",
        object_string(record, "requested_url", MAX_URL_CHARS),
    );
    insert_option(
        &mut output,
        "finalUrl",
        object_string(record, "final_url", MAX_URL_CHARS),
    );
    insert_option(
        &mut output,
        "status",
        bounded_u64(record.get("status"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "contentType",
        object_string(record, "content_type", 1_000),
    );
    insert_option(
        &mut output,
        "byteCount",
        bounded_u64(record.get("byte_count"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "sha256",
        object_string(record, "sha256", 1_000),
    );
    insert_option(
        &mut output,
        "contentKind",
        object_string(record, "content_kind", 1_000),
    );
    insert_option(
        &mut output,
        "redirected",
        record.get("redirected").and_then(Value::as_bool),
    );
    output.insert(
        "redirectChain".into(),
        normalize_string_array(record.get("redirect_chain"), MAX_ARRAY_ITEMS, MAX_URL_CHARS),
    );
    insert_option(
        &mut output,
        "lineage",
        object_string(record, "lineage", MAX_GENERAL_TEXT_CHARS),
    );
    insert_option(
        &mut output,
        "admissionRejectionReason",
        object_string(record, "admission_rejection_reason", 2_000),
    );
    Some(Value::Object(output))
}

fn bounded_u64(value: Option<&Value>, maximum: u64) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|number| *number <= maximum)
}

fn bounded_i64(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|number| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(number))
}

fn normalize_read_response(value: Value) -> CapabilityResult<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(execution_error());
    }
    let requested_url = object_string(&value, "url", MAX_URL_CHARS).ok_or_else(invalid_response)?;
    let mut output = Map::new();
    output.insert("operation".into(), Value::String("read".into()));
    output.insert("requestedUrl".into(), Value::String(requested_url));
    insert_option(
        &mut output,
        "canonicalUrl",
        object_string(&value, "canonical_url", MAX_URL_CHARS),
    );
    insert_option(
        &mut output,
        "finalUrl",
        object_string(&value, "final_url", MAX_URL_CHARS)
            .or_else(|| object_string(&value, "canonical_url", MAX_URL_CHARS)),
    );
    insert_option(&mut output, "title", object_string(&value, "title", 2_000));
    insert_option(
        &mut output,
        "summary",
        object_string(&value, "summary", MAX_GENERAL_TEXT_CHARS),
    );
    insert_option(
        &mut output,
        "pageTextExcerpt",
        object_string(&value, "page_text_excerpt", MAX_GENERAL_TEXT_CHARS),
    );
    output.insert(
        "isPdf".into(),
        Value::Bool(
            value
                .get("is_pdf")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    insert_option(
        &mut output,
        "pdfTotalPages",
        bounded_u64(value.get("pdf_total_pages"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "redirected",
        value.get("redirected").and_then(Value::as_bool),
    );
    output.insert(
        "redirectChain".into(),
        normalize_string_array(value.get("redirect_chain"), MAX_ARRAY_ITEMS, MAX_URL_CHARS),
    );
    insert_option(
        &mut output,
        "lineage",
        object_string(&value, "lineage", MAX_GENERAL_TEXT_CHARS),
    );
    insert_option(
        &mut output,
        "verificationStatus",
        object_string(&value, "verification_status", 1_000),
    );
    insert_option(
        &mut output,
        "checkedAt",
        bounded_u64(value.get("checked_at"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "httpStatus",
        bounded_u64(value.get("http_status"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "snapshotHash",
        object_string(&value, "snapshot_hash", 1_000),
    );
    insert_option(
        &mut output,
        "contentType",
        object_string(&value, "content_type", 1_000),
    );
    insert_option(
        &mut output,
        "byteCount",
        bounded_u64(value.get("byte_count"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "responseContentKind",
        object_string(&value, "response_content_kind", 1_000),
    );
    insert_option(
        &mut output,
        "responseMetadata",
        normalize_response_metadata(value.get("response_metadata")),
    );
    output.insert(
        "excerpts".into(),
        normalize_string_array(value.get("excerpts"), MAX_ARRAY_ITEMS, 2_000),
    );
    output.insert(
        "findMatches".into(),
        normalize_find_matches(value.get("find_results")),
    );
    output.insert(
        "pageSections".into(),
        normalize_page_sections(value.get("page_sections")),
    );
    insert_option(
        &mut output,
        "sourceTier",
        object_string(&value, "source_tier", 1_000),
    );
    output.insert(
        "transportEvidenceEligible".into(),
        Value::Bool(
            value
                .get("transport_evidence_eligible")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    output.insert(
        "evidenceEligible".into(),
        Value::Bool(
            value
                .get("evidence_eligible")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    insert_option(
        &mut output,
        "evidenceRelevanceScore",
        bounded_i64(value.get("evidence_relevance_score")),
    );
    insert_option(
        &mut output,
        "evidenceRejectionReason",
        object_string(&value, "admission_rejection_reason", 2_000),
    );
    insert_option(
        &mut output,
        "evidenceContentKind",
        object_string(&value, "evidence_content_kind", 1_000),
    );
    output.insert(
        "datasetContentExtracted".into(),
        Value::Bool(
            value
                .get("dataset_content_extracted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    insert_option(
        &mut output,
        "extractedFields",
        normalize_extracted_fields(value.get("extracted_fields")),
    );
    Ok(Value::Object(output))
}

fn normalize_source(value: &Value) -> Option<Value> {
    let read = value.get("read").filter(|value| value.is_object());
    let canonical_url = object_string(value, "canonical_url", MAX_URL_CHARS)
        .or_else(|| object_string(value, "url", MAX_URL_CHARS))?;
    let mut output = Map::new();
    insert_option(&mut output, "title", object_string(value, "title", 2_000));
    output.insert("canonicalUrl".into(), Value::String(canonical_url));
    insert_option(&mut output, "domain", object_string(value, "domain", 1_000));
    insert_option(
        &mut output,
        "summary",
        object_string(value, "summary", 4_000)
            .or_else(|| object_string(value, "snippet", 4_000))
            .or_else(|| read.and_then(|item| object_string(item, "summary", 4_000))),
    );
    insert_option(
        &mut output,
        "sourceType",
        object_string(value, "source_type", 1_000),
    );
    insert_option(
        &mut output,
        "doi",
        object_string(value, "doi", 1_000).or_else(|| {
            value
                .get("scholarly_metadata")
                .and_then(|item| object_string(item, "doi", 1_000))
        }),
    );
    insert_option(
        &mut output,
        "verificationStatus",
        object_string(value, "verification_status", 1_000),
    );
    insert_option(
        &mut output,
        "checkedAt",
        bounded_u64(value.get("checked_at"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "httpStatus",
        bounded_u64(value.get("http_status"), MAX_SAFE_INTEGER),
    );
    insert_option(
        &mut output,
        "snapshotHash",
        object_string(value, "snapshot_hash", 1_000),
    );
    output.insert(
        "transportVerified".into(),
        Value::Bool(
            value
                .get("transport_verified")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    output.insert(
        "contentExtracted".into(),
        Value::Bool(
            value
                .get("content_extracted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    output.insert(
        "actualFullTextOrData".into(),
        Value::Bool(
            value
                .get("actual_full_text_or_data")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    output.insert(
        "evidenceEligible".into(),
        Value::Bool(
            value
                .get("evidence_eligible")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    insert_option(
        &mut output,
        "evidenceRelevanceScore",
        bounded_i64(value.get("evidence_relevance_score")),
    );
    insert_option(
        &mut output,
        "evidenceRejectionReason",
        object_string(value, "evidence_rejection_reason", 2_000),
    );
    insert_option(
        &mut output,
        "responseContentKind",
        object_string(value, "response_content_kind", 1_000),
    );
    insert_option(
        &mut output,
        "dataValidationStatus",
        object_string(value, "data_validation_status", 1_000),
    );
    insert_option(
        &mut output,
        "pageTextExcerpt",
        read.and_then(|item| object_string(item, "page_text_excerpt", 4_000)),
    );
    output.insert(
        "excerpts".into(),
        normalize_string_array(read.and_then(|item| item.get("excerpts")), 8, 2_000),
    );
    Some(Value::Object(output))
}

fn normalize_blocked_source(value: &Value) -> Option<Value> {
    let mut output = Map::new();
    insert_option(&mut output, "title", object_string(value, "title", 2_000));
    output.insert(
        "canonicalUrl".into(),
        Value::String(object_string(value, "canonical_url", MAX_URL_CHARS)?),
    );
    insert_option(
        &mut output,
        "blockedResponseUrl",
        object_string(value, "blocked_response_url", MAX_URL_CHARS),
    );
    insert_option(&mut output, "reason", object_string(value, "reason", 2_000));
    insert_option(&mut output, "doi", object_string(value, "doi", 1_000));
    insert_option(
        &mut output,
        "nextAction",
        object_string(value, "next_action", 4_000),
    );
    Some(Value::Object(output))
}

const RESEARCH_COUNT_NAMES: [&str; 17] = [
    "planned_search_queries",
    "executed_search_queries",
    "database_queries",
    "discovered_source_candidates",
    "candidate_pool_limit",
    "deduplicated_sources",
    "verified_sources",
    "rejected_source_candidates",
    "read_budget",
    "followup_read_budget",
    "read_attempts",
    "followed_data_links",
    "sources_with_page_read_attempts",
    "successful_page_reads",
    "failed_page_reads",
    "figure_candidates",
    "estimated_external_fetches",
];

fn normalize_named_counts(value: Option<&Value>) -> CapabilityResult<Value> {
    let record = value
        .and_then(Value::as_object)
        .ok_or_else(invalid_response)?;
    let mut output = Map::new();
    for name in RESEARCH_COUNT_NAMES {
        let number =
            bounded_u64(record.get(name), MAX_SAFE_INTEGER).ok_or_else(invalid_response)?;
        output.insert(name.to_string(), Value::Number(number.into()));
    }
    Ok(Value::Object(output))
}

fn required_u64(record: &Value, key: &str, maximum: u64) -> CapabilityResult<u64> {
    bounded_u64(record.get(key), maximum).ok_or_else(invalid_response)
}

fn normalize_systematic_coverage(value: Option<&Value>) -> CapabilityResult<Value> {
    let record = value
        .filter(|value| value.is_object())
        .ok_or_else(invalid_response)?;
    Ok(json!({
        "plannedFacets": normalize_string_array(record.get("planned_facets"), MAX_ARRAY_ITEMS, 1_000),
        "successfulFacets": normalize_string_array(record.get("successful_facets"), MAX_ARRAY_ITEMS, 1_000),
        "uncoveredFacets": normalize_string_array(record.get("uncovered_facets"), MAX_ARRAY_ITEMS, 1_000),
        "excludedExistingUrlCount": required_u64(record, "excluded_existing_url_count", 100)?,
        "verifiedPrimaryDataSources": required_u64(record, "verified_primary_data_sources", 100)?,
        "verifiedScholarlyFullTextSources": required_u64(record, "verified_scholarly_full_text_sources", 100)?,
        "hashBoundVerifiedSources": required_u64(record, "hash_bound_verified_sources", 100)?,
        "independentVerifiedDomains": normalize_string_array(record.get("independent_verified_domains"), MAX_ARRAY_ITEMS, 1_000),
        "remainingGaps": normalize_string_array(record.get("remaining_gaps"), MAX_ARRAY_ITEMS, 1_000),
        "complete": record.get("complete").and_then(Value::as_bool).ok_or_else(invalid_response)?,
    }))
}

fn normalize_report_scaffold(value: Option<&Value>) -> CapabilityResult<Value> {
    let record = value
        .filter(|value| value.is_object())
        .ok_or_else(invalid_response)?;
    Ok(json!({
        "recommendedSections": normalize_string_array(record.get("recommended_sections"), MAX_ARRAY_ITEMS, 2_000),
        "evaluationAxes": normalize_string_array(record.get("evaluation_axes"), MAX_ARRAY_ITEMS, 2_000),
        "synthesisInstruction": object_string(record, "synthesis_instruction", MAX_GENERAL_TEXT_CHARS).ok_or_else(invalid_response)?,
    }))
}

fn workspace_identifier(value: Option<&Value>) -> Option<String> {
    let path = value
        .and_then(|workspace| workspace.get("path"))
        .and_then(Value::as_str);
    let name = path
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())?;
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    Some(format!("research-{:016x}", hasher.finish()))
}

fn normalize_research_response(value: Value) -> CapabilityResult<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(execution_error());
    }
    let query = object_string(&value, "query", MAX_QUERY_CHARS).ok_or_else(invalid_response)?;
    let depth = object_string(&value, "depth", 32).ok_or_else(invalid_response)?;
    let max_sources = required_u64(&value, "max_sources", 100)?;
    if max_sources < 3 {
        return Err(invalid_response());
    }
    let evidence_status =
        object_string(&value, "evidence_status", 1_000).ok_or_else(invalid_response)?;
    let verified_sources = value
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?
        .iter()
        .take(MAX_ARRAY_ITEMS)
        .filter_map(normalize_source)
        .collect::<Vec<_>>();
    let blocked_sources = value
        .get("blocked_sources")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?
        .iter()
        .take(MAX_ARRAY_ITEMS)
        .filter_map(normalize_blocked_source)
        .collect::<Vec<_>>();
    let workspace_id = workspace_identifier(value.get("research_workspace"));
    let mut output = Map::new();
    output.insert("operation".into(), Value::String("deepResearch".into()));
    output.insert("query".into(), Value::String(query));
    insert_option(
        &mut output,
        "focus",
        object_string(&value, "focus", MAX_QUERY_CHARS),
    );
    output.insert("depth".into(), Value::String(depth));
    output.insert("maxSources".into(), Value::Number(max_sources.into()));
    output.insert("evidenceStatus".into(), Value::String(evidence_status));
    output.insert("verifiedSources".into(), Value::Array(verified_sources));
    output.insert("blockedSources".into(), Value::Array(blocked_sources));
    output.insert(
        "systematicCoverage".into(),
        normalize_systematic_coverage(value.get("systematic_coverage"))?,
    );
    output.insert(
        "researchCallCounts".into(),
        normalize_named_counts(value.get("research_call_counts"))?,
    );
    output.insert(
        "reportScaffold".into(),
        normalize_report_scaffold(value.get("report_scaffold"))?,
    );
    output.insert(
        "workspacePersisted".into(),
        Value::Bool(workspace_id.is_some()),
    );
    insert_option(&mut output, "workspaceId", workspace_id);
    Ok(Value::Object(output))
}

fn normalize_browser_prepare_response(
    value: Value,
    install_attempted: bool,
) -> CapabilityResult<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(execution_error());
    }
    let doctor = value
        .get("doctor")
        .filter(|value| value.is_object())
        .ok_or_else(invalid_response)?;
    let install = value.get("install").unwrap_or(&Value::Null);
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
    Ok(json!({
        "ready": ready,
        "dependencyInstalled": dependency_installed,
        "browserInstalled": browser_installed,
        "installAttempted": install_attempted,
        "dependencyInstallRan": install.get("npm_install_ran").and_then(Value::as_bool).unwrap_or(false),
        "browserInstallRan": install.get("browser_install_ran").and_then(Value::as_bool).unwrap_or(false),
        "reason": reason,
    }))
}

fn normalize_browser_automation_response(value: Value) -> CapabilityResult<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(execution_error());
    }
    let raw = value
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?;
    let mut observations = Vec::new();
    for item in raw.iter().take(MAX_OBSERVATIONS) {
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .filter(|description| !description.is_empty())
            .ok_or_else(invalid_response)?;
        let mut observation = Map::new();
        observation.insert(
            "description".into(),
            Value::String(truncate_chars(description, MAX_DESCRIPTION_CHARS)),
        );
        match item.get("url") {
            Some(Value::String(url)) if !url.is_empty() => {
                observation.insert(
                    "url".into(),
                    Value::String(truncate_chars(url, MAX_URL_CHARS)),
                );
            }
            Some(Value::String(_)) | None => {}
            _ => return Err(invalid_response()),
        }
        observations.push(Value::Object(observation));
    }
    Ok(json!({"observations": observations}))
}

fn encoded_len(value: &Value) -> CapabilityResult<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len() + 1)
        .map_err(|_| invalid_response())
}

fn finalize_response(mut value: Value, schema: &Value, maximum: usize) -> CapabilityResult<Value> {
    validate_schema_value(&value, schema)?;
    while encoded_len(&value)? > maximum {
        if compact_one_array(&mut value, schema)
            || remove_one_optional_property(&mut value, schema)
            || truncate_one_string(&mut value, schema)
        {
            validate_schema_value(&value, schema)?;
            continue;
        }
        return Err(WebStackCapabilityError::new(
            WebStackCapabilityErrorKind::ResponseTooLarge,
        ));
    }
    Ok(value)
}

fn compact_one_array(value: &mut Value, schema: &Value) -> bool {
    if let (Some(items), Some(item_schema)) = (value.as_array_mut(), schema.get("items")) {
        if items.pop().is_some() {
            return true;
        }
        return items
            .iter_mut()
            .any(|item| compact_one_array(item, item_schema));
    }
    if let (Some(object), Some(properties)) = (
        value.as_object_mut(),
        schema.get("properties").and_then(Value::as_object),
    ) {
        for (key, property_schema) in properties.iter().rev() {
            if let Some(child) = object.get_mut(key) {
                if compact_one_array(child, property_schema) {
                    return true;
                }
            }
        }
    }
    false
}

fn required_properties(schema: &Value) -> BTreeSet<&str> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn remove_one_optional_property(value: &mut Value, schema: &Value) -> bool {
    if let (Some(object), Some(properties)) = (
        value.as_object_mut(),
        schema.get("properties").and_then(Value::as_object),
    ) {
        let required = required_properties(schema);
        for (key, property_schema) in properties.iter().rev() {
            if let Some(child) = object.get_mut(key) {
                if remove_one_optional_property(child, property_schema) {
                    return true;
                }
            }
            if !required.contains(key.as_str()) && object.remove(key).is_some() {
                return true;
            }
        }
    } else if let (Some(items), Some(item_schema)) = (value.as_array_mut(), schema.get("items")) {
        for item in items.iter_mut().rev() {
            if remove_one_optional_property(item, item_schema) {
                return true;
            }
        }
    }
    false
}

fn truncate_one_string(value: &mut Value, schema: &Value) -> bool {
    if let Some(text) = value.as_str() {
        if schema.get("const").is_some() || schema.get("enum").is_some() {
            return false;
        }
        let minimum = schema.get("minLength").and_then(Value::as_u64).unwrap_or(0) as usize;
        let length = char_len(text);
        if length > minimum {
            let next = minimum.max(length / 2);
            *value = Value::String(truncate_chars(text, next));
            return true;
        }
        return false;
    }
    if let (Some(object), Some(properties)) = (
        value.as_object_mut(),
        schema.get("properties").and_then(Value::as_object),
    ) {
        for (key, property_schema) in properties.iter().rev() {
            if let Some(child) = object.get_mut(key) {
                if truncate_one_string(child, property_schema) {
                    return true;
                }
            }
        }
    } else if let (Some(items), Some(item_schema)) = (value.as_array_mut(), schema.get("items")) {
        for item in items.iter_mut().rev() {
            if truncate_one_string(item, item_schema) {
                return true;
            }
        }
    }
    false
}

fn validate_schema_value(value: &Value, schema: &Value) -> CapabilityResult<()> {
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(invalid_response());
        }
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(invalid_response());
        }
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let object = value.as_object().ok_or_else(invalid_response)?;
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .ok_or_else(invalid_response)?;
            for required in required_properties(schema) {
                if !object.contains_key(required) {
                    return Err(invalid_response());
                }
            }
            for (key, child) in object {
                let child_schema = properties.get(key).ok_or_else(invalid_response)?;
                validate_schema_value(child, child_schema)?;
            }
        }
        Some("array") => {
            let items = value.as_array().ok_or_else(invalid_response)?;
            let minimum = schema.get("minItems").and_then(Value::as_u64).unwrap_or(0) as usize;
            let maximum = schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX) as usize;
            if items.len() < minimum || items.len() > maximum {
                return Err(invalid_response());
            }
            let item_schema = schema.get("items").ok_or_else(invalid_response)?;
            for item in items {
                validate_schema_value(item, item_schema)?;
            }
        }
        Some("string") => {
            let text = value.as_str().ok_or_else(invalid_response)?;
            let length = char_len(text);
            let minimum = schema.get("minLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            let maximum = schema
                .get("maxLength")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX) as usize;
            if length < minimum || length > maximum {
                return Err(invalid_response());
            }
            if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
                let pattern = regex::Regex::new(pattern).map_err(|_| invalid_response())?;
                if !pattern.is_match(text) {
                    return Err(invalid_response());
                }
            }
        }
        Some("boolean") => {
            if !value.is_boolean() {
                return Err(invalid_response());
            }
        }
        Some("integer") => {
            let number = value
                .as_i64()
                .map(|number| number as i128)
                .or_else(|| value.as_u64().map(|number| number as i128))
                .ok_or_else(invalid_response)?;
            let minimum = schema
                .get("minimum")
                .and_then(Value::as_i64)
                .map(i128::from)
                .unwrap_or(i128::MIN);
            let maximum = schema
                .get("maximum")
                .and_then(Value::as_u64)
                .map(i128::from)
                .or_else(|| {
                    schema
                        .get("maximum")
                        .and_then(Value::as_i64)
                        .map(i128::from)
                })
                .unwrap_or(i128::MAX);
            if number < minimum || number > maximum {
                return Err(invalid_response());
            }
        }
        Some(_) => return Err(invalid_response()),
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output_schema(tool: WebStackCapabilityTool) -> Value {
        web_stack_capability_contracts()
            .unwrap()
            .into_iter()
            .find(|contract| contract.tool == tool)
            .unwrap()
            .output_schema
    }

    #[test]
    fn shared_fixture_drives_strict_decoding_and_finite_browser_vocabulary() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/capability-adapter-v1.json")).unwrap();
        let action_names = fixture["browserActions"].as_array().unwrap();
        assert_eq!(
            action_names,
            &[
                json!("navigate"),
                json!("observe"),
                json!("click"),
                json!("fill"),
                json!("press")
            ]
        );

        for case in fixture["validInputs"].as_array().unwrap() {
            let arguments = case["arguments"].clone();
            match case["tool"].as_str().unwrap() {
                "web_search" => validate_search_request(&decode(arguments).unwrap()).unwrap(),
                "web_read" => validate_read_request(&decode(arguments).unwrap()).unwrap(),
                "web_deep_research" => {
                    validate_research_request(&decode(arguments).unwrap()).unwrap()
                }
                "web_browser_prepare" => {
                    let _: BrowserPrepareRequest = decode(arguments).unwrap();
                }
                "web_browser_automate" => {
                    validate_browser_automation_request(&decode(arguments).unwrap()).unwrap()
                }
                _ => panic!("unknown fixture tool"),
            }
        }

        for case in fixture["invalidInputs"].as_array().unwrap() {
            let mut arguments = case["arguments"].clone();
            if arguments.get("query").and_then(Value::as_str) == Some("__OVER_2000_CHARS__") {
                arguments["query"] = Value::String("q".repeat(MAX_SEARCH_QUERY_CHARS + 1));
            }
            let rejected = match case["tool"].as_str().unwrap() {
                "web_search" => decode::<SearchRequest>(arguments)
                    .and_then(|request| validate_search_request(&request)),
                "web_read" => decode::<ReadRequest>(arguments)
                    .and_then(|request| validate_read_request(&request)),
                "web_deep_research" => decode::<ResearchRequest>(arguments)
                    .and_then(|request| validate_research_request(&request)),
                "web_browser_prepare" => decode::<BrowserPrepareRequest>(arguments).map(|_| ()),
                "web_browser_automate" => decode::<BrowserAutomationRequest>(arguments)
                    .and_then(|request| validate_browser_automation_request(&request)),
                _ => panic!("unknown fixture tool"),
            };
            assert_eq!(
                rejected.unwrap_err().kind(),
                WebStackCapabilityErrorKind::InvalidArguments,
                "fixture reason {}",
                case["reason"]
            );
        }
    }

    #[test]
    fn generated_source_keeps_caller_strings_in_inert_hex_json() {
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
        ];
        let source = build_browser_action_source(&actions, 30_000).unwrap();
        assert!(!source.contains(marker));
        assert!(!source.contains("process.env.SECRET"));
    }

    #[test]
    fn projectors_drop_canaries_and_validate_against_contracts() {
        let marker = "CAPABILITY_CANARY_SECRET";
        let search = normalize_search_response(json!({
            "ok": true,
            "results": [{"title":"Title","url":"https://example.test","snippet":"Snippet","raw":marker}],
            "provider": marker,
        })).unwrap();
        assert!(!search.to_string().contains(marker));
        validate_schema_value(&search, &output_schema(WebStackCapabilityTool::Search)).unwrap();

        let read = normalize_read_response(json!({
            "ok": true,
            "url": "https://example.test",
            "is_pdf": false,
            "redirect_chain": [],
            "excerpts": [],
            "find_results": [],
            "page_sections": [],
            "response_body": marker,
            "transport_evidence_eligible": false,
            "evidence_eligible": false,
            "dataset_content_extracted": false,
        }))
        .unwrap();
        assert!(!read.to_string().contains(marker));
        validate_schema_value(&read, &output_schema(WebStackCapabilityTool::Read)).unwrap();

        let counts = RESEARCH_COUNT_NAMES
            .into_iter()
            .map(|name| (name.to_string(), json!(0)))
            .collect::<Map<_, _>>();
        let research = normalize_research_response(json!({
            "ok": true,
            "query": "research",
            "depth": "quick",
            "max_sources": 3,
            "evidence_status": "verified_sources_available",
            "sources": [{
                "url": "https://example.test/source",
                "transport_verified": true,
                "content_extracted": true,
                "actual_full_text_or_data": true,
                "evidence_eligible": true,
                "read": {"excerpts": [], "response_body": marker},
                "path": marker
            }],
            "blocked_sources": [],
            "systematic_coverage": {
                "planned_facets": [],
                "successful_facets": [],
                "uncovered_facets": [],
                "excluded_existing_url_count": 0,
                "verified_primary_data_sources": 0,
                "verified_scholarly_full_text_sources": 0,
                "hash_bound_verified_sources": 0,
                "independent_verified_domains": [],
                "remaining_gaps": [],
                "complete": true,
                "debug": marker
            },
            "research_call_counts": Value::Object(counts),
            "report_scaffold": {
                "recommended_sections": [],
                "evaluation_axes": [],
                "synthesis_instruction": "Synthesize.",
                "source": marker
            },
            "research_workspace": {"path": format!("/private/{marker}")},
            "logs": marker
        }))
        .unwrap();
        assert!(!research.to_string().contains(marker));
        validate_schema_value(
            &research,
            &output_schema(WebStackCapabilityTool::DeepResearch),
        )
        .unwrap();

        let prepare = normalize_browser_prepare_response(
            json!({
                "ok": true,
                "doctor": {
                    "automation_ready": false,
                    "node_version_compatible": false,
                    "runner_dependency_installed": false,
                    "runner_browser_installed": false,
                    "path": marker
                },
                "logs": marker
            }),
            false,
        )
        .unwrap();
        assert!(!prepare.to_string().contains(marker));
        validate_schema_value(
            &prepare,
            &output_schema(WebStackCapabilityTool::BrowserPrepare),
        )
        .unwrap();

        let automation = normalize_browser_automation_response(json!({
            "ok": true,
            "result": [{"description":"observed","nativePath":marker}],
            "logs": marker
        }))
        .unwrap();
        assert!(!automation.to_string().contains(marker));
        validate_schema_value(
            &automation,
            &output_schema(WebStackCapabilityTool::BrowserAutomate),
        )
        .unwrap();
    }

    #[test]
    fn host_budget_compacts_to_256_kib_and_fails_only_below_minimum() {
        let raw = json!({
            "ok": true,
            "url": "https://example.test/".to_string() + &"u".repeat(7_900),
            "summary": "s".repeat(16_000),
            "page_text_excerpt": "p".repeat(16_000),
            "is_pdf": false,
            "redirect_chain": (0..100).map(|_| "https://example.test/".to_string() + &"r".repeat(7_900)).collect::<Vec<_>>(),
            "excerpts": (0..100).map(|_| "e".repeat(2_000)).collect::<Vec<_>>(),
            "find_results": [],
            "page_sections": (0..100).map(|_| json!({"text":"x".repeat(4_000)})).collect::<Vec<_>>(),
            "transport_evidence_eligible": false,
            "evidence_eligible": false,
            "dataset_content_extracted": false,
        });
        let projected = normalize_read_response(raw).unwrap();
        let schema = output_schema(WebStackCapabilityTool::Read);
        let compacted = finalize_response(projected.clone(), &schema, 256 * 1024).unwrap();
        assert!(encoded_len(&compacted).unwrap() <= 256 * 1024);
        validate_schema_value(&compacted, &schema).unwrap();
        assert_eq!(
            finalize_response(projected, &schema, 1).unwrap_err().kind(),
            WebStackCapabilityErrorKind::ResponseTooLarge
        );
    }
}
