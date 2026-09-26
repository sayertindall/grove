# Repository Guidelines

## Project Overview

Grove is a read-only macOS desktop viewer of working-tree changes across explicitly registered Git repositories. Compare worktrees against `HEAD` (or, for a partially staged file, the index against `HEAD` and the worktree against the index), never commit history. Production code must not stage, commit, push, pull, or edit repository files. The only outbound connection is the model provider the user configures for chat: there is no telemetry, no update check, and no other socket. Removing a project only unregisters its path. App-data persistence is the project list (store plugin), window geometry (window-state plugin), UI preferences in `localStorage` (`grove.*` keys), and the chat's own `chat-settings.json` (0600) and `chat-history.json` in the same directory.

## Architecture & Data Flow

- React → typed invokes in `src/api/grove.ts` (rejections normalized to `Error`) → thin Tauri commands → Rust discovery, Git reads, and config functions. Keep Git/filesystem knowledge out of the webview. Commands: `scan_for_repos`, `list_projects`, `get_project_status`, `set_projects`, `list_changes` (summaries only, no contents), `get_file_diff` (one file, one view), `reveal_in_finder`, `open_path` (both reject paths outside registered projects). One event: `grove://projects-changed`.
- `src-tauri/src/commands.rs` routes whole-list replacement through `replace_registered_projects`: canonicalize/dedupe paths, save and flush, then rebuild watchers. Startup uses the same writer. `list_projects` reads projects in parallel and returns stored order.
- `src-tauri/src/watch.rs` owns the only long-lived backend state, a Tauri-managed `Mutex<ProjectWatcher>`: the `NoCache` debouncer (300 ms), the set of armed roots (reported as `ProjectStatus.watching`), and a thread that re-arms missing roots every 5 s. Events for gitignored paths and `.git/` internals other than `index`, `HEAD`, `packed-refs`, and `refs/` are dropped before a project is matched.
- TanStack Query is the only server-state cache: `['projects']`, `['changes', path, ignoreWhitespace]`, `['fileDiff', path, file, view, ignoreWhitespace]`, retries disabled. A watch event patches the named rows via `get_project_status` and invalidates only those projects' changes and file diffs; ⌘R invalidates everything.
- `App` composes `ProjectSidebar`, `ChangesTree`, `DiffViewer`, `ChatPanel`, and `MissingProject`. Props down, callbacks up; selection, theme, sort, filters, pane widths, and chat panel state persist through `src/lib/storage.ts`.
- Chat is one free-flowing assistant with **no modes**: a single system prompt, one tool set, and ambient context naming the project/file in view. `src-tauri/src/chat/` holds the provider seam (`provider.rs`, OpenAI-compatible + Anthropic, hand-rolled SSE), the nine read-only tools (`tools.rs`), the prompt (`prompt.rs`), the turn loop, persistence, key resolution, and the egress guard (`mod.rs`), plus a CLI entry (`cli.rs`). The loop takes a sink, so the GUI (Tauri events `grove://chat-delta|reasoning|tool|done|error`) and the CLI (stdout) share one implementation. Every event carries the turn id the panel addresses its message by, and every failure arrives as one error event: a payload without `turnId`, or a turn that fails without reporting one, leaves the panel spinning with no answer. Commands: `chat_settings`, `set_chat_settings`, `chat_key_status`, `set_chat_key`, `clear_chat_key`, `chat_history`, `chat_send`, `chat_cancel`, `chat_clear`. Tool arguments naming a path are validated to be inside a registered project. Keys resolve as `GROVE_CHAT_KEY` → host-matched provider env var → macOS Keychain (`keyring`, service `com.grove.app`); a key is never logged or returned. A turn refuses to start when the provider's host is not loopback and `allowCloudEgress` is false.
- The app binary is dual-purpose: with no arguments it runs the GUI; with a subcommand it is a read-only CLI (`src-tauri/src/cli.rs`) — `status`, `changes`, `diff`, `worktrees`, `ask`, `help`, each accepting `--json` that emits the same serde shapes the GUI consumes. Exit codes are 0 success, 1 runtime failure, 2 usage. `GROVE_DATA_DIR` overrides the store location, which is how the CLI is tested against throwaway repositories.

## Key Directories

