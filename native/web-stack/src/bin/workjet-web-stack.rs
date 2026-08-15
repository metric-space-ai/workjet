use anyhow::{Context, Result};
use ctox_web_stack::{
    assert_browser_egress_url_with_context, browser_doctor_report_with_context,
    browser_egress_allow_hosts_from_context, prepare_browser_environment_with_context,
    run_deep_research_tool_with_context, run_web_read_tool_with_context,
    run_web_search_tool_with_context, spawn_persistent_browser_with_context, BrowserPrepareOptions,
    CanonicalWebSearchRequest, DeepResearchDepth, DeepResearchRequest, DirectWebReadRequest,
    PersistentBrowserSpawn, WebStackContext, WorkjetRuntimeConfigStore,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SEARCH_SURFACE_VERSION: &str = "workjet-web-stack-json-v1";
const BROWSER_SURFACE_VERSION: &str = "workjet-web-stack-browser-json-v1";
const RESEARCH_SURFACE_VERSION: &str = "workjet-web-stack-research-json-v1";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_GENERAL_TEXT_CHARS: usize = 16_000;
const MAX_ARRAY_ITEMS: usize = 100;
const MAX_FIND_ITEMS: usize = 32;
const MAX_FIND_TEXT_CHARS: usize = 1_000;
const MAX_QUERY_CHARS: usize = 4_000;
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

fn deserialize_non_null_option<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Clone, Copy, Deserialize)]
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

#[derive(Debug, Clone, Copy, Default, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

struct Executors<FS, FR, FD, FP, FA> {
    search: FS,
    read: FR,
    research: FD,
    prepare: FP,
    automation: FA,
}

enum Command {
    SearchSurfaceVersion,
    BrowserSurfaceVersion,
    ResearchSurfaceVersion,
    Search { root: PathBuf },
    Read { root: PathBuf },
    DeepResearch { root: PathBuf },
    BrowserPrepare { root: PathBuf },
    BrowserAutomate { root: PathBuf },
}

fn main() {
    if run(
        std::env::args().skip(1),
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        Executors {
            search: execute_search,
            read: execute_read,
            research: execute_deep_research,
            prepare: execute_browser_prepare,
            automation: execute_browser_automation,
        },
    )
    .is_err()
    {
        eprintln!("{FIXED_ERROR}");
        std::process::exit(1);
    }
}

fn run<I, R, W, FS, FR, FD, FP, FA>(
    args: I,
    input: R,
    mut output: W,
    executors: Executors<FS, FR, FD, FP, FA>,
) -> Result<()>
where
    I: IntoIterator<Item = String>,
    R: Read,
    W: Write,
    FS: FnOnce(&Path, RequestEnvelope<SearchRequest>) -> Result<Value>,
    FR: FnOnce(&Path, RequestEnvelope<ReadRequest>) -> Result<Value>,
    FD: FnOnce(&Path, RequestEnvelope<ResearchRequest>) -> Result<Value>,
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
        Command::ResearchSurfaceVersion => {
            writeln!(output, "{RESEARCH_SURFACE_VERSION}").context("surface output failed")?;
            return Ok(());
        }
        Command::Search { root } => (executors.search)(&root, read_request(input)?)?,
        Command::Read { root } => {
            let envelope = read_request(input)?;
            validate_read_request(&envelope.request)?;
            (executors.read)(&root, envelope)?
        }
        Command::DeepResearch { root } => {
            let envelope = read_request(input)?;
            validate_research_request(&envelope.request)?;
            (executors.research)(&root, envelope)?
        }
        Command::BrowserPrepare { root } => (executors.prepare)(&root, read_request(input)?)?,
        Command::BrowserAutomate { root } => {
            let envelope = read_request(input)?;
            validate_browser_automation_request(&envelope.request)?;
            (executors.automation)(&root, envelope)?
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
            match command.as_str() {
                "search" => Ok(Command::Search { root }),
                "read" => Ok(Command::Read { root }),
                "deep-research" => Ok(Command::DeepResearch { root }),
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

fn validate_read_request(request: &ReadRequest) -> Result<()> {
    validate_text(&request.url, MAX_URL_CHARS, false)?;
    if let Some(query) = &request.query {
        validate_text(query, MAX_QUERY_CHARS, false)?;
    }
    if request.find.len() > MAX_FIND_ITEMS {
        anyhow::bail!("invalid request");
    }
    for pattern in &request.find {
        validate_text(pattern, MAX_FIND_TEXT_CHARS, false)?;
    }
    Ok(())
}

fn validate_research_request(request: &ResearchRequest) -> Result<()> {
    validate_text(&request.query, MAX_QUERY_CHARS, false)?;
    if let Some(focus) = &request.focus {
        validate_text(focus, MAX_QUERY_CHARS, false)?;
    }
    if !(3..=100).contains(&request.max_sources) || request.exclude_urls.len() > MAX_ARRAY_ITEMS {
        anyhow::bail!("invalid request");
    }
    for url in &request.exclude_urls {
        validate_text(url, MAX_URL_CHARS, false)?;
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

fn value_string(value: Option<&Value>, maximum: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|text| truncate_chars(text, maximum))
}

fn object_string(value: &Value, key: &str, maximum: usize) -> Option<String> {
    value_string(value.get(key), maximum)
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
                Some(json!({
                    "pageNumber": item.get("page_number").and_then(Value::as_u64),
                    "text": object_string(item, "text", 4_000)?,
                }))
            })
            .collect(),
    )
}

