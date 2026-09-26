//! The one error type of the repository readers and the command boundary. The
//! webview receives `{ code, message, path? }`; the CLI maps the code to its exit
//! status. `message` is the full display text, path context included.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum GroveError {
    #[error("{path}: not a git repository")]
    NotARepository { path: String },
    #[error("{path}: the path is gone")]
    Missing { path: String },
    #[error("{path}: permission denied")]
    PermissionDenied { path: String },
    #[error("{path}: not inside a registered project")]
    OutsideRegisteredProjects { path: String },
    /// A CLI project word that names no registered project.
    #[error("`{name}` is not a registered project (registered: {registered})")]
    UnknownProject { name: String, registered: String },
    #[error("{path}: no {view} change")]
    NoChange { path: String, view: String },
    #[error("{context}: {source}")]
    Git {
        context: String,
        #[source]
        source: git2::Error,
    },
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    /// A malformed argument: an unknown view, an out-of-range context, an empty path,
    /// an ambiguous or unknown CLI word. The CLI exits 2 on it.
    #[error("{message}")]
    Usage { message: String },
    /// The project store could not be read or written.
    #[error("{message}")]
    Store { message: String },
    /// A chat-side failure (settings, keys, history, provider), carried as text.
    #[error("{message}")]
    Chat { message: String },
    /// A background read that did not finish (panicked or was cancelled).
    #[error("the read task did not finish: {message}")]
    Task { message: String },
}

impl GroveError {
    /// The stable wire code of each variant.
    pub fn code(&self) -> &'static str {
        match self {
            GroveError::NotARepository { .. } => "not_a_repository",
            GroveError::Missing { .. } => "missing",
            GroveError::PermissionDenied { .. } => "permission_denied",
            GroveError::OutsideRegisteredProjects { .. } => "outside_registered_projects",
            GroveError::UnknownProject { .. } => "unknown_project",
            GroveError::NoChange { .. } => "no_change",
            GroveError::Git { .. } => "git",
            GroveError::Io { .. } => "io",
            GroveError::Usage { .. } => "usage",
            GroveError::Store { .. } => "store",
            GroveError::Chat { .. } => "chat",
            GroveError::Task { .. } => "task",
        }
    }

    /// The path the failure is about, when it names one.
    pub fn path(&self) -> Option<&str> {
        match self {
            GroveError::NotARepository { path }
            | GroveError::Missing { path }
            | GroveError::PermissionDenied { path }
            | GroveError::OutsideRegisteredProjects { path }
            | GroveError::NoChange { path, .. } => Some(path),
            _ => None,
        }
    }

    /// The CLI's process status: 2 for a usage error, 1 for everything else.
    pub fn exit_code(&self) -> i32 {
        match self {
            GroveError::Usage { .. } => 2,
            _ => 1,
        }
    }

    /// A filesystem failure on `path`. Not-found and permission failures get their own
    /// codes so the UI can tell a moved project from an unreadable one.
    pub fn io(path: impl Into<String>, source: std::io::Error) -> GroveError {
        let path = path.into();
        match source.kind() {
            std::io::ErrorKind::NotFound => GroveError::Missing { path },
            std::io::ErrorKind::PermissionDenied => GroveError::PermissionDenied { path },
            _ => GroveError::Io {
                context: path,
                source,
            },
        }
    }

    pub fn git(context: impl Into<String>, source: git2::Error) -> GroveError {
        GroveError::Git {
            context: context.into(),
            source,
        }
    }

    pub fn usage(message: impl Into<String>) -> GroveError {
        GroveError::Usage {
            message: message.into(),
        }
    }

    pub fn store(message: impl Into<String>) -> GroveError {
        GroveError::Store {
            message: message.into(),
        }
    }

    pub fn chat(message: impl Into<String>) -> GroveError {
        GroveError::Chat {
            message: message.into(),
        }
    }
}

/// The chat tool loop reports failures to the model as text.
impl From<GroveError> for String {
    fn from(error: GroveError) -> String {
        error.to_string()
    }
}

impl Serialize for GroveError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let path = self.path();
        let fields = if path.is_some() { 3 } else { 2 };
        let mut state = serializer.serialize_struct("GroveError", fields)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        if let Some(path) = path {
            state.serialize_field("path", path)?;
        }
        state.end()
    }
}
