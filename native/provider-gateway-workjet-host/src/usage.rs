//! Host-owned, content-free inference receipts. One connection produces one receipt.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    future::Future,
    io,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use workjet_provider_gateway::sdk::api::handlers::{
    claude::code_handlers::{ClaudeMessagesRouteHandler, ClaudeMessagesRouteResponse},
    openai::openai_responses_handlers::{
        OpenAiResponsesRouteHandler, OpenAiResponsesRouteResponse,
    },
};

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub completed_at_ms: u64,
    pub provider: String,
    pub model: Option<String>,
    pub model_source: String,
    pub error: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

#[derive(Default)]
pub struct Observation {
    receipt: Option<Receipt>,
    header: Vec<u8>,
    body: Vec<u8>,
    headers_done: bool,
    streaming: bool,
    dropped_line: bool,
    terminal: bool,
    allow_reported_zero: bool,
}
impl Observation {
    fn identify(&mut self, provider: &str, body: &[u8]) {
        self.allow_reported_zero = provider.eq_ignore_ascii_case("codex");
        let model = serde_json::from_slice::<Value>(body).ok().and_then(|v| {
            v.get("model")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty() && m.len() <= 256)
                .map(str::to_owned)
        });
        self.receipt = Some(Receipt {
            provider: provider.to_ascii_lowercase(),
            model,
            model_source: "request".into(),
            ..Receipt::default()
        });
    }
    fn json(&mut self, value: &Value) {
        let allow_reported_zero = self.allow_reported_zero;
        let Some(receipt) = self.receipt.as_mut() else {
            return;
        };
        let event = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(event, "error" | "response.failed" | "response.incomplete") {
            receipt.error = true;
            self.terminal = true;
        }
        if matches!(event, "response.completed" | "message_stop") {
            self.terminal = true;
        }
        let payload = value
            .get("response")
            .or_else(|| value.get("message"))
            .unwrap_or(value);
        if payload
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| matches!(status, "failed" | "incomplete"))
        {
            receipt.error = true;
        }
        if let Some(model) = payload
            .get("model")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty() && m.len() <= 256)
        {
            if self.allow_reported_zero {
                receipt.model = Some(model.to_owned());
                receipt.model_source = "response".into();
            }
        }
        if let Some(usage) = payload.get("usage").or_else(|| value.get("usage")) {
            // Translators may synthesize zero for omitted upstream fields. A
            // positive normalized count is evidence; translated zero is not.
            let measured = |n: u64| allow_reported_zero || n > 0;
            fn number(v: &Value, names: &[&str]) -> Option<u64> {
                names
                    .iter()
                    .find_map(|name| v.get(name).and_then(Value::as_u64))
            }
            if let Some(n) =
                number(usage, &["input_tokens", "prompt_tokens"]).filter(|n| measured(*n))
            {
                receipt.input_tokens = Some(n);
            }
            if let Some(n) =
                number(usage, &["output_tokens", "completion_tokens"]).filter(|n| measured(*n))
            {
                receipt.output_tokens = Some(n);
            }
            if let Some(n) = number(usage, &["cache_read_input_tokens"])
                .or_else(|| {
                    usage
                        .pointer("/input_tokens_details/cached_tokens")
                        .and_then(Value::as_u64)
                })
                .or_else(|| {
                    usage
                        .pointer("/prompt_tokens_details/cached_tokens")
                        .and_then(Value::as_u64)
                })
                .filter(|n| measured(*n))
            {
                receipt.cache_read_tokens = Some(n);
            }
            if let Some(n) =
                number(usage, &["cache_creation_input_tokens"]).filter(|n| measured(*n))
            {
                receipt.cache_write_tokens = Some(n);
            }
        }
    }
    fn observe(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if !self.headers_done {
                if self.header.len() < 32 * 1024 {
                    self.header.push(byte);
                }
                if self.header.ends_with(b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&self.header);
                    self.streaming = header.to_ascii_lowercase().contains("text/event-stream");
                    if let Some(receipt) = self.receipt.as_mut() {
                        receipt.error = header
                            .split_whitespace()
                            .nth(1)
                            .and_then(|s| s.parse::<u16>().ok())
                            .map_or(true, |status| status >= 400);
                    }
                    self.header.clear();
                    self.headers_done = true;
                }
            } else if self.streaming {
                if byte == b'\n' {
                    if !self.dropped_line {
                        let line = std::mem::take(&mut self.body);
                        if let Some(data) = line
                            .strip_prefix(b"data: ")
                            .or_else(|| line.strip_prefix(b"data:"))
                        {
                            if data == b"[DONE]" || data == b"[DONE]\r" {
                                self.terminal = true;
                            } else if let Ok(value) = serde_json::from_slice::<Value>(data) {
                                self.json(&value);
                            }
                        }
                    }
                    self.body.clear();
                    self.dropped_line = false;
                } else if self.body.len() < 2 * 1024 * 1024 && !self.dropped_line {
                    self.body.push(byte);
                } else {
                    self.body.clear();
                    self.dropped_line = true;
                }
            } else if self.body.len() < 2 * 1024 * 1024 && !self.dropped_line {
                self.body.push(byte);
            } else {
                self.body.clear();
                self.dropped_line = true;
            }
        }
    }
    pub fn finish(&mut self, transport_error: bool) -> Option<Receipt> {
        if !self.streaming && !self.dropped_line {
            if let Ok(value) = serde_json::from_slice::<Value>(&self.body) {
                self.json(&value);
            }
        }
        let mut receipt = self.receipt.take()?;
        receipt.error |=
            transport_error || !self.headers_done || (self.streaming && !self.terminal);
        receipt.completed_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
            .try_into()
            .ok()?;
        Some(receipt)
    }
}