fn normalize_extracted_fields(value: Option<&Value>) -> Value {
    let Some(record) = value.filter(|value| value.is_object()) else {
        return Value::Null;
    };
    let fields = record
        .get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_ARRAY_ITEMS)
        .filter_map(|field| {
            Some(json!({
                "field": object_string(field, "field", 1_000)?,
                "value": object_string(field, "value", 4_000)?,
                "confidence": object_string(field, "confidence", 1_000),
                "note": object_string(field, "note", 2_000),
                "sourceUrl": object_string(field, "source_url", MAX_URL_CHARS),
            }))
        })
        .collect::<Vec<_>>();
    json!({
        "sourceId": object_string(record, "source_id", 1_000),
        "tier": object_string(record, "tier", 1_000),
        "fields": fields,
    })
}

fn normalize_response_metadata(value: Option<&Value>) -> Value {
    let Some(record) = value.filter(|value| value.is_object()) else {
        return Value::Null;
    };
    json!({
        "requestedUrl": object_string(record, "requested_url", MAX_URL_CHARS),
        "finalUrl": object_string(record, "final_url", MAX_URL_CHARS),
        "status": record.get("status").and_then(Value::as_u64),
        "contentType": object_string(record, "content_type", 1_000),
        "byteCount": record.get("byte_count").and_then(Value::as_u64),
        "sha256": object_string(record, "sha256", 1_000),
        "contentKind": object_string(record, "content_kind", 1_000),
        "redirected": record.get("redirected").and_then(Value::as_bool),
        "redirectChain": normalize_string_array(record.get("redirect_chain"), MAX_ARRAY_ITEMS, MAX_URL_CHARS),
        "lineage": object_string(record, "lineage", MAX_GENERAL_TEXT_CHARS),
        "admissionRejectionReason": object_string(record, "admission_rejection_reason", 2_000),
    })
}

fn encoded_len(value: &Value) -> Result<usize> {
    Ok(serde_json::to_vec(value)?.len() + 1)
}

fn compact_read_response(value: &mut Value) -> Result<()> {
    while encoded_len(value)? > MAX_RESPONSE_BYTES {
        let mut changed = false;
        if let Some(fields) = value
            .get_mut("extractedFields")
            .and_then(|value| value.get_mut("fields"))
            .and_then(Value::as_array_mut)
        {
            changed = fields.pop().is_some();
        }
        if !changed {
            if let Some(sections) = value.get_mut("pageSections").and_then(Value::as_array_mut) {
                changed = sections.pop().is_some();
            }
        }
        if !changed {
            if let Some(find) = value.get_mut("findMatches").and_then(Value::as_array_mut) {
                if let Some(matches) = find
                    .last_mut()
                    .and_then(|item| item.get_mut("matches"))
                    .and_then(Value::as_array_mut)
                {
                    changed = matches.pop().is_some();
                }
                if !changed {
                    changed = find.pop().is_some();
                }
            }
        }
        if !changed {
            if let Some(excerpts) = value.get_mut("excerpts").and_then(Value::as_array_mut) {
                changed = excerpts.pop().is_some();
            }
        }
        if !changed {
            anyhow::bail!("normalized response too large");
        }
    }
    Ok(())
}

