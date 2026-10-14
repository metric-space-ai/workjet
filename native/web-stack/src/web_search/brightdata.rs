//! Bright Data SERP API provider.
//!
//! Google blocks scraping from server IPs ("unusual traffic" robot check), so
//! the browser-driven `google` provider is unusable on many hosts. When an
//! operator stores a Bright Data API key, this provider fetches Google organic
//! results through Bright Data's SERP zone and returns them in the same
//! `SearchHit` shape as every other provider.
//!
//! * Credential: `BRIGHTDATA_API_KEY`, resolved through
//!   [`WebStackContext::credential`] (CTOX: encrypted secret store, scope
//!   `credentials`). The key is only ever sent as the `Authorization` header to
//!   the fixed Bright Data endpoint and is never logged or echoed in errors.
//! * Zone: runtime config `CTOX_WEB_SEARCH_BRIGHTDATA_ZONE`, default
//!   `ctox_serp`.
//! * No key → the provider is absent and the provider chain is unchanged.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;
use url::Url;

use super::{
    build_agent_with_timeout, ProviderKind, SearchConfig, SearchHit, SearchQuery, SearchResponse,
};
use crate::runtime_config::WebStackContext;

/// CTOX secret-store name (scope `credentials`) of the Bright Data API key.
pub(super) const SECRET_NAME: &str = "BRIGHTDATA_API_KEY";
/// Runtime config key naming the Bright Data SERP zone.
pub(super) const ZONE_CONFIG_KEY: &str = "CTOX_WEB_SEARCH_BRIGHTDATA_ZONE";
pub(super) const DEFAULT_ZONE: &str = "ctox_serp";
/// Fixed Bright Data request endpoint. Not runtime-configurable on purpose:
/// the API key must never be sent anywhere else.
pub(super) const ENDPOINT: &str = "https://api.brightdata.com/request";

const MIN_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 30_000;

/// Resolved Bright Data access. `Debug` redacts the key.
#[derive(Clone)]
pub(super) struct BrightDataProvider {
    api_key: String,
    zone: String,
}

impl std::fmt::Debug for BrightDataProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrightDataProvider")
            .field("api_key", &"<redacted>")
            .field("zone", &self.zone)
            .finish()
    }
}

impl BrightDataProvider {
    /// Returns `None` when no API key is configured: the provider is then
    /// silently absent from the chain.
    pub(super) fn from_context(context: WebStackContext<'_>) -> Option<Self> {
        let api_key = context
            .credential(SECRET_NAME)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let zone = context
            .get(ZONE_CONFIG_KEY)
            .map(|value| value.trim().to_string())
            .filter(|value| valid_zone(value))
            .unwrap_or_else(|| DEFAULT_ZONE.to_string());
        Some(Self { api_key, zone })
    }

    #[cfg(test)]
    pub(super) fn for_test(api_key: &str, zone: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            zone: zone.to_string(),
        }
    }
}

fn valid_zone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GoogleLocale {
    pub host: &'static str,
    pub gl: String,
    pub hl: String,
}

/// Map the requested country (ISO-3166 alpha-2, or a locale such as `de-AT`)
/// and optional language onto the Google domain plus `gl`/`hl`. DACH is the
/// primary market; anything unknown defaults to Germany like the `google`
/// browser provider does.
pub(super) fn google_locale(region: Option<&str>, language: Option<&str>) -> GoogleLocale {
    let country = region
        .and_then(|raw| raw.trim().rsplit(['-', '_']).next())
        .map(str::to_ascii_uppercase)
        .filter(|value| value.len() == 2 && value.bytes().all(|b| b.is_ascii_alphabetic()))
        .unwrap_or_else(|| "DE".to_string());
    let (host, gl, default_hl) = match country.as_str() {
        "DE" => ("www.google.de", "de".to_string(), "de"),
        "AT" => ("www.google.at", "at".to_string(), "de"),
        "CH" => ("www.google.ch", "ch".to_string(), "de"),
        "GB" | "UK" => ("www.google.co.uk", "uk".to_string(), "en"),
        "US" => ("www.google.com", "us".to_string(), "en"),
        other => ("www.google.com", other.to_ascii_lowercase(), "en"),
    };
    let hl = language
        .and_then(|raw| raw.trim().split(['-', '_']).next())
        .map(str::to_ascii_lowercase)
        .filter(|value| {
            (2..=3).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphabetic())
        })
        .unwrap_or_else(|| default_hl.to_string());
    GoogleLocale { host, gl, hl }
}

