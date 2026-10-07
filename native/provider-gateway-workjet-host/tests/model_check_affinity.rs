use std::{future::Future, pin::Pin, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use workjet_provider_gateway::{
    internal::api::{account_selection, server::serve_provider_connection},
    sdk::{
        api::handlers::{
            claude::code_handlers::claude_models_response,
            openai::openai_responses_handlers::{
                OpenAiResponsesHttpResponse, OpenAiResponsesRouteHandler,
                OpenAiResponsesRouteResponse,
            },
        },
        cliproxy::auth::{conductor_execution::AccountPolicy, AccountCandidate},
    },
};
use workjet_provider_gateway_host::{
    account_policy::AccountState, secret_store::WorkjetSecretStore,
};

struct PolicyHandler {
    policy: Arc<AccountState>,
    accounts: Vec<AccountCandidate>,
}
impl OpenAiResponsesRouteHandler for PolicyHandler {
    fn handle_provider_route<'a>(
        &'a self,
        _provider: Option<&'a str>,
        body: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = OpenAiResponsesRouteResponse> + Send + 'a>> {
        Box::pin(async move {
            let candidate = self
                .policy
                .select(
                    "codex",
                    Some("gpt-5"),
                    1000,
                    &account_selection::candidates(&self.accounts),
                    &[],
                    body,
                )
                .unwrap();
            account_selection::record_selected(&candidate.auth_id);
            OpenAiResponsesRouteResponse::Buffered(OpenAiResponsesHttpResponse::json(
                200,
                b"{}".to_vec(),
            ))
        })
    }
}

#[tokio::test]
async fn diagnostic_http_pin_does_not_move_a_usable_persisted_session() {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let open = || {
        AccountState::open(Arc::new(
            WorkjetSecretStore::new(dir.path().into()).unwrap(),
        ))
        .unwrap()
    };
    let policy = open();
    let accounts = ["a", "b"]
        .map(|id| AccountCandidate {
            auth_id: id.into(),
            provider: "codex".into(),
            supported_models: vec!["gpt-*".into()],
            ..Default::default()
        })
        .to_vec();
    let body = br#"{"model":"gpt-5","prompt_cache_key":"live-session","input":[{"role":"user","content":"Hi"}]}"#;
    assert_eq!(
        policy
            .select("codex", Some("gpt-5"), 1000, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    let request = format!("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-CTOX-Account: b\r\nX-CTOX-Purpose: model-check\r\nContent-Length: {}\r\n\r\n{}", body.len(), std::str::from_utf8(body).unwrap());
    let handler = PolicyHandler {
        policy: policy.clone(),
        accounts: accounts.clone(),
    };
    let (mut client, mut server) = tokio::io::duplex(4096);
    let client_task = tokio::spawn(async move {
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    });
    serve_provider_connection(&mut server, &handler, None::<&dyn workjet_provider_gateway::sdk::api::handlers::claude::code_handlers::ClaudeMessagesRouteHandler>, &claude_models_response(&[], false), None).await.unwrap();
    drop(server);
    assert!(client_task
        .await
        .unwrap()
        .contains("X-CTOX-Account-Selected: b"));
    assert_eq!(
        policy
            .select("codex", Some("gpt-5"), 1001, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
    drop(handler);
    drop(policy);
    assert_eq!(
        open()
            .select("codex", Some("gpt-5"), 1002, &accounts, &[], body)
            .unwrap()
            .auth_id,
        "a"
    );
}
