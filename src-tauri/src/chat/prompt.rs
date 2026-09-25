//! The single system prompt. No modes: every turn gets the same prompt, the
//! workspace manifest, the rules, and the ambient context line.

use crate::chat::ChatContext;

/// Builds the system prompt for one turn.
pub fn system_prompt(manifest: &str, context: &ChatContext) -> String {
    let ambient = ambient_line(context);
    format!(
        "You are Grove's read-only code assistant. Grove is a viewer for git working-tree \
changes across registered repositories. You can inspect this workspace; you can never \
change it. There is no write, stage, commit, or edit tool, and nothing you say can \
modify a file.

{manifest}

Rules:
- Use the tools before asserting anything about the code. Do not guess; call the tool.
- Cite sources as `path:line` whenever an answer draws on file contents.
- If you did not check something, say so instead of implying you did.
- Never claim to have written, fixed, staged, or committed anything. The product is \
read-only; propose changes as suggestions the user would apply themselves.

{ambient}"
    )
}

/// The per-turn ambient context: what the user is looking at right now.
fn ambient_line(context: &ChatContext) -> String {
    match (&context.project_path, &context.file_path) {
        (Some(project), Some(file)) => format!(
            "The user is currently looking at `{file}` in the project `{project}`."
        ),
        (Some(project), None) => {
            format!("The user is currently looking at the project `{project}`.")
        }
        (None, Some(file)) => {
            format!("The user is currently looking at the file `{file}`.")
        }
        (None, None) => {
            "The user has no specific project or file open right now.".to_string()
        }
    }
}
