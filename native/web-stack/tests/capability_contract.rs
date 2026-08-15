use ctox_web_stack::{
    execute_web_stack_capability, web_stack_capability_contracts, RuntimeConfigStore,
    WebStackCapabilityErrorKind, WebStackCapabilityLimits, WebStackCapabilityTool, WebStackContext,
    WorkjetRuntimeConfigStore,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/capability-adapter-v1.json")).unwrap()
}

fn tool_for_name(name: &str) -> WebStackCapabilityTool {
    match name {
        "web_search" => WebStackCapabilityTool::Search,
        "web_read" => WebStackCapabilityTool::Read,
        "web_deep_research" => WebStackCapabilityTool::DeepResearch,
        "web_browser_prepare" => WebStackCapabilityTool::BrowserPrepare,
        "web_browser_automate" => WebStackCapabilityTool::BrowserAutomate,
        _ => panic!("unknown fixture tool"),
    }
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "web-stack-capability-{label}-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ))
}

fn collect_property_names(schema: &Value, names: &mut Vec<String>) {
    match schema {
        Value::Array(items) => {
            for item in items {
                collect_property_names(item, names);
            }
        }
        Value::Object(object) => {
            if let Some(properties) = object.get("properties").and_then(Value::as_object) {
                names.extend(properties.keys().cloned());
            }
            for value in object.values() {
                collect_property_names(value, names);
            }
        }
        _ => {}
    }
}

