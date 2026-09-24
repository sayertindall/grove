# Grove

A read-only macOS desktop viewer of git working-tree changes across the repositories you
register. It never stages, commits, pushes, pulls, edits files, or opens a network
connection, and it never browses commit history: every reading is the worktree against
`HEAD`. The name is the model: a grove is many trees, and each registered repository is
one tree shown beside the others.

## Stack

| Library | Role |
| --- | --- |
| Tauri 2 | Desktop shell. Four Rust commands and one event cross to the webview. |
| git2 | Opens a repository and reads status plus diff. The only git implementation. |
| notify-debouncer-full 0.7 | Recursive watches on registered roots, 300 ms debounce, then one event. |
| tauri-plugin-store | Persists the project path list in the app data directory. |
| tauri-plugin-dialog | Directory picker, invoked from JavaScript only. |
| React 19 + TypeScript + Vite | UI, `strict` TypeScript. |
| Tailwind CSS 4 + coss ui | The component library. Components are vendored into `src/components/ui`. |
| TanStack Query 5 | Server state for the project list and the open diff. |
| @pierre/diffs 1.4.3 | `CodeView` renders the selected file; Shiki highlighting runs in a worker pool. |
| @pierre/trees 1.0.0-beta.6 | `FileTree` renders the changed files with built-in git status. |

## Run

```bash
pnpm install
pnpm tauri dev
```

## Verify

```bash
./scripts/check_working_tree.sh                      # smoke fixture, then the cargo tests
pnpm build                                           # tsc --strict, then vite
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
GROVE_LARGE_REPO=/path/to/a/big/repo \
  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture   # warm read < 500 ms
```

## Layout

- `src-tauri/src/config.rs` persists the path list. `git.rs` reads one repository.
  `discovery.rs` finds repositories. `watch.rs` watches and emits. `commands.rs` adapts
  IPC. `lib.rs` builds the process.
- `src/App.tsx` holds selection and theme. `src/queries.ts` owns the two query keys.
  `src/api/grove.ts` wraps the commands. `src/components/{ProjectSidebar,ChangesTree,DiffViewer}.tsx`
  each own one pane.

## Notes

- **Watcher cache.** The debouncer runs with `NoCache`, not the crate's recommended
  file-id cache. That cache keeps a file id per file under every watched root: with
  eleven real repositories (~7 GB) the process grew from 77 MB to 415 MB in ten seconds
  and reached 3.2 GB, which is what "adding eleven projects broke it" was. Grove only
  needs to know *which project* changed, so the cache buys nothing.
- **Commands are async.** A synchronous command body runs on the main thread, and
  reading eleven repositories takes long enough that the window would stop drawing. The
  reads run on the blocking pool.
- A pane with no content is not shown: with no projects registered, or with a clean
  selected project, the window shows one empty state instead of an empty tree beside an
  empty diff.
