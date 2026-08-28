// ref: internal/auth/antigravity/auth_test.go @ a88197f845c979132c8978ea223c6af05cc81536
// Port-Status: adapted_to_ctox
// SPDX-License-Identifier: MIT OR AGPL-3.0-only

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::sdk::auth::LoginCancellation;

use super::{
    AntigravityAuth, AntigravityAuthErrorKind, AntigravityFlowTransport, AntigravityHttpMethod,
    AntigravityHttpRequest, AntigravityHttpResponse, AntigravityHttpTransportFailure,
    AntigravityOAuthClientCredentials, AntigravityOAuthClientCredentialsError, SecretString,
};

const TEST_CLIENT_ID: &str = "workjet-test-client-id";
const TEST_CLIENT_SECRET: &str = "workjet-test-client-secret";

#[derive(Debug)]
struct CapturedRequest {
    method: AntigravityHttpMethod,
    url: String,
    headers: std::collections::BTreeMap<String, String>,
    body: Vec<u8>,
}

struct ScriptTransport {
    responses: Mutex<VecDeque<AntigravityHttpResponse>>,
    requests: Mutex<Vec<CapturedRequest>>,
}

impl ScriptTransport {
    fn new(responses: impl IntoIterator<Item = AntigravityHttpResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> std::sync::MutexGuard<'_, Vec<CapturedRequest>> {
        self.requests.lock().unwrap()
    }
}

impl AntigravityFlowTransport for ScriptTransport {
    fn execute<'a>(
        &'a self,
        request: &'a AntigravityHttpRequest,
        timeout: Duration,
        _: &'a LoginCancellation,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AntigravityHttpResponse, AntigravityHttpTransportFailure>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            assert_eq!(timeout, Duration::from_secs(30));
            self.requests.lock().unwrap().push(CapturedRequest {
                method: request.method,
                url: request.url.clone(),
                headers: request.headers.clone(),
                body: request.body.to_vec(),
            });
            Ok(self.responses.lock().unwrap().pop_front().unwrap())
        })
    }
}

fn response(body: &str) -> AntigravityHttpResponse {
    AntigravityHttpResponse::new(200, body.as_bytes().to_vec())
}

fn test_credentials() -> Arc<AntigravityOAuthClientCredentials> {
    Arc::new(AntigravityOAuthClientCredentials::new(TEST_CLIENT_ID, TEST_CLIENT_SECRET).unwrap())
}

fn auth_with(
    responses: impl IntoIterator<Item = AntigravityHttpResponse>,
) -> (AntigravityAuth, Arc<ScriptTransport>) {
    let transport = Arc::new(ScriptTransport::new(responses));
    let auth = AntigravityAuth::new(test_credentials(), transport.clone());
    (auth, transport)
}

fn token() -> SecretString {
    SecretString::new("access-token").unwrap()
}

#[test]
fn oauth_client_credentials_reject_empty_and_whitespace_only_fields() {
    assert_eq!(
        AntigravityOAuthClientCredentials::new("", TEST_CLIENT_SECRET).unwrap_err(),
        AntigravityOAuthClientCredentialsError::EmptyClientId
    );
    assert_eq!(
        AntigravityOAuthClientCredentials::new(" \t\n", TEST_CLIENT_SECRET).unwrap_err(),
        AntigravityOAuthClientCredentialsError::EmptyClientId
    );
    assert_eq!(
        AntigravityOAuthClientCredentials::new(TEST_CLIENT_ID, "").unwrap_err(),
        AntigravityOAuthClientCredentialsError::EmptyClientSecret
    );
    assert_eq!(
        AntigravityOAuthClientCredentials::new(TEST_CLIENT_ID, " \t\n").unwrap_err(),
        AntigravityOAuthClientCredentialsError::EmptyClientSecret
    );
}

#[test]
fn oauth_client_credentials_debug_is_redacted() {
    let rendered = format!("{:?}", test_credentials());
    assert!(!rendered.contains(TEST_CLIENT_ID));
    assert!(!rendered.contains(TEST_CLIENT_SECRET));
    assert!(rendered.contains("[REDACTED]"));
}