#[test]
fn public_contracts_match_fixture_grants_and_remain_closed() {
    let fixture = fixture();
    let contracts = web_stack_capability_contracts().unwrap();
    let expected = fixture["tools"].as_array().unwrap();
    assert_eq!(contracts.len(), expected.len());

    for (contract, expected) in contracts.iter().zip(expected) {
        assert_eq!(
            contract.tool,
            tool_for_name(expected["name"].as_str().unwrap())
        );
        assert_eq!(contract.name, expected["name"]);
        assert_eq!(contract.capability_id, expected["capabilityId"]);
        assert_eq!(contract.contract_version, expected["contractVersion"]);
        assert!(!contract.description.is_empty());
        assert_eq!(contract.input_schema["additionalProperties"], false);
        assert_eq!(contract.output_schema["additionalProperties"], false);
    }

    let browser = contracts
        .iter()
        .find(|contract| contract.tool == WebStackCapabilityTool::BrowserAutomate)
        .unwrap();
    let actions = browser.input_schema["properties"]["actions"]["items"]["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|schema| schema["properties"]["action"]["const"].clone())
        .collect::<Vec<_>>();
    assert_eq!(Value::Array(actions), fixture["browserActions"]);

    let forbidden = fixture["outputCanaries"]["forbiddenFields"]
        .as_array()
        .unwrap()
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .unwrap();
    let forbidden_arguments = fixture["stateSeparation"]["argumentForbidden"]
        .as_array()
        .unwrap()
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .unwrap();
    for contract in &contracts {
        let mut output_names = Vec::new();
        collect_property_names(&contract.output_schema, &mut output_names);
        assert!(output_names
            .iter()
            .all(|name| !forbidden.contains(&name.as_str())));

        let mut input_names = Vec::new();
        collect_property_names(&contract.input_schema, &mut input_names);
        assert!(input_names
            .iter()
            .all(|name| !forbidden_arguments.contains(&name.as_str())));
    }
    assert_eq!(fixture["hostBudgets"], json!([2 * 1024 * 1024, 256 * 1024]));
}

struct PanicConfig;

impl RuntimeConfigStore for PanicConfig {
    fn get(&self, _: &str) -> Option<String> {
        panic!("invalid arguments reached runtime configuration")
    }
}

#[test]
fn fixture_invalid_inputs_fail_before_network_browser_or_config_access() {
    let fixture = fixture();
    let root = Path::new("/host-owned/root/that/must/not/be/read");
    let config = PanicConfig;
    for case in fixture["invalidInputs"].as_array().unwrap() {
        let mut arguments = case["arguments"].clone();
        if arguments.get("query").and_then(Value::as_str) == Some("__OVER_2000_CHARS__") {
            arguments["query"] = Value::String("😀".repeat(2_001));
        }
        let error = execute_web_stack_capability(
            WebStackContext::new(root, &config),
            tool_for_name(case["tool"].as_str().unwrap()),
            arguments,
            WebStackCapabilityLimits {
                max_response_bytes: 256 * 1024,
            },
        )
        .unwrap_err();
        assert_eq!(
            error.kind(),
            WebStackCapabilityErrorKind::InvalidArguments,
            "fixture reason {}",
            case["reason"]
        );
    }
}

#[test]
fn public_search_projection_is_exact_and_honors_both_host_budgets() {
    let fixture = fixture();
    let search_arguments = fixture["validInputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["tool"] == "web_search")
        .unwrap()["arguments"]
        .clone();
    let root = temp_root("search-budget");
    let store = WorkjetRuntimeConfigStore::new([("CTOX_WEB_SEARCH_PROVIDER", "mock")]);
    let context = WebStackContext::new(&root, &store);

    let response = execute_web_stack_capability(
        context,
        WebStackCapabilityTool::Search,
        search_arguments.clone(),
        WebStackCapabilityLimits {
            max_response_bytes: 256 * 1024,
        },
    )
    .unwrap();
    let bytes = serde_json::to_vec(&response).unwrap();
    assert!(bytes.len() < 256 * 1024);
    let results = response["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["snippet", "title", "url"]
    );
    assert!(!response.to_string().contains("provider"));

    let compacted = execute_web_stack_capability(
        context,
        WebStackCapabilityTool::Search,
        search_arguments,
        WebStackCapabilityLimits {
            max_response_bytes: 32,
        },
    )
    .unwrap();
    assert_eq!(compacted, json!({"results": []}));
    assert!(serde_json::to_vec(&compacted).unwrap().len() < 32);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn errors_are_stable_redacted_and_workjet_state_stays_host_owned() {
    let fixture = fixture();
    assert_eq!(fixture["stateSeparation"]["processEnvironmentReads"], false);
    assert_eq!(
        fixture["stateSeparation"]["ctoxSqliteReadsForWorkjet"],
        false
    );
    assert_eq!(
        fixture["stateSeparation"]["hostOwned"],
        json!(["root", "runtimeConfig", "maxResponseBytes"])
    );

    let marker = fixture["outputCanaries"]["marker"].as_str().unwrap();
    let root = temp_root(marker);
    let database = root.join("runtime/ctox.sqlite3");
    fs::create_dir_all(database.parent().unwrap()).unwrap();
    fs::write(&database, marker.as_bytes()).unwrap();

    let disabled = WorkjetRuntimeConfigStore::new([
        ("CTOX_WEB_SEARCH_ENABLED", "false"),
        ("CTOX_WEB_SEARCH_PROVIDER", marker),
    ]);
    let error = execute_web_stack_capability(
        WebStackContext::new(&root, &disabled),
        WebStackCapabilityTool::Search,
        json!({"query": marker}),
        WebStackCapabilityLimits {
            max_response_bytes: 2 * 1024 * 1024,
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), WebStackCapabilityErrorKind::ExecutionFailure);
    assert_eq!(error.to_string(), "capability execution failed");
    assert!(!format!("{error:?}").contains(marker));
    assert!(!error.to_string().contains(root.to_string_lossy().as_ref()));
    assert_eq!(fs::read(&database).unwrap(), marker.as_bytes());

    let prepare_arguments = fixture["validInputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["tool"] == "web_browser_prepare")
        .unwrap()["arguments"]
        .clone();
    let empty = WorkjetRuntimeConfigStore::default();
    let prepared = execute_web_stack_capability(
        WebStackContext::new(&root, &empty),
        WebStackCapabilityTool::BrowserPrepare,
        prepare_arguments,
        WebStackCapabilityLimits {
            max_response_bytes: 256 * 1024,
        },
    )
    .unwrap();
    assert_eq!(prepared["installAttempted"], false);
    assert_eq!(fs::read(&database).unwrap(), marker.as_bytes());
    assert!(!prepared
        .to_string()
        .contains(root.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(root);
}