- `src/components/`: application panes; `src/components/ui/`: existing Base UI/Coss-style primitives to reuse; `src/components/beautiful/`: the ported chat-primitive library (see its `ATTRIBUTION.md` — MIT, derived from Beautiful UI by Shane Levine). Do not add dependencies to use it; vendor-only behaviour was inlined on port. It vendors styles, not the demo: only the primitives the chat renders are kept, and each renders exactly what its props say — no seeded content, no self-driven animation.
- `src/api/`, `src/types/`: IPC boundary and its manually maintained TypeScript wire contract.
- `src/lib/`, `src/hooks/`: shared styling helpers and React hooks.
- `src-tauri/src/`: `config.rs` persists paths, `discovery.rs` scans directories, `git.rs` reads status/diffs and the history readers, `watch.rs` emits changes, `commands.rs` adapts IPC, `chat/` is the assistant, `cli.rs` is the subcommand surface.
- `src-tauri/tests/`: Rust integration tests — `smoke.rs` fixtures over real repositories, and `chat_events.rs` (one turn onto the webview channels against a loopback SSE provider). `src-tauri/capabilities/`: webview permissions; `src-tauri/gen/`: generated artifacts.
- `beautiful-ui/` at the repository root is the vendored upstream library the port was taken from. It is gitignored (a full Next.js app with ~980 MB of `node_modules`) and safe to delete once the port is stable; provenance and the upstream URL live in `src/components/beautiful/ATTRIBUTION.md`.

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

The app binary is also the CLI. Build it once (`cargo build --manifest-path src-tauri/Cargo.toml`) and use `src-tauri/target/debug/grove`:

```sh
grove status [--json]                       # every registered project, with branch and counts
grove changes [<project>] [--json]          # changed files, all projects when omitted
grove diff <project> <file> [--view head|staged|unstaged] [--json]
grove worktrees [<project>] [--json]        # including prunable ones
grove ask "<prompt>" [--project <path>] [--file <path>] [--json]
grove help
```

A project argument is a registered absolute path or a display name (unique prefix allowed). `GROVE_DATA_DIR` points the store elsewhere, which is how the CLI is exercised without touching the real project list.

## Code Conventions & Common Patterns

- Follow existing TypeScript formatting: two spaces, double quotes, semicolons, explicit wire/prop types, and `@/` imports for `src/`. App components use PascalCase filenames; shared hooks/UI primitives use kebab-case. Rust uses snake_case and rustfmt. Name domain behavior, never tickets, phases, agents, or dates.
- Mirror Rust serde structs in `src/types/grove.ts`: camelCase fields, lowercase enum values, nullable content sides. Project identity is a canonical absolute path, not a generated ID or `Root` entity. File-change paths are repository-relative. Preserve caller order and first-occurrence deduplication.
- Keep Rust commands thin and Git work split into pure functions. The spec limits Rust functions to 40 lines and three conditional/early-exit/filter branches; flat exhaustive enum maps are exempt. No registries, trait-object plugins, or additional state machines.
- Return `Result<T, String>` from commands, with underlying error text and known path context. Missing/unreadable projects remain sidebar rows; diff failures are errors. Render errors inline, not in modals. Log nonfatal watcher/read errors; recover poisoned watcher locks with `into_inner`. Do not add production `unwrap`/`expect`; the existing startup `.expect` in `lib.rs` is spec drift, not a pattern to copy.
- Keep async invokes in the API layer and mutations in callbacks. Clean up event subscriptions even if their promises resolve after unmount, following `App`'s cancellation/unlisten pattern.
- Reuse `cn`, class-variance-authority variants, and CSS tokens in `src/index.css`. Keep one `useFileTree` model and update it with `resetPaths`/`setGitStatus`. Memoize diff metadata; bump the `CodeView` item version only when the diff content changes, so a background refresh keeps the scroll position. The `CodeView` root is its scroll container and must keep `overflow-auto`. Highlight through the existing worker pool. Never enable diff editing.
- Preserve Git edge semantics: combined worktree-vs-`HEAD` diffs, separate staged membership, ignored paths omitted, no recursive submodule content reads, and empty-tree comparison for unborn `HEAD`. Check each content side's 512 KiB cap before allocation. Binary/omitted sides use patch rendering; absent add/delete sides are not truncation.
- Chat stays read-only and single-mode. The model's entire capability is the nine read-only readers in `chat/tools.rs`: never add a tool that writes, and never give the model a shell or filesystem access. One system prompt, no mode switcher, no per-mode tool sets. Citations are derived from the tools actually called (deterministic) plus best-effort inline `path:line` matches; never present an unattributed claim about this workspace as fact, and render a failed or skipped check explicitly rather than as silence.