#[tokio::test]
async fn fetch_project_id_from_load_code_assist() {
    let (auth, transport) = auth_with([response(
        r#"{"cloudaicompanionProject":"cogent-snow-4mnnp"}"#,
    )]);
    let project = auth
        .fetch_project_id(&LoginCancellation::default(), &token())
        .await
        .unwrap();
    assert_eq!(project, "cogent-snow-4mnnp");

    let requests = transport.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method, AntigravityHttpMethod::Post);
    assert_eq!(
        request.url,
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
    );
    assert_eq!(request.headers["Authorization"], "Bearer access-token");
    assert_eq!(request.headers["Accept"], "*/*");
    assert!(!request.headers.contains_key("X-Goog-Api-Client"));
    assert!(request.headers["User-Agent"].starts_with("antigravity/hub/"));
    assert!(!request.headers["User-Agent"].contains("google-api-nodejs-client/"));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["metadata"]["ideType"], "ANTIGRAVITY");
}

#[tokio::test]
async fn fetch_project_id_falls_back_to_daily_onboard_user() {
    let (auth, transport) = auth_with([
        response(r#"{"allowedTiers":[{"id":"free-tier","isDefault":true}]}"#),
        response(
            r#"{"done":true,"response":{"cloudaicompanionProject":{"id":"cogent-snow-4mnnp","name":"cogent-snow-4mnnp","projectNumber":"22597072101"}}}"#,
        ),
    ]);
    let project = auth
        .fetch_project_id(&LoginCancellation::default(), &token())
        .await
        .unwrap();
    assert_eq!(project, "cogent-snow-4mnnp");

    let requests = transport.requests();
    assert_eq!(requests.len(), 2);
    let request = &requests[1];
    assert_eq!(
        request.url,
        "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser"
    );
    assert_eq!(request.headers["Authorization"], "Bearer access-token");
    assert_eq!(request.headers["Accept"], "*/*");
    assert_eq!(request.headers["X-Goog-Api-Client"], "gl-node/22.21.1");
    assert!(request.headers["User-Agent"].starts_with("antigravity/hub/"));
    assert!(request.headers["User-Agent"].contains("google-api-nodejs-client/10.3.0"));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["tier_id"], "free-tier");
    assert_eq!(body["metadata"]["ide_type"], "ANTIGRAVITY");
    assert_eq!(body["metadata"]["ide_version"], "2.2.1");
}