pub struct ObservedResponses<'a> {
    pub inner: &'a dyn OpenAiResponsesRouteHandler,
    pub observation: Arc<Mutex<Observation>>,
    pub default_provider: &'a str,
}
impl OpenAiResponsesRouteHandler for ObservedResponses<'_> {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = OpenAiResponsesRouteResponse> + Send + 'a>> {
        self.observation
            .lock()
            .unwrap()
            .identify(provider.unwrap_or(self.default_provider), body);
        self.inner.handle_provider_route(provider, body)
    }
}
pub struct ObservedMessages<'a> {
    pub inner: &'a dyn ClaudeMessagesRouteHandler,
    pub observation: Arc<Mutex<Observation>>,
    pub default_provider: &'a str,
}
impl ClaudeMessagesRouteHandler for ObservedMessages<'_> {
    fn handle_provider_route<'a>(
        &'a self,
        provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = ClaudeMessagesRouteResponse> + Send + 'a>> {
        {
            let mut observation = self.observation.lock().unwrap();
            observation.identify(provider.unwrap_or(self.default_provider), body);
            observation.allow_reported_zero = provider
                .unwrap_or(self.default_provider)
                .eq_ignore_ascii_case("claude");
        }
        self.inner.handle_provider_route(provider, body)
    }
}
pub struct ObservedStream<'a, S> {
    pub inner: &'a mut S,
    pub observation: Arc<Mutex<Observation>>,
}
impl<S: AsyncRead + Unpin> AsyncRead for ObservedStream<'_, S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_read(cx, buf)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for ObservedStream<'_, S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut *self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &result {
            self.observation.lock().unwrap().observe(&buf[..*n]);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(cx)
    }
}

