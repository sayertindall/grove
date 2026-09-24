# Repository Guidelines

## Project Overview

Grove is a read-only macOS desktop viewer of working-tree changes across explicitly registered Git repositories. Compare worktrees against `HEAD`, never commit history. Production code must not stage, commit, push, pull, edit repository files, or open network connections. Removing a project only unregisters its path. App-data persistence is limited to the project list.

## Architecture & Data Flow

- React → typed invokes in `src/api/grove.ts` → thin Tauri commands → Rust discovery, Git reads, and config functions. Keep Git/filesystem knowledge out of the webview. The IPC surface is four commands (`scan_for_repos`, `list_projects`, `set_projects`, `get_diff`) and one event (`grove://projects-changed`).
- `src-tauri/src/commands.rs` routes whole-list replacement through `replace_registered_projects`: canonicalize/dedupe paths, save and flush, then rebuild watchers. Startup uses the same writer. Save failure must leave the watcher unchanged; rebuild failure can occur after persistence.
- `src-tauri/src/watch.rs` owns the only long-lived backend state, a Tauri-managed `Mutex<ProjectWatcher>`. Watch project roots recursively, including worktree and `.git` changes; debounce for 300ms. Match events to the longest project-path prefix at path-component boundaries, dedupe, and emit in stored order.
- TanStack Query is the only server-state cache: `['projects']` and `['diff', canonicalPath]`, with `staleTime: Infinity` and retries disabled. Watch events invalidate projects and affected diffs; successful list replacement invalidates all diffs. No polling or focus-based refresh mechanism.
- `App` composes `ProjectSidebar`, `ChangesTree`, and `DiffViewer`. Props down, callbacks up; selection and theme stay in local React state. Providers are composed in `src/main.tsx`; Rust dependencies enter through `AppHandle`, managed state, and ordinary function arguments, not a DI framework.

## Key Directories

- `src/components/`: application panes; `src/components/ui/`: existing Base UI/Coss-style primitives to reuse.
- `src/api/`, `src/types/`: IPC boundary and its manually maintained TypeScript wire contract.
- `src/lib/`, `src/hooks/`: shared styling helpers and React hooks.
- `src-tauri/src/`: `config.rs` persists paths, `discovery.rs` scans directories, `git.rs` reads status/diffs, `watch.rs` emits changes, `commands.rs` adapts IPC.
- `src-tauri/tests/`: Rust integration smoke fixtures. `src-tauri/capabilities/`: webview permissions; `src-tauri/gen/`: generated artifacts.

## Development Commands

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm tauri dev                         # desktop app with real IPC
pnpm dev                               # Vite only, port 1420; not desktop verification
pnpm build                             # TypeScript checks and Vite production bundle
pnpm tauri build                       # desktop bundle; invokes pnpm build
pnpm preview                           # preview the frontend build
cargo test --manifest-path src-tauri/Cargo.toml --test smoke
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

There is no `pnpm test` or `pnpm lint` script, frontend test runner, or configured coverage threshold. Rust formatting and Clippy commands are direct tooling checks, not package scripts.

## Code Conventions & Common Patterns

