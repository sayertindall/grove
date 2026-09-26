//! `grove mcp` end to end: the built binary, a throwaway store, one real
//! repository, and a JSON-RPC session over its stdin/stdout.
//!
//! Ways it fails: a log line on stdout corrupts the protocol; the tool list
//! drifts from the chat's nine; a tool reads outside the registered projects;
//! an unknown (say, writing) tool is dispatched instead of refused.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use git2::{Repository, Signature};
use serde_json::{json, Value};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A store registering one repository with a modified file and an untracked one.
fn dirty_store() -> (Scratch, String) {
    let root = std::env::temp_dir().join(format!("grove-mcp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let repo_dir = root.join("repo");
    std::fs::create_dir_all(&repo_dir).expect("repo dir");
    let repo = Repository::init(&repo_dir).expect("init");
    std::fs::write(repo_dir.join("a.txt"), "one\n").expect("write");
    let mut index = repo.index().expect("index");
    index.add_path("a.txt".as_ref()).expect("stage");
    index.write().expect("write index");
    let tree = repo
        .find_tree(index.write_tree().expect("tree"))
        .expect("find tree");
    let who = Signature::now("Grove test", "grove@example.com").expect("signature");
    repo.commit(Some("HEAD"), &who, &who, "initial", &tree, &[])
        .expect("commit");
    std::fs::write(repo_dir.join("a.txt"), "one\ntwo\n").expect("modify");
    std::fs::write(repo_dir.join("b.txt"), "new\n").expect("untracked");
    let project = std::fs::canonicalize(&repo_dir)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    let store = json!({ "projects": [project] }).to_string();
    std::fs::write(root.join("projects.json"), store).expect("store");
    (Scratch(root), project)
}

fn session(data_dir: &PathBuf, requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_grove"))
        .arg("mcp")
        .env("GROVE_DATA_DIR", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn grove mcp");
    let mut stdin = child.stdin.take().expect("stdin");
    for request in requests {
        writeln!(stdin, "{request}").expect("send");
    }
    // Closing stdin ends the session once every reply is written.
    drop(stdin);
    let output = child.wait_with_output().expect("grove mcp output");
    assert!(output.status.success(), "exit: {:?}", output.status);
    String::from_utf8(output.stdout)
        .expect("utf-8 stdout")
        .lines()
        .map(|line| serde_json::from_str(line).expect("every stdout line is JSON-RPC"))
        .collect()
}

fn reply(replies: &[Value], id: u64) -> &Value {
    replies
        .iter()
        .find(|reply| reply["id"] == id)
        .unwrap_or_else(|| panic!("no reply {id} in {replies:?}"))
}

#[test]
fn mcp_serves_the_chat_tools_read_only_and_guarded() {
    let (scratch, project) = dirty_store();
    let call = |id: u64, name: &str, arguments: Value| {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": { "name": name, "arguments": arguments } })
    };
    let replies = session(
        &scratch.0,
        &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "grove-test", "version": "0" } } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            call(3, "list_projects", json!({})),
            call(
                4,
                "read_file",
                json!({ "project": "/etc", "file": "passwd" }),
            ),
            call(5, "write_file", json!({})),
        ],
    );

    assert_eq!(reply(&replies, 1)["result"]["serverInfo"]["name"], "grove");

    let tools = reply(&replies, 2)["result"]["tools"]
        .as_array()
        .expect("tools");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    let chat: Vec<String> = grove_lib::chat::tools::tool_specs()
        .into_iter()
        .map(|(name, _, _)| name)
        .collect();
    assert_eq!(names, chat);
    assert!(tools
        .iter()
        .all(|tool| tool["annotations"]["readOnlyHint"] == true));

    let listed = &reply(&replies, 3)["result"];
    assert_eq!(listed["isError"], false);
    let text = listed["content"][0]["text"].as_str().expect("text");
    let rows: Value = serde_json::from_str(text).expect("list_projects JSON");
    assert_eq!(rows["projects"][0]["path"], project);
    assert_eq!(rows["projects"][0]["state"], "dirty");

    let outside = &reply(&replies, 4)["result"];
    assert_eq!(outside["isError"], true);
    let refusal = outside["content"][0]["text"].as_str().expect("text");
    assert!(
        refusal.contains("not inside a registered project"),
        "{refusal}"
    );

    assert_eq!(reply(&replies, 5)["error"]["code"], -32602);
}