/// UTC-day journals retain completion timestamps for arbitrary client timezones.
/// fsync before returning; provider bodies and credentials are never serialized.
#[derive(Clone)]
pub struct UsageJournal {
    directory: PathBuf,
    lock: Arc<Mutex<()>>,
}
impl UsageJournal {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            lock: Arc::new(Mutex::new(())),
        }
    }
    pub async fn append(&self, receipt: Receipt) -> io::Result<()> {
        let journal = self.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::{Read, Seek, SeekFrom, Write};
            let _guard = journal
                .lock
                .lock()
                .map_err(|_| io::Error::other("usage lock"))?;
            std::fs::create_dir_all(&journal.directory)?;
            let path = journal
                .directory
                .join(format!("{}.jsonl", receipt.completed_at_ms / 86_400_000));
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true).read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(path)?;
            // Recover only an incomplete crash tail, preserving complete receipts.
            let length = file.metadata()?.len();
            if length > 0 {
                let tail_start = length.saturating_sub(4096);
                file.seek(SeekFrom::Start(tail_start))?;
                let mut tail = Vec::new();
                file.read_to_end(&mut tail)?;
                if tail.last() != Some(&b'\n') {
                    let complete = tail
                        .iter()
                        .rposition(|b| *b == b'\n')
                        .map(|n| tail_start + n as u64 + 1)
                        .unwrap_or(0);
                    file.set_len(complete)?;
                }
            }

            let mut bytes = serde_json::to_vec(&receipt)?;
            bytes.push(b'\n');
            file.write_all(&bytes)?;
            file.sync_data()
        })
        .await
        .map_err(|_| io::Error::other("usage writer"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_usage_is_replaced_not_added_and_actual_model_wins() {
        let mut o = Observation::default();
        o.identify("codex", br#"{"model":"alias"}"#);
        let bytes = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-6\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\ndata: [DONE]\n\n";
        for chunk in bytes.chunks(7) {
            o.observe(chunk);
        }
        let r = o.finish(false).unwrap();
        assert_eq!(r.model.as_deref(), Some("gpt-6"));
        assert_eq!(r.input_tokens, Some(10));
        assert_eq!(r.cache_read_tokens, Some(3));
        assert!(!r.error);
        assert!(o.finish(false).is_none());
    }
    #[test]
    fn messages_merge_distinct_usage_fields_and_incomplete_stream_is_error() {
        let mut o = Observation::default();
        o.identify("claude", br#"{"model":"sonnet"}"#);
        o.observe(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n");
        let r = o.finish(false).unwrap();
        assert_eq!(r.input_tokens, Some(12));
        assert_eq!(r.output_tokens, Some(7));
        assert_eq!(r.cache_read_tokens, None);
        assert!(r.error);
    }
    #[test]
    fn translated_missing_usage_is_not_a_measured_zero() {
        let mut o = Observation::default();
        o.identify("antigravity", br#"{"model":"gemini"}"#);
        o.observe(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"model\":\"synthetic\",\"usage\":{\"input_tokens\":0,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":0}}}");
        let r = o.finish(false).unwrap();
        assert_eq!(r.input_tokens, None);
        assert_eq!(r.output_tokens, Some(2));
        assert_eq!(r.cache_read_tokens, None);
        assert_eq!(r.model_source, "request");
    }
    struct FakeResponses;
    impl OpenAiResponsesRouteHandler for FakeResponses {
        fn handle_provider_route<'a>(
            &'a self,
            _provider: Option<&'a str>,
            _body: &'a [u8],
        ) -> Pin<Box<dyn Future<Output = OpenAiResponsesRouteResponse> + Send + 'a>> {
            Box::pin(async {
                OpenAiResponsesRouteResponse::Buffered(workjet_provider_gateway::sdk::api::handlers::openai::openai_responses_handlers::OpenAiResponsesHttpResponse::json(200, br#"{"model":"gpt-actual","usage":{"input_tokens":0,"output_tokens":8}}"#.to_vec()))
            })
        }
    }
    #[tokio::test]
    async fn server_dispatch_records_one_real_inference_and_excludes_catalog_reads() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use workjet_provider_gateway::internal::api::server::serve_provider_connection;
        use workjet_provider_gateway::sdk::api::handlers::claude::code_handlers::claude_models_response;
        for (request, expected) in [
            ("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 17\r\n\r\n{\"model\":\"alias\"}", true),
            ("GET /v1/models HTTP/1.1\r\nHost: localhost\r\n\r\n", false),
        ] {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let client_task = tokio::spawn(async move { client.write_all(request.as_bytes()).await.unwrap(); let mut response = Vec::new(); client.read_to_end(&mut response).await.unwrap(); response });
            let observation = Arc::new(Mutex::new(Observation::default()));
            let handler = ObservedResponses { inner: &FakeResponses, observation: observation.clone(), default_provider: "codex" };
            let mut stream = ObservedStream { inner: &mut server, observation: observation.clone() };
            serve_provider_connection(&mut stream, &handler, None::<&dyn ClaudeMessagesRouteHandler>, &claude_models_response(&[], false), None).await.unwrap();
            drop(server); client_task.await.unwrap();
            let receipt = observation.lock().unwrap().finish(false);
            assert_eq!(receipt.is_some(), expected);
            if let Some(receipt) = receipt { assert_eq!(receipt.model.as_deref(), Some("gpt-actual")); assert_eq!(receipt.input_tokens, Some(0)); assert_eq!(receipt.output_tokens, Some(8)); assert!(!receipt.error); }
        }
    }
    #[tokio::test]
    async fn receipt_survives_a_new_journal_instance() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = Receipt {
            completed_at_ms: 86_400_000,
            provider: "codex".into(),
            ..Receipt::default()
        };
        UsageJournal::new(dir.path().into())
            .append(receipt.clone())
            .await
            .unwrap();
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("1.jsonl"))
            .unwrap()
            .write_all(b"{\"crashed\":")
            .unwrap();
        UsageJournal::new(dir.path().into())
            .append(receipt)
            .await
            .unwrap();
        let text = std::fs::read_to_string(dir.path().join("1.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains("prompt"));
    }
}