- Follow existing TypeScript formatting: two spaces, double quotes, semicolons, explicit wire/prop types, and `@/` imports for `src/`. App components use PascalCase filenames; shared hooks/UI primitives use kebab-case. Rust uses snake_case and rustfmt. Name domain behavior, never tickets, phases, agents, or dates.
- Mirror Rust serde structs in `src/types/grove.ts`: camelCase fields, lowercase enum values, nullable content sides. Project identity is a canonical absolute path, not a generated ID or `Root` entity. File-change paths are repository-relative. Preserve caller order and first-occurrence deduplication.
- Keep Rust commands thin and Git work split into pure functions. The spec limits Rust functions to 40 lines and three conditional/early-exit/filter branches; flat exhaustive enum maps are exempt. No registries, trait-object plugins, or additional state machines.
- Return `Result<T, String>` from commands, with underlying error text and known path context. Missing/unreadable projects remain sidebar rows; diff failures are errors. Render errors inline, not in modals. Log nonfatal watcher/read errors; recover poisoned watcher locks with `into_inner`. Do not add production `unwrap`/`expect`; the existing startup `.expect` in `lib.rs` is spec drift, not a pattern to copy.
- Keep async invokes in the API layer and mutations in callbacks. Clean up event subscriptions even if their promises resolve after unmount, following `App`'s cancellation/unlisten pattern.
- Reuse `cn`, class-variance-authority variants, and CSS tokens in `src/index.css`. Keep one `useFileTree` model and update it with `resetPaths`/`setGitStatus`. Memoize diff metadata; bump `CodeView` item versions when content or display options change. Highlight through the existing worker pool, not the render thread. Never enable diff editing.
- Preserve Git edge semantics: combined worktree-vs-`HEAD` diffs, separate staged membership, ignored paths omitted, no recursive submodule content reads, and empty-tree comparison for unborn `HEAD`. Check each content side's 512 KiB cap before allocation. Binary/omitted sides use patch rendering; absent add/delete sides are not truncation.

## Important Files

- `src-tauri/src/main.rs` → `src-tauri/src/lib.rs`: process entry, plugins, managed watcher, command registration, startup.
- `src/main.tsx`, `src/App.tsx`, `src/queries.ts`, `src/diffsWorker.ts`: composition, selection, invalidation, highlighting lifecycle.
- `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: dependencies and build contracts.
- `vite.config.ts`, `tsconfig.json`: alias alignment, strict TypeScript, fixed dev port; `src-tauri/tauri.conf.json`: desktop build hooks/window; `src-tauri/capabilities/default.json`: permissions; `components.json`: UI registry configuration.
- For detailed product contracts or edge cases, consult the supplied specification at `/Users/sayertindall/.omp/agent/sessions/-Dev/2026-09-24T18-17-03-572Z_01a0d4a2-a354-7000-ad64-e40cc2cb642f/local/grove-spec-final.md`. This is external session evidence, not a portable repository file; retain its original name. `README.md` is still template documentation. Current styles live in `src/index.css`, not the spec's proposed `src/App.css`.

## Runtime/Tooling Preferences

Use pnpm and Node compatible with Vite 8, plus Rust/Cargo and macOS Tauri build prerequisites. Tauri hooks explicitly invoke pnpm; do not substitute Bun/npm or create competing lockfiles. Node/pnpm versions are not pinned in the project.

The spec locks Tauri 2.11 stable, git2, notify-debouncer-full 0.7, store/dialog plugins v2, React 19, TypeScript/Vite, TanStack Query 5, `@pierre/diffs` 1.4.3, and `@pierre/trees` 1.0.0-beta.6. Do not add crates, plugins, or UI libraries or replace stack components. git2 is the sole Git implementation; mutation APIs belong only in test fixtures. Preserve existing UI dependencies and permission boundaries.

## Testing & QA

- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.
- These testing directives supersede the supplied spec's unit-test prescription. Preserve existing checks; do not treat backend smoke tests as full desktop E2E proof.
- Existing `src-tauri/tests/smoke.rs` uses Rust `#[test]`, real temporary Git repositories, and Tauri `MockRuntime`. It covers persisted project rows/counts, discovery, staged renames, and watcher event delivery. Fixtures are deleted on drop; the suite does not produce a durable E2E artifact.
- For desktop verification, launch `pnpm tauri dev`, register clean/dirty/renamed fixture repositories through the UI, inspect counts and selected diffs, then edit a fixture externally. Verify both event delivery and visible refetched state within one second without changing focus. Exercise relevant binary, oversized, missing, unborn-HEAD, and worktree/submodule cases.
- Finish E2E runs with a saved report containing fixture recreation steps, exact commands/actions, expected and observed results, and screenshots or recordings. Use domain-named artifacts so another developer can repeat and verify the scenario. A browser-only render or mocked invoke is not proof of native IPC/watch behavior.
- The spec's smoke shell script and ignored warm-latency test are not implemented. Do not claim those commands exist. The large-repository acceptance target remains under 500ms for a second status read, plus live desktop updates; distinguish measured results from unverified targets.