## Important Files

- `src-tauri/src/main.rs` → `src-tauri/src/lib.rs`: process entry, plugins, managed watcher, command registration, startup. `main.rs` dispatches to `cli.rs` before Tauri is constructed when a subcommand is present.
- `src-tauri/src/chat/` (provider seam, tool set, prompt, turn loop, persistence, egress guard) and `src-tauri/src/cli.rs` (subcommand surface) are the assistant's backend; `src/components/ChatPanel.tsx`, `src/hooks/useChatStream.ts`, and `src/api/chat.ts` are its UI and IPC.
- `src/main.tsx`, `src/App.tsx`, `src/queries.ts`, `src/diffsWorker.ts`: composition, selection, invalidation, highlighting lifecycle.
- `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: dependencies and build contracts.
- `vite.config.ts`, `tsconfig.json`: alias alignment, strict TypeScript, fixed dev port; `src-tauri/tauri.conf.json`: desktop build hooks/window; `src-tauri/capabilities/default.json`: permissions; `components.json`: UI registry configuration.
- For detailed product contracts or edge cases, consult the supplied specification at `/Users/sayertindall/.omp/agent/sessions/-Dev/2026-09-24T18-17-03-572Z_01a0d4a2-a354-7000-ad64-e40cc2cb642f/local/grove-spec-final.md`. This is external session evidence, not a portable repository file; retain its original name. The app has since grown past it (views, whitespace, images, path actions). Current styles live in `src/index.css`.

## Runtime/Tooling Preferences

Use pnpm and Node compatible with Vite 8, plus Rust/Cargo and macOS Tauri build prerequisites. Tauri hooks explicitly invoke pnpm; do not substitute Bun/npm or create competing lockfiles. Node/pnpm versions are not pinned in the project.

The spec locks Tauri 2.11 stable, git2, notify-debouncer-full 0.7, store/dialog plugins v2, React 19, TypeScript/Vite, TanStack Query 5, `@pierre/diffs` 1.4.3, and `@pierre/trees` 1.0.0-beta.6. The chat feature is a deliberate, owner-directed exception to that freeze: it added `reqwest`, `futures-util`, `tokio`, `sha2`, `keyring`, and `dirs`, and it ports a vendored component library into `src/components/beautiful/` (MIT, attribution alongside). Beyond chat, do not add crates, plugins, or UI libraries or replace stack components. git2 is the sole Git implementation; mutation APIs belong only in test fixtures. Preserve existing UI dependencies and permission boundaries — the webview still has no `http`, `shell`, or `fs` permission, and all provider calls happen in Rust.

## Testing & QA

- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.
- These testing directives supersede the supplied spec's unit-test prescription. Preserve existing checks; do not treat backend smoke tests as full desktop E2E proof.
- Existing `src-tauri/tests/smoke.rs` uses Rust `#[test]`, real temporary Git repositories, and Tauri `MockRuntime`. It covers persisted project rows/counts, discovery, staged renames, and watcher event delivery. Fixtures are deleted on drop; the suite does not produce a durable E2E artifact.
- For desktop verification, launch `pnpm tauri dev`, register clean/dirty/renamed fixture repositories through the UI, inspect counts and selected diffs, then edit a fixture externally. Verify both event delivery and visible refetched state within one second without changing focus. Exercise relevant binary, oversized, missing, unborn-HEAD, and worktree/submodule cases.
- Finish E2E runs with a saved report containing fixture recreation steps, exact commands/actions, expected and observed results, and screenshots or recordings. Use domain-named artifacts so another developer can repeat and verify the scenario. A browser-only render or mocked invoke is not proof of native IPC/watch behavior.
- The spec's smoke shell script and ignored warm-latency test are not implemented. Do not claim those commands exist. The large-repository acceptance target remains under 500ms for a second status read, plus live desktop updates; distinguish measured results from unverified targets.

The CLI is the cheapest honest end-to-end surface: `cargo build`, then run `grove status|changes|diff|worktrees` against the real registered projects (read-only) and cross-check the numbers against the GUI. A chat turn must be exercised against a **throwaway** repository and store (`GROVE_DATA_DIR`), never against the real registered projects, because a turn transmits the diff to the configured provider. Record the exact command, the observed answer, which tools the model called, and the exit code. Run the CLI's own error paths too: an unknown subcommand must exit 2, an unregistered project 1, and `--json` output must parse.