fn normalize_read_response(value: Value) -> Result<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("web read failed");
    }
    let canonical_url = object_string(&value, "canonical_url", MAX_URL_CHARS);
    let final_url =
        object_string(&value, "final_url", MAX_URL_CHARS).or_else(|| canonical_url.clone());
    let mut normalized = json!({
        "ok": true,
        "operation": "read",
        "requestedUrl": object_string(&value, "url", MAX_URL_CHARS),
        "canonicalUrl": canonical_url,
        "finalUrl": final_url,
        "title": object_string(&value, "title", 2_000),
        "summary": object_string(&value, "summary", MAX_GENERAL_TEXT_CHARS),
        "pageTextExcerpt": object_string(&value, "page_text_excerpt", MAX_GENERAL_TEXT_CHARS),
        "isPdf": value.get("is_pdf").and_then(Value::as_bool).unwrap_or(false),
        "pdfTotalPages": value.get("pdf_total_pages").and_then(Value::as_u64),
        "redirected": value.get("redirected").and_then(Value::as_bool),
        "redirectChain": normalize_string_array(value.get("redirect_chain"), MAX_ARRAY_ITEMS, MAX_URL_CHARS),
        "lineage": object_string(&value, "lineage", MAX_GENERAL_TEXT_CHARS),
        "verificationStatus": object_string(&value, "verification_status", 1_000),
        "checkedAt": value.get("checked_at").and_then(Value::as_u64),
        "httpStatus": value.get("http_status").and_then(Value::as_u64),
        "snapshotHash": object_string(&value, "snapshot_hash", 1_000),
        "contentType": object_string(&value, "content_type", 1_000),
        "byteCount": value.get("byte_count").and_then(Value::as_u64),
        "responseContentKind": object_string(&value, "response_content_kind", 1_000),
        "responseMetadata": normalize_response_metadata(value.get("response_metadata")),
        "excerpts": normalize_string_array(value.get("excerpts"), MAX_ARRAY_ITEMS, 2_000),
        "findMatches": normalize_find_matches(value.get("find_results")),
        "pageSections": normalize_page_sections(value.get("page_sections")),
        "sourceTier": object_string(&value, "source_tier", 1_000),
        "transportEvidenceEligible": value.get("transport_evidence_eligible").and_then(Value::as_bool).unwrap_or(false),
        "evidenceEligible": value.get("evidence_eligible").and_then(Value::as_bool).unwrap_or(false),
        "evidenceRelevanceScore": value.get("evidence_relevance_score").and_then(Value::as_i64),
        "evidenceRejectionReason": object_string(&value, "admission_rejection_reason", 2_000),
        "evidenceContentKind": object_string(&value, "evidence_content_kind", 1_000),
        "datasetContentExtracted": value.get("dataset_content_extracted").and_then(Value::as_bool).unwrap_or(false),
        "extractedFields": normalize_extracted_fields(value.get("extracted_fields")),
    });
    compact_read_response(&mut normalized)?;
    Ok(normalized)
}

