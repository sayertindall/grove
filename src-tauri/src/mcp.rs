//! `grove mcp`: the assistant's nine read-only tools served over MCP on stdio, so
//! an external agent (Claude Code, Codex) reads the same facts the chat does.
//! JSON-RPC goes to stdout; anything else goes to stderr. The tools are
//! `chat::tools` itself — the same specs, the same dispatch, the same
//! registered-project guard — with the project list re-read on every call so a
//! project added in the window is visible without restarting the server.

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde_json::Value;

use crate::chat::load_registered_projects;
use crate::chat::tools::{run_tool, tool_specs, ToolCallRequest, ToolContext};
use crate::error::GroveError;

const INSTRUCTIONS: &str = "Grove's read-only view of the git working trees the user registered \
in the Grove app: status, change lists, diffs, file contents, a search across changed files, \
worktrees, recent commits, file history, and blame. Every path must be inside a registered \
project; call list_projects first. Nothing here writes to a repository.";

/// Serves until the client closes stdin. Returns the exit code.
pub fn run(args: &[String]) -> Result<i32, GroveError> {
    if let Some(extra) = args.first() {
        return Err(GroveError::usage(format!(
            "mcp takes no arguments, got `{extra}`"
        )));
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| GroveError::io("mcp runtime", error))?;
    runtime.block_on(serve())
}

async fn serve() -> Result<i32, GroveError> {
    eprintln!(
        "grove mcp: serving {} read-only tools on stdio",
        tool_specs().len()
    );
    let service = GroveTools
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|error| GroveError::io("mcp", std::io::Error::other(error.to_string())))?;
    service
        .waiting()
        .await
        .map_err(|error| GroveError::io("mcp", std::io::Error::other(error.to_string())))?;
    Ok(0)
}

/// The MCP view of `chat::tools`.
pub fn mcp_tools() -> Vec<Tool> {
    let read_only = ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false);
    tool_specs()
        .into_iter()
        .map(|(name, description, schema)| {
            let schema = match schema {
                Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            Tool::new(name, description, Arc::new(schema)).with_annotations(read_only.clone())
        })
        .collect()
}

/// Runs one call through the chat's dispatch. A tool failure is a tool result
/// the caller can read, not a protocol error.
pub fn call_tool(name: &str, arguments: Option<&serde_json::Map<String, Value>>) -> CallToolResult {
    let context = match load_registered_projects() {
        Ok(projects) => ToolContext { projects },
        Err(error) => return CallToolResult::error(vec![ContentBlock::text(error)]),
    };
    let call = ToolCallRequest {
        id: String::new(),
        name: name.to_string(),
        arguments: arguments
            .map(|map| Value::Object(map.clone()).to_string())
            .unwrap_or_default(),
    };
    match run_tool(&context, &call) {
        Ok(outcome) => CallToolResult::success(vec![ContentBlock::text(outcome.content)]),
        Err(error) => CallToolResult::error(vec![ContentBlock::text(error)]),
    }
}

struct GroveTools;

impl ServerHandler for GroveTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("grove", env!("CARGO_PKG_VERSION")).with_title("Grove"),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(mcp_tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        if !tool_specs().iter().any(|(known, _, _)| *known == name) {
            return Err(ErrorData::invalid_params(
                format!("unknown tool `{name}`"),
                None,
            ));
        }
        tokio::task::spawn_blocking(move || call_tool(&name, request.arguments.as_ref()))
            .await
            .map(CallToolResponse::from)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))
    }
}