/// The Google SERP URL Bright Data fetches; `brd_json=1` makes Bright Data
/// return parsed JSON instead of HTML.
pub(super) fn serp_url(query: &SearchQuery) -> String {
    let locale = google_locale(query.region.as_deref(), query.language.as_deref());
    let mut url =
        Url::parse(&format!("https://{}/search", locale.host)).expect("static Google URL");
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("q", &query.text);
        pairs.append_pair("hl", &locale.hl);
        pairs.append_pair("gl", &locale.gl);
        pairs.append_pair("num", if query.count > 10 { "20" } else { "10" });
        if query.offset > 0 {
            pairs.append_pair("start", &query.offset.to_string());
        }
        pairs.append_pair("brd_json", "1");
    }
    url.into()
}

fn status_error(zone: &str, status: u16) -> anyhow::Error {
    match status {
        401 | 403 | 404 => anyhow!("zone {zone} unavailable (HTTP {status})"),
        429 => anyhow!("rate limit (HTTP 429)"),
        _ => anyhow!("SERP request failed (HTTP {status})"),
    }
}

pub(super) fn brightdata_search(
    config: &SearchConfig,
    provider: &BrightDataProvider,
    query: &SearchQuery,
) -> Result<SearchResponse> {
    let timeout = Duration::from_millis(config.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
    let agent = build_agent_with_timeout(config, timeout)?;
    let body = json!({
        "zone": provider.zone,
        "url": serp_url(query),
        "format": "raw",
    });
    let response = match agent
        .post(&config.brightdata_endpoint)
        .set("Authorization", &format!("Bearer {}", provider.api_key))
        // No `Accept: application/json`: with it Bright Data answers the
        // SERP request with HTTP 200 and an EMPTY body (measured 14.10.2026:
        // 0 bytes with the header, 14 KB of brd_json results without it).
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
    {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => return Err(status_error(&provider.zone, status)),
        Err(ureq::Error::Transport(transport)) => {
            bail!("SERP request failed: {}", transport.kind())
        }
    };
    let text = response
        .into_string()
        .context("failed to read Bright Data SERP response")?;
    let hits = parse_organic_results(&text, query.offset, query.count)?;
    Ok(SearchResponse {
        provider: ProviderKind::BrightData.as_str().to_string(),
        hits,
        evidence: Vec::new(),
        executed_queries: vec![query.text.clone()],
        source_failures: Vec::new(),
    })
}

/// Parse Bright Data's `brd_json=1` body: `{"organic":[{"title","link",
/// "description"}, ...]}`.
pub(super) fn parse_organic_results(
    body: &str,
    offset: usize,
    count: usize,
) -> Result<Vec<SearchHit>> {
    let payload: Value =
        serde_json::from_str(body).context("Bright Data SERP response is not JSON")?;
    let Some(organic) = payload.get("organic").and_then(Value::as_array) else {
        bail!("Bright Data SERP response has no organic results");
    };
    let mut seen = BTreeSet::new();
    let mut hits = Vec::new();
    for item in organic {
        let Some(link) = item
            .get("link")
            .or_else(|| item.get("url"))
            .and_then(Value::as_str)
            .map(str::trim)
        else {
            continue;
        };
        let Ok(parsed) = Url::parse(link) else {
            continue;
        };
        if !matches!(parsed.scheme(), "http" | "https") || !seen.insert(link.to_string()) {
            continue;
        }
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(link)
            .to_string();
        let snippet = item
            .get("description")
            .or_else(|| item.get("snippet"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        hits.push(SearchHit {
            title,
            url: link.to_string(),
            snippet,
            source: ProviderKind::BrightData.as_str().to_string(),
            rank: offset + hits.len() + 1,
        });
        if hits.len() >= count.max(1) {
            break;
        }
    }
    Ok(hits)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::runtime_config::WorkjetRuntimeConfigStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;

    const ORGANIC_FIXTURE: &str = r#"{
        "general": {"search_engine": "google"},
        "organic": [
            {"title": "Dr. Brinkmann – Leiter Einkauf – Kiesow | LinkedIn",
             "link": "https://de.linkedin.com/in/brinkmann-example",
             "description": "Leiter Einkauf bei Kiesow Dr. Brinkmann GmbH"},
            {"title": "no link"},
            {"title": "ftp", "link": "ftp://example.com/file"},
            {"title": "Kiesow Dr. Brinkmann", "link": "https://www.kiesow.de/",
             "description": "Gewürze und Zusatzstoffe"},
            {"title": "duplicate", "link": "https://www.kiesow.de/"}
        ]
    }"#;

    fn query(text: &str, region: Option<&str>) -> SearchQuery {
        SearchQuery {
            text: text.to_string(),
            count: 5,
            offset: 0,
            language: None,
            region: region.map(str::to_string),
            safe_search: 1,
        }
    }

    #[test]
    fn organic_results_map_to_search_hits() {
        let hits = parse_organic_results(ORGANIC_FIXTURE, 0, 10).expect("parse");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://de.linkedin.com/in/brinkmann-example");
        assert_eq!(
            hits[0].title,
            "Dr. Brinkmann – Leiter Einkauf – Kiesow | LinkedIn"
        );
        assert_eq!(
            hits[0].snippet,
            "Leiter Einkauf bei Kiesow Dr. Brinkmann GmbH"
        );
        assert_eq!(hits[0].source, "brightdata");
        assert_eq!((hits[0].rank, hits[1].rank), (1, 2));
        assert_eq!(
            parse_organic_results(ORGANIC_FIXTURE, 10, 1).unwrap()[0].rank,
            11
        );
        assert!(parse_organic_results(r#"{"organic": []}"#, 0, 5)
            .unwrap()
            .is_empty());
        assert!(parse_organic_results(r#"{"error": "x"}"#, 0, 5).is_err());
        assert!(parse_organic_results("<html>", 0, 5).is_err());
    }

    #[test]
    fn country_maps_to_google_domain_gl_and_hl() {
        let de = google_locale(Some("DE"), None);
        assert_eq!(
            (de.host, de.gl.as_str(), de.hl.as_str()),
            ("www.google.de", "de", "de")
        );
        let at = google_locale(Some("at"), None);
        assert_eq!(
            (at.host, at.gl.as_str(), at.hl.as_str()),
            ("www.google.at", "at", "de")
        );
        let ch = google_locale(Some("de-CH"), Some("fr-CH"));
        assert_eq!(
            (ch.host, ch.gl.as_str(), ch.hl.as_str()),
            ("www.google.ch", "ch", "fr")
        );
        assert_eq!(google_locale(None, None), de);
        assert_eq!(google_locale(Some("not a country"), None), de);
        let us = google_locale(Some("US"), None);
        assert_eq!(
            (us.host, us.gl.as_str(), us.hl.as_str()),
            ("www.google.com", "us", "en")
        );

        let url = Url::parse(&serp_url(&query("linkedin \"Kiesow\" Einkauf", Some("AT"))))
            .expect("serp url");
        assert_eq!(url.host_str(), Some("www.google.at"));
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        for expected in [
            ("q", "linkedin \"Kiesow\" Einkauf"),
            ("hl", "de"),
            ("gl", "at"),
            ("num", "10"),
            ("brd_json", "1"),
        ] {
            assert!(
                pairs.contains(&(expected.0.to_string(), expected.1.to_string())),
                "missing {expected:?} in {pairs:?}"
            );
        }
    }

    #[test]
    fn missing_key_means_provider_absent_and_zone_defaults() {
        let root = Path::new("brightdata-test-root");
        let empty = WorkjetRuntimeConfigStore::default();
        assert!(BrightDataProvider::from_context(WebStackContext::new(root, &empty)).is_none());
        let blank = WorkjetRuntimeConfigStore::new([(SECRET_NAME, "  ")]);
        assert!(BrightDataProvider::from_context(WebStackContext::new(root, &blank)).is_none());

        let keyed = WorkjetRuntimeConfigStore::new([(SECRET_NAME, "test-key")]);
        let provider =
            BrightDataProvider::from_context(WebStackContext::new(root, &keyed)).expect("present");
        assert_eq!(provider.zone, DEFAULT_ZONE);
        assert!(!format!("{provider:?}").contains("test-key"));

        let zoned = WorkjetRuntimeConfigStore::new([
            (SECRET_NAME, "test-key"),
            (ZONE_CONFIG_KEY, "serp_de"),
        ]);
        assert_eq!(
            BrightDataProvider::from_context(WebStackContext::new(root, &zoned))
                .unwrap()
                .zone,
            "serp_de"
        );
        let bad_zone = WorkjetRuntimeConfigStore::new([
            (SECRET_NAME, "test-key"),
            (ZONE_CONFIG_KEY, "a b/../c"),
        ]);
        assert_eq!(
            BrightDataProvider::from_context(WebStackContext::new(root, &bad_zone))
                .unwrap()
                .zone,
            DEFAULT_ZONE
        );
    }

    /// One-shot HTTP fixture that records the raw request and answers with
    /// `status` + `body`.
    pub(in crate::web_search) fn spawn_serp_fixture(
        status: u16,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("fixture listener");
        let address = listener.local_addr().expect("fixture address");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fixture accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout");
            let mut raw = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    break;
                }
                raw.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&raw);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let content_length = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if raw.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).expect("fixture reply");
            String::from_utf8_lossy(&raw).into_owned()
        });
        (format!("http://{address}/request"), handle)
    }

    pub(in crate::web_search) fn fixture_config(endpoint: &str) -> SearchConfig {
        let mut config = super::super::tests::test_config(ProviderKind::Auto);
        config.brightdata_endpoint = endpoint.to_string();
        config.egress_allow_hosts = vec!["127.0.0.1".to_string()];
        config
    }

    #[test]
    fn mocked_serp_request_carries_zone_url_and_bearer_key() {
        let (endpoint, handle) = spawn_serp_fixture(200, ORGANIC_FIXTURE);
        let config = fixture_config(&endpoint);
        let provider = BrightDataProvider::for_test("test-key", "ctox_serp");
        let response = brightdata_search(&config, &provider, &query("Kiesow Einkauf", Some("CH")))
            .expect("brightdata search");
        let request = handle.join().expect("fixture thread");
        assert!(request.starts_with("POST /request "), "{request}");
        assert!(
            request.contains("Authorization: Bearer test-key"),
            "{request}"
        );
        // Bright Data returns an empty body when JSON is requested via Accept.
        assert!(
            !request
                .to_ascii_lowercase()
                .contains("accept: application/json"),
            "{request}"
        );
        let body: Value = serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..])
            .expect("json body");
        assert_eq!(body["zone"], "ctox_serp");
        assert_eq!(body["format"], "raw");
        let url = Url::parse(body["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("www.google.ch"));
        assert!(url.query_pairs().any(|(k, v)| k == "brd_json" && v == "1"));
        assert_eq!(response.provider, "brightdata");
        assert_eq!(response.hits.len(), 2);
    }

    #[test]
    fn forbidden_zone_reports_clear_failure_without_leaking_key() {
        let (endpoint, handle) = spawn_serp_fixture(403, r#"{"error":"zone not found"}"#);
        let config = fixture_config(&endpoint);
        let provider = BrightDataProvider::for_test("secret-test-key", "ctox_serp");
        let error = brightdata_search(&config, &provider, &query("Kiesow", None))
            .expect_err("403 must fail");
        handle.join().expect("fixture thread");
        let text = format!("{error:#}");
        assert_eq!(text, "zone ctox_serp unavailable (HTTP 403)");
        assert!(!text.contains("secret-test-key"));
        assert_eq!(
            format!("{:#}", status_error("z", 429)),
            "rate limit (HTTP 429)"
        );
    }
}