fn normalize_source(value: &Value) -> Option<Value> {
    let read = value.get("read").filter(|value| value.is_object());
    let canonical_url = object_string(value, "canonical_url", MAX_URL_CHARS)
        .or_else(|| object_string(value, "url", MAX_URL_CHARS))?;
    let summary = object_string(value, "summary", 4_000)
        .or_else(|| object_string(value, "snippet", 4_000))
        .or_else(|| read.and_then(|item| object_string(item, "summary", 4_000)));
    Some(json!({
        "title": object_string(value, "title", 2_000),
        "canonicalUrl": canonical_url,
        "domain": object_string(value, "domain", 1_000),
        "summary": summary,
        "sourceType": object_string(value, "source_type", 1_000),
        "doi": object_string(value, "doi", 1_000).or_else(|| value.get("scholarly_metadata").and_then(|item| object_string(item, "doi", 1_000))),
        "verificationStatus": object_string(value, "verification_status", 1_000),
        "checkedAt": value.get("checked_at").and_then(Value::as_u64),
        "httpStatus": value.get("http_status").and_then(Value::as_u64),
        "snapshotHash": object_string(value, "snapshot_hash", 1_000),
        "transportVerified": value.get("transport_verified").and_then(Value::as_bool).unwrap_or(false),
        "contentExtracted": value.get("content_extracted").and_then(Value::as_bool).unwrap_or(false),
        "actualFullTextOrData": value.get("actual_full_text_or_data").and_then(Value::as_bool).unwrap_or(false),
        "evidenceEligible": value.get("evidence_eligible").and_then(Value::as_bool).unwrap_or(false),
        "evidenceRelevanceScore": value.get("evidence_relevance_score").and_then(Value::as_i64),
        "evidenceRejectionReason": object_string(value, "evidence_rejection_reason", 2_000),
        "responseContentKind": object_string(value, "response_content_kind", 1_000),
        "dataValidationStatus": object_string(value, "data_validation_status", 1_000),
        "pageTextExcerpt": read.and_then(|item| object_string(item, "page_text_excerpt", 4_000)),
        "excerpts": normalize_string_array(read.and_then(|item| item.get("excerpts")), 8, 2_000),
    }))
}

fn normalize_blocked_source(value: &Value) -> Option<Value> {
    Some(json!({
        "title": object_string(value, "title", 2_000),
        "canonicalUrl": object_string(value, "canonical_url", MAX_URL_CHARS)?,
        "blockedResponseUrl": object_string(value, "blocked_response_url", MAX_URL_CHARS),
        "reason": object_string(value, "reason", 2_000),
        "doi": object_string(value, "doi", 1_000),
        "nextAction": object_string(value, "next_action", 4_000),
    }))
}

fn normalize_named_counts(value: Option<&Value>, names: &[&str]) -> Value {
    let mut output = serde_json::Map::new();
    for name in names {
        if let Some(number) = value
            .and_then(|record| record.get(name))
            .and_then(Value::as_u64)
        {
            output.insert((*name).to_string(), Value::Number(number.into()));
        }
    }
    Value::Object(output)
}

