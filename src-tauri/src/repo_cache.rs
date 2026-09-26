//! The last sidebar row and change list of each watched project, reused while the
//! repository has not moved. An entry is valid for one key: the index file's
//! mtime, the HEAD reference and target, and the project's watcher tick. The
//! watcher bumps the tick of every project it reports, before the webview hears
//! about it, so the refetch an event triggers never sees the old entry.
//!
//! Only watched projects are served from here: without a watcher nothing would
//! notice a worktree edit, so an unwatched project is read fresh every time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use git2::Repository;

use crate::error::GroveError;
use crate::git::{
    read_project_changes, read_project_status, refresh_dirty_age, ProjectChanges, ProjectStatus,
};

/// What a cached value was read under. Equal keys mean nothing Grove can observe
/// has changed since.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RepoKey {
    index_mtime: Option<SystemTime>,
    head: Option<String>,
    tick: u64,
}

#[derive(Default)]
struct CachedProject {
    /// Bumped by the watcher; never reset while the app runs.
    tick: u64,
    status: Option<(RepoKey, ProjectStatus)>,
    /// Indexed by `ignore_whitespace`.
    changes: [Option<(RepoKey, ProjectChanges)>; 2],
}

/// Hit and miss totals, for measuring the cache rather than guessing at it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheCounters {
    pub hits: u64,
    pub misses: u64,
}

/// Tauri-managed. Cloning shares the same entries.
#[derive(Clone, Default)]
pub struct RepoCache {
    projects: Arc<Mutex<HashMap<PathBuf, CachedProject>>>,
    hits: Arc<AtomicU64>,
    misses: Arc<AtomicU64>,
}

impl RepoCache {
    /// The sidebar row of one project. `watching` is whether its watcher is armed;
    /// the row's own `watching` field is left for the caller to fill.
    pub fn project_status(&self, path: &str, watching: bool) -> ProjectStatus {
        let Some(key) = self.current_key(path, watching) else {
            return read_project_status(path);
        };
        let cached = self.with_project(path, |entry| fresh(&entry.status, &key));
        if let Some(mut status) = self.count(cached) {
            // The age is relative to now, not to when the row was cached.
            refresh_dirty_age(&mut status);
            return status;
        }
        let status = read_project_status(path);
        let stored = (key, status.clone());
        self.with_project(path, |entry| entry.status = Some(stored));
        status
    }

    /// The change list of one canonical project path.
    pub fn project_changes(
        &self,
        path: &str,
        ignore_whitespace: bool,
        watching: bool,
    ) -> Result<ProjectChanges, GroveError> {
        let Some(key) = self.current_key(path, watching) else {
            return read_project_changes(path, ignore_whitespace);
        };
        let slot = usize::from(ignore_whitespace);
        let cached = self.with_project(path, |entry| fresh(&entry.changes[slot], &key));
        if let Some(changes) = self.count(cached) {
            return Ok(changes);
        }
        let changes = read_project_changes(path, ignore_whitespace)?;
        let stored = (key, changes.clone());
        self.with_project(path, |entry| entry.changes[slot] = Some(stored));
        Ok(changes)
    }

    /// Marks the projects as changed: their entries stop matching, including any
    /// read that started before this call and stores after it.
    pub fn invalidate(&self, paths: &[String]) {
        let mut projects = self.lock();
        for path in paths {
            let entry = projects.entry(PathBuf::from(path)).or_default();
            entry.tick += 1;
            entry.status = None;
            entry.changes = [None, None];
        }
    }

    /// Drops every entry but keeps advancing ticks, for a rebuilt watcher that has
    /// no memory of what happened while a project was unwatched.
    pub fn invalidate_all(&self) {
        let paths: Vec<String> = self
            .lock()
            .keys()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        self.invalidate(&paths);
    }

    pub fn counters(&self) -> CacheCounters {
        CacheCounters {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
        }
    }

    /// The key a read now would be stored under, or `None` when the project must
    /// not be cached (unwatched, or not an openable repository).
    fn current_key(&self, path: &str, watching: bool) -> Option<RepoKey> {
        if !watching {
            return None;
        }
        // The tick is taken before the repository is looked at, so an edit that
        // lands mid-read leaves the stored value already stale.
        let tick = self.with_project(path, |entry| entry.tick);
        repo_key(Path::new(path), tick)
    }

    fn count<T>(&self, cached: Option<T>) -> Option<T> {
        let counter = if cached.is_some() {
            &self.hits
        } else {
            &self.misses
        };
        counter.fetch_add(1, Ordering::Relaxed);
        cached
    }

    fn with_project<T>(&self, path: &str, work: impl FnOnce(&mut CachedProject) -> T) -> T {
        let mut projects = self.lock();
        work(projects.entry(PathBuf::from(path)).or_default())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<PathBuf, CachedProject>> {
        self.projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn fresh<T: Clone>(slot: &Option<(RepoKey, T)>, key: &RepoKey) -> Option<T> {
    slot.as_ref()
        .filter(|(stored, _)| stored == key)
        .map(|(_, value)| value.clone())
}

/// Index mtime and HEAD, read without a status scan.
fn repo_key(path: &Path, tick: u64) -> Option<RepoKey> {
    let repository = Repository::open(path).ok()?;
    let index_mtime = std::fs::metadata(repository.path().join("index"))
        .and_then(|metadata| metadata.modified())
        .ok();
    let head = repository.head().ok().map(|head| {
        let name = head.name().ok().unwrap_or_default().to_string();
        let target = head.target().map(|oid| oid.to_string()).unwrap_or_default();
        format!("{name}@{target}")
    });
    Some(RepoKey {
        index_mtime,
        head,
        tick,
    })
}