#[tokio::test]
async fn current_tier_and_alternate_project_shapes_are_supported() {
    let (auth, transport) = auth_with([
        response(r#"{"currentTier":{"id":"paid-tier"}}"#),
        response(r#"{"done":true,"response":{"projectId":" project-42 "}}"#),
    ]);
    assert_eq!(
        auth.fetch_project_id(&LoginCancellation::default(), &token())
            .await
            .unwrap(),
        "project-42"
    );
    let requests = transport.requests();
    let body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(body["tier_id"], "paid-tier");
}

#[tokio::test]
async fn token_exchange_uses_form_contract_and_redacts_secrets() {
    let (auth, transport) = auth_with([response(
        r#"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":3600,"token_type":"Bearer"}"#,
    )]);
    let token_response = auth
        .exchange_code_for_tokens(
            &LoginCancellation::default(),
            "oauth-code",
            "http://localhost:51121/oauth-callback",
        )
        .await
        .unwrap();
    assert_eq!(token_response.access_token().expose_secret(), "access-new");
    assert_eq!(
        token_response.refresh_token().unwrap().expose_secret(),
        "refresh-new"
    );
    assert_eq!(token_response.expires_in, 3600);
    let rendered = format!("{token_response:?}");
    assert!(!rendered.contains("access-new"));
    assert!(!rendered.contains("refresh-new"));

    let requests = transport.requests();
    assert_eq!(requests[0].url, "https://oauth2.googleapis.com/token");
    let form: std::collections::HashMap<_, _> = url::form_urlencoded::parse(&requests[0].body)
        .into_owned()
        .collect();
    assert_eq!(form["code"], "oauth-code");
    assert_eq!(form["client_id"], TEST_CLIENT_ID);
    assert_eq!(form["client_secret"], TEST_CLIENT_SECRET);
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(
        form["redirect_uri"],
        "http://localhost:51121/oauth-callback"
    );
}

#[tokio::test]
async fn independently_configured_clients_remain_isolated_under_concurrent_use() {
    struct ConcurrentTransport {
        barrier: Arc<tokio::sync::Barrier>,
        body: Mutex<Option<Vec<u8>>>,
    }

    impl AntigravityFlowTransport for ConcurrentTransport {
        fn execute<'a>(
            &'a self,
            request: &'a AntigravityHttpRequest,
            _: Duration,
            _: &'a LoginCancellation,
        ) -> Pin<
            Box<
                dyn Future<
                        Output = Result<AntigravityHttpResponse, AntigravityHttpTransportFailure>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                *self.body.lock().unwrap() = Some(request.body.to_vec());
                self.barrier.wait().await;
                Ok(response(
                    r#"{"access_token":"access","refresh_token":"refresh","expires_in":3600}"#,
                ))
            })
        }
    }

    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let first_transport = Arc::new(ConcurrentTransport {
        barrier: Arc::clone(&barrier),
        body: Mutex::new(None),
    });
    let second_transport = Arc::new(ConcurrentTransport {
        barrier,
        body: Mutex::new(None),
    });
    let first_id = "workjet-test-client-id-a";
    let first_secret = "workjet-test-client-secret-a";
    let second_id = "workjet-test-client-id-b";
    let second_secret = "workjet-test-client-secret-b";
    let first = AntigravityAuth::new(
        Arc::new(AntigravityOAuthClientCredentials::new(first_id, first_secret).unwrap()),
        first_transport.clone(),
    );
    let second = AntigravityAuth::new(
        Arc::new(AntigravityOAuthClientCredentials::new(second_id, second_secret).unwrap()),
        second_transport.clone(),
    );

    let first_url = url::Url::parse(&first.build_auth_url("state-a", None)).unwrap();
    let second_url = url::Url::parse(&second.build_auth_url("state-b", None)).unwrap();
    let first_query: std::collections::HashMap<_, _> =
        first_url.query_pairs().into_owned().collect();
    let second_query: std::collections::HashMap<_, _> =
        second_url.query_pairs().into_owned().collect();
    assert_eq!(first_query["client_id"], first_id);
    assert_eq!(second_query["client_id"], second_id);

    let cancellation = LoginCancellation::default();
    let (first_result, second_result) = tokio::join!(
        first.exchange_code_for_tokens(&cancellation, "code-a", "http://localhost/a"),
        second.exchange_code_for_tokens(&cancellation, "code-b", "http://localhost/b"),
    );
    first_result.unwrap();
    second_result.unwrap();

    let parse = |transport: &ConcurrentTransport| {
        url::form_urlencoded::parse(transport.body.lock().unwrap().as_ref().unwrap())
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>()
    };
    let first_form = parse(&first_transport);
    let second_form = parse(&second_transport);
    assert_eq!(first_form["client_id"], first_id);
    assert_eq!(first_form["client_secret"], first_secret);
    assert_eq!(second_form["client_id"], second_id);
    assert_eq!(second_form["client_secret"], second_secret);
    assert_ne!(first_form["client_id"], second_form["client_id"]);
    assert_ne!(first_form["client_secret"], second_form["client_secret"]);
}

#[tokio::test]
async fn fetch_user_info_requires_a_nonempty_email() {
    let (auth, transport) = auth_with([response(r#"{"email":" user@example.com "}"#)]);
    assert_eq!(
        auth.fetch_user_info(&LoginCancellation::default(), &token())
            .await
            .unwrap(),
        "user@example.com"
    );
    {
        let requests = transport.requests();
        assert_eq!(requests[0].method, AntigravityHttpMethod::Get);
        assert_eq!(
            requests[0].url,
            "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
        );
    }

    let (auth, _) = auth_with([response(r#"{"email":"  "}"#)]);
    assert_eq!(
        auth.fetch_user_info(&LoginCancellation::default(), &token())
            .await
            .unwrap_err()
            .kind,
        AntigravityAuthErrorKind::MissingEmail
    );
}

#[tokio::test]
async fn provider_errors_do_not_echo_response_or_request_secrets() {
    let secret_body = "provider oauth-code access-token must-not-leak";
    let (auth, _) = auth_with([AntigravityHttpResponse::new(
        403,
        secret_body.as_bytes().to_vec(),
    )]);
    let error = auth
        .fetch_user_info(&LoginCancellation::default(), &token())
        .await
        .unwrap_err();
    assert_eq!(error.kind, AntigravityAuthErrorKind::UserInfo);
    assert_eq!(error.status, Some(403));
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains(secret_body));
    assert!(!rendered.contains("access-token"));
}

#[tokio::test]
async fn cancellation_fences_onboarding_before_transport() {
    let (auth, transport) = auth_with([]);
    let cancellation = LoginCancellation::default();
    cancellation.cancel();
    let error = auth
        .onboard_user(&cancellation, &token(), "free-tier")
        .await
        .unwrap_err();
    assert_eq!(error.kind, AntigravityAuthErrorKind::Cancelled);
    assert!(transport.requests().is_empty());
}