fn normalize_systematic_coverage(value: Option<&Value>) -> Value {
    let Some(record) = value.filter(|value| value.is_object()) else {
        return json!({});
    };
    json!({
        "plannedFacets": normalize_string_array(record.get("planned_facets"), MAX_ARRAY_ITEMS, 1_000),
        "successfulFacets": normalize_string_array(record.get("successful_facets"), MAX_ARRAY_ITEMS, 1_000),
        "uncoveredFacets": normalize_string_array(record.get("uncovered_facets"), MAX_ARRAY_ITEMS, 1_000),
        "excludedExistingUrlCount": record.get("excluded_existing_url_count").and_then(Value::as_u64),
        "verifiedPrimaryDataSources": record.get("verified_primary_data_sources").and_then(Value::as_u64),
        "verifiedScholarlyFullTextSources": record.get("verified_scholarly_full_text_sources").and_then(Value::as_u64),
        "hashBoundVerifiedSources": record.get("hash_bound_verified_sources").and_then(Value::as_u64),
        "independentVerifiedDomains": normalize_string_array(record.get("independent_verified_domains"), MAX_ARRAY_ITEMS, 1_000),
        "remainingGaps": normalize_string_array(record.get("remaining_gaps"), MAX_ARRAY_ITEMS, 1_000),
        "complete": record.get("complete").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn normalize_report_scaffold(value: Option<&Value>) -> Value {
    let Some(record) = value.filter(|value| value.is_object()) else {
        return json!({});
    };
    json!({
        "recommendedSections": normalize_string_array(record.get("recommended_sections"), MAX_ARRAY_ITEMS, 2_000),
        "evaluationAxes": normalize_string_array(record.get("evaluation_axes"), MAX_ARRAY_ITEMS, 2_000),
        "synthesisInstruction": object_string(record, "synthesis_instruction", MAX_GENERAL_TEXT_CHARS),
    })
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

fn compact_research_response(value: &mut Value) -> Result<()> {
    while encoded_len(value)? > MAX_RESPONSE_BYTES {
        let mut changed = false;
        for key in ["verifiedSources", "blockedSources"] {
            if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
                if items.pop().is_some() {
                    changed = true;
                    break;
                }
            }
        }
        if !changed {
            for key in [
                "plannedFacets",
                "successfulFacets",
                "uncoveredFacets",
                "independentVerifiedDomains",
                "remainingGaps",
            ] {
                if let Some(items) = value
                    .get_mut("systematicCoverage")
                    .and_then(|coverage| coverage.get_mut(key))
                    .and_then(Value::as_array_mut)
                {
                    if items.pop().is_some() {
                        changed = true;
                        break;
                    }
                }
            }
        }
        if !changed {
            for key in ["recommendedSections", "evaluationAxes"] {
                if let Some(items) = value
                    .get_mut("reportScaffold")
                    .and_then(|report| report.get_mut(key))
                    .and_then(Value::as_array_mut)
                {
                    if items.pop().is_some() {
                        changed = true;
                        break;
                    }
                }
            }
        }
        if !changed {
            anyhow::bail!("normalized response too large");
        }
    }
    Ok(())
}

fn normalize_research_response(value: Value) -> Result<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("deep research failed");
    }
    let verified_sources = value
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_ARRAY_ITEMS)
        .filter_map(normalize_source)
        .collect::<Vec<_>>();
    let blocked_sources = value
        .get("blocked_sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_ARRAY_ITEMS)
        .filter_map(normalize_blocked_source)
        .collect::<Vec<_>>();
    let workspace_id = workspace_identifier(value.get("research_workspace"));
    let mut normalized = json!({
        "ok": true,
        "operation": "deepResearch",
        "query": object_string(&value, "query", MAX_QUERY_CHARS),
        "focus": object_string(&value, "focus", MAX_QUERY_CHARS),
        "depth": object_string(&value, "depth", 32),
        "maxSources": value.get("max_sources").and_then(Value::as_u64),
        "evidenceStatus": object_string(&value, "evidence_status", 1_000),
        "verifiedSources": verified_sources,
        "blockedSources": blocked_sources,
        "systematicCoverage": normalize_systematic_coverage(value.get("systematic_coverage")),
        "researchCallCounts": normalize_named_counts(value.get("research_call_counts"), &[
            "planned_search_queries", "executed_search_queries", "database_queries",
            "discovered_source_candidates", "candidate_pool_limit", "deduplicated_sources",
            "verified_sources", "rejected_source_candidates", "read_budget",
            "followup_read_budget", "read_attempts", "followed_data_links",
            "sources_with_page_read_attempts", "successful_page_reads", "failed_page_reads",
            "figure_candidates", "estimated_external_fetches",
        ]),
        "reportScaffold": normalize_report_scaffold(value.get("report_scaffold")),
        "workspacePersisted": workspace_id.is_some(),
        "workspaceId": workspace_id,
    });
    compact_research_response(&mut normalized)?;
    Ok(normalized)
}

fn execute_read(root: &Path, envelope: RequestEnvelope<ReadRequest>) -> Result<Value> {
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    let request = DirectWebReadRequest {
        url: envelope.request.url,
        query: envelope.request.query,
        find: envelope.request.find,
        workspace: None,
        include_full_text: false,
        timeout_cap_ms: None,
        max_artifact_bytes: None,
        country: envelope
            .request
            .country
            .map(|country| country.as_str().to_string()),
    };
    normalize_read_response(run_web_read_tool_with_context(
        WebStackContext::new(root, &store),
        &request,
    )?)
}

fn execute_deep_research(root: &Path, envelope: RequestEnvelope<ResearchRequest>) -> Result<Value> {
    let store = WorkjetRuntimeConfigStore::from_map(envelope.config);
    let request = DeepResearchRequest {
        query: envelope.request.query,
        focus: envelope.request.focus,
        depth: envelope.request.depth.native(),
        max_sources: envelope.request.max_sources,
        exclude_urls: envelope.request.exclude_urls,
        include_annas_archive: envelope.request.include_annas_archive,
        include_papers: envelope.request.include_papers,
        workspace: None,
        persist_workspace: true,
    };
    normalize_research_response(run_deep_research_tool_with_context(
        WebStackContext::new(root, &store),
        &request,
    )?)
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

    fn unused_read(_: &Path, _: RequestEnvelope<ReadRequest>) -> Result<Value> {
        panic!("read must not run")
    }

    fn unused_research(_: &Path, _: RequestEnvelope<ResearchRequest>) -> Result<Value> {
        panic!("research must not run")
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
                Executors {
                    search: unused_search,
                    read: unused_read,
                    research: unused_research,
                    prepare: unused_prepare,
                    automation: unused_automation,
                },
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
    fn research_decoders_are_strict_bounded_and_count_unicode_characters() {
        let read: RequestEnvelope<ReadRequest> = read_request(Cursor::new(
            serde_json::to_vec(&json!({
                "request": {
                    "url": format!("https://example.test/{}", "😀".repeat(7_979)),
                    "query": " evidence ",
                    "find": ["needle"],
                    "country": "DE"
                },
                "config": {"HOST_SETTING": "server-owned"}
            }))
            .expect("encode"),
        ))
        .expect("read envelope");
        validate_read_request(&read.request).expect("valid read request");
        assert_eq!(read.request.find, ["needle"]);

        let research: RequestEnvelope<ResearchRequest> = read_request(Cursor::new(
            br#"{"request":{"query":"research","depth":"quick"}}"#,
        ))
        .expect("research envelope");
        validate_research_request(&research.request).expect("valid research request");
        assert_eq!(research.request.max_sources, 16);
        assert!(research.request.include_papers);
        assert!(!research.request.include_annas_archive);

        for raw in [
            br#"{"request":{"url":"   "}}"#.as_slice(),
            br#"{"request":{"url":"https://example.test","query":"   "}}"#.as_slice(),
            br#"{"request":{"url":"https://example.test","query":null}}"#.as_slice(),
            br#"{"request":{"url":"https://example.test","workspace":"/tmp"}}"#.as_slice(),
            br#"{"request":{"url":"https://example.test","config":{"X":"Y"}}}"#.as_slice(),
        ] {
            if let Ok(envelope) = read_request::<_, ReadRequest>(Cursor::new(raw)) {
                assert!(validate_read_request(&envelope.request).is_err());
            }
        }
        for raw in [
            br#"{"request":{"query":"   "}}"#.as_slice(),
            br#"{"request":{"query":"research","focus":null}}"#.as_slice(),
            br#"{"request":{"query":"research","depth":"deep"}}"#.as_slice(),
            br#"{"request":{"query":"research","maxSources":2}}"#.as_slice(),
            br#"{"request":{"query":"research","workspace":"/tmp"}}"#.as_slice(),
            br#"{"request":{"query":"research","path":"/tmp"}}"#.as_slice(),
        ] {
            if let Ok(envelope) = read_request::<_, ResearchRequest>(Cursor::new(raw)) {
                assert!(validate_research_request(&envelope.request).is_err());
            }
        }

        let unicode = "😀".repeat(MAX_QUERY_CHARS);
        let envelope: RequestEnvelope<ResearchRequest> = read_request(Cursor::new(
            serde_json::to_vec(&json!({"request": {"query": unicode}})).expect("encode"),
        ))
        .expect("unicode research");
        validate_research_request(&envelope.request).expect("unicode character bound");
    }

    #[test]
    fn read_and_research_normalization_drop_local_native_fields_and_bound_output() {
        let secret_path = "/private/workjet/research/query";
        let read = normalize_read_response(json!({
            "ok": true,
            "url": "https://example.test/requested",
            "canonical_url": "https://example.test/canonical",
            "final_url": "https://example.test/final",
            "title": "Title",
            "summary": "Summary",
            "page_text_excerpt": "Text",
            "is_pdf": true,
            "pdf_total_pages": 4,
            "verification_status": "verified",
            "http_status": 200,
            "excerpts": ["excerpt"],
            "find_results": [{"pattern":"needle","matches":["match"],"path":secret_path}],
            "page_sections": [{"page_number":1,"text":"section","artifact_path":secret_path}],
            "response_metadata": {
                "requested_url":"https://example.test/requested",
                "final_url":"https://example.test/final",
                "status":200,
                "redirect_chain":[],
                "lineage":"network"
            },
            "response_body": "SECRET_RAW_BODY",
            "raw_html": "<secret/>",
            "response_artifact_path": secret_path,
            "workspace_evidence": {"workspace": secret_path},
            "extracted_fields": {"source_id":"test","tier":"public","fields":[]}
        }))
        .expect("read normalization");
        assert_eq!(read["operation"], "read");
        assert_eq!(read["findMatches"][0]["matches"][0], "match");
        assert!(!read.to_string().contains(secret_path));
        assert!(!read.to_string().contains("SECRET_RAW_BODY"));
        assert!(!read.to_string().contains("<secret/>"));
        assert!(encoded_len(&read).expect("read size") <= MAX_RESPONSE_BYTES);

        let research = normalize_research_response(json!({
            "ok": true,
            "query": "bounded research",
            "focus": "evidence",
            "depth": "standard",
            "max_sources": 16,
            "evidence_status": "verified_sources_available",
            "sources": [{
                "title":"Source",
                "url":"https://example.test/source",
                "summary":"Useful evidence",
                "evidence_eligible":true,
                "response_artifact_path":secret_path,
                "read":{"page_text_excerpt":"Evidence excerpt","response_body":"SECRET_RAW_BODY"}
            }],
            "blocked_sources": [{
                "title":"Blocked",
                "canonical_url":"https://blocked.test/",
                "reason":"bot_wall",
                "next_action":"Use another source",
                "path":secret_path
            }],
            "systematic_coverage": {"planned_facets":["facet"],"remaining_gaps":[],"complete":true},
            "research_call_counts": {"executed_search_queries":3,"raw_errors":["secret"]},
            "report_scaffold": {"recommended_sections":["Summary"],"evaluation_axes":[],"synthesis_instruction":"Synthesize."},
            "research_workspace": {"path":secret_path,"manifest":format!("{secret_path}/manifest.json")},
            "source_candidates": [{"raw_html":"<secret/>"}],
            "search_runs": [{"error":"SECRET_NATIVE_ERROR"}]
        }))
        .expect("research normalization");
        assert_eq!(research["operation"], "deepResearch");
        assert_eq!(research["workspacePersisted"], true);
        assert!(research["workspaceId"]
            .as_str()
            .is_some_and(|id| id.starts_with("research-")));
        assert!(!research.to_string().contains(secret_path));
        assert!(!research.to_string().contains("SECRET_RAW_BODY"));
        assert!(!research.to_string().contains("SECRET_NATIVE_ERROR"));
        assert!(encoded_len(&research).expect("research size") <= MAX_RESPONSE_BYTES);
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
            Executors {
                search: move |actual_root: &Path, envelope: RequestEnvelope<SearchRequest>| {
                    assert_eq!(actual_root, expected_root);
                    assert_eq!(envelope.request.query, "rust");
                    assert_eq!(
                        envelope.config.get("KEY").map(String::as_str),
                        Some("value")
                    );
                    Ok(json!({"ok": true, "results": []}))
                },
                read: unused_read,
                research: unused_research,
                prepare: unused_prepare,
                automation: unused_automation,
            },
        )
        .expect("search dispatch");
        assert_eq!(output, b"{\"ok\":true,\"results\":[]}\n");
    }
}
