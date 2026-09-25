# Grove

<img src="design/grove-icon.svg" width="96" alt="Grove icon" />

A read-only macOS desktop viewer of git working-tree changes across the repositories you
register. It never stages, commits, pushes, pulls, edits files, or writes to a repository in
any way. The only thing that leaves your machine is a chat turn you explicitly send to a
provider you configured yourself — no telemetry, no update checks, no other socket. It also
ships a read-only CLI, so agents and scripts can read exactly what the window shows. The name
is the model: a grove is many trees, and each registered repository is one tree shown beside
the others.

## Screenshot

![Grove](docs/grove-screenshot.png)

Eleven registered repositories, `dsg-clusters` selected, with
`checks/tests/test_reference_composition.py` open: two hunks against `HEAD`, `-2 +409`,
the unchanged runs collapsed, and word-level highlighting inside the changed lines.

## Stack

| Library | Role |
| --- | --- |
| Tauri 2 | Desktop shell. Sixteen Rust commands and six events cross to the webview. |
| git2 | Opens a repository and reads status, branch, and diffs. The only git implementation. |
| notify-debouncer-full 0.7 | Recursive watches on registered roots, filtered by `.gitignore`, 300 ms debounce. |
| tauri-plugin-window-state | Restores the window's size and position. |
| tauri-plugin-store | Persists the project path list in the app data directory. |
| tauri-plugin-dialog | Directory picker, invoked from JavaScript only. |
| React 19 + TypeScript + Vite | UI, `strict` TypeScript. |
| Tailwind CSS 4 + coss ui | The component library. Components are vendored into `src/components/ui`. |
| TanStack Query 5 | Server state: the project list, one project's change list, and one file's diff. |
| @pierre/diffs 1.4.3 | `CodeView` renders the selected file; Shiki highlighting runs in a worker pool. |
| @pierre/trees 1.0.0-beta.6 | `FileTree` renders the changed files with built-in git status. |
| reqwest + hand-rolled SSE | Streams the chat provider (OpenAI-compatible and Anthropic). No agent framework sits between Grove and the model. |
| macOS Keychain (`keyring`) | Holds provider API keys. The app never logs or returns one. |
| Beautiful UI, ported | The chat surface's primitives, copied into `src/components/beautiful/` with its MIT notice and attribution. |

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

## Icon

`design/grove-icon.svg` is the source art: a 1024 canvas with a charcoal continuous-corner
tile (824 px, inset 100 px) and a lime two-leaf sprout on it, transparent outside the tile.
`pnpm icon` regenerates `src-tauri/icons` from it, including the `.icns` layer set the bundle
wants.

The CLI also emits iOS, Android, and Microsoft Store variants; a macOS-only bundle
references none of them, so those files are deleted after each run.

macOS 26 Liquid Glass icons need an Icon Composer `.icon` file inside an Xcode project.
A Tauri bundle ships a static `.icns`, so Grove keeps the classic icon.

## Chat

Grove has one free-flowing assistant and **no modes** — no Explain/Review switch, no preset
prompts. Ask about the changes in a project and it answers from Grove's own facts.

It is not a coding agent and it cannot write. Its entire capability is nine read-only
readers: project status, change lists, diffs, file contents, a search across changed files,
worktrees, recent commits, file history, and blame. Every path argument is validated to be
inside a registered project, so it cannot read anything else. Answers cite `path:line`, and
the source list is derived from the tools it actually called rather than from parsing its
prose — so a citation is evidence, not a claim.

Configure a provider in the panel's settings: an OpenAI-compatible endpoint (OpenAI,
DeepSeek, Groq, OpenRouter, or a local Ollama, LM Studio, or llama.cpp server) or Anthropic,
with a model and a key. Keys resolve in this order:

1. `GROVE_CHAT_KEY`
2. the provider's own environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …)
3. the macOS Keychain

A remote host requires an explicit acknowledgement before the first turn; a loopback host
does not. Nothing is transmitted until you send a message, and the panel header always shows
which host and model would receive it.

Settings live in `chat-settings.json` (mode 0600) and the transcript in `chat-history.json`,
beside the project list in the app data directory.

## CLI

The app binary is also the CLI — the same read-only surface the window shows, for scripts
and agents:

```bash
grove status [--json]
grove changes [<project>] [--json]
grove diff <project> <file> [--view head|staged|unstaged] [--json]
grove worktrees [<project>] [--json]
grove ask "what changed here, and does anything look accidental?" [--project <path>]
```

A project argument is a registered absolute path or a display name (a unique prefix is
accepted). `--json` emits the same shapes the GUI consumes. Exit codes are 0 success, 1
runtime failure, 2 usage. `GROVE_DATA_DIR` points the store somewhere else, which is how the
CLI is exercised against throwaway repositories.

## Release

`.github/workflows/release.yml` builds the bundles and publishes them. Push a tag to
release, or start a run from the Actions tab:

```bash
git tag app-v0.1.2 && git push origin app-v0.1.2
```

The workflow runs the Rust tests, builds `--target aarch64-apple-darwin` and
`--target x86_64-apple-darwin` on `macos-latest`, uploads the `.dmg` and `.app` as run
artifacts, and creates a GitHub release carrying both `.dmg` files, both zipped `.app`
bundles, and the screenshot (`tauri-action` replaces `__VERSION__` from
`tauri.conf.json`). The tag and the asset names both follow the version in
`tauri.conf.json`, so bump that before tagging. A manual run publishes immediately unless
you tick the draft box.

Grove is not signed or notarized, so macOS quarantines the first launch of a downloaded
bundle: right-click the app and choose Open, or
`xattr -dr com.apple.quarantine /Applications/Grove.app`. To sign and notarize in CI, add
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` and `APPLE_TEAM_ID` as repository secrets; `tauri build` reads them from
the environment.

## Layout

- `src-tauri/src/config.rs` persists the path list. `git.rs` reads status, branch, change
  lists, and single-file diffs. `discovery.rs` finds repositories. `watch.rs` watches,
  filters, re-arms, and emits. `commands.rs` adapts IPC. `lib.rs` builds the process.
- `src/App.tsx` holds selection and preferences. `src/queries.ts` owns the query keys and
  the watch-event patching. `src/api/grove.ts` wraps the commands. `src/components/`
  holds one component per pane plus `MissingProject`, `ImageDiff`, and `Splitter`.
- `src-tauri/src/chat/` is the assistant — provider seam, the nine read-only tools, the
  prompt, and the turn loop — and `src-tauri/src/cli.rs` is the subcommand surface.
  `src/components/ChatPanel.tsx`, `src/hooks/useChatStream.ts`, and `src/api/chat.ts` are
  its panel and IPC.

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
- **Reads are sized to the view.** The sidebar list reads every project in parallel; a
  watch event re-reads only the projects it names. A project's change list carries paths,
  status, and line counts; the two content sides load for the selected file only.
- **Views.** A partially staged file offers Head, Staged, and Unstaged views. "Hide
  whitespace" re-reads with whitespace ignored, and files left with no change drop out.
- **The chat cannot write.** There is no write tool and no shell: the model's tool set is
  nine read-only readers, all path-guarded to registered projects. That is a structural
  guarantee rather than a policy, which is why the tool list is short and fixed.
- **History is read only to explain the present.** The assistant can read file history,
  blame, and recent commits for the change in front of you; the app never becomes a general
  history browser and a full commit graph is deliberately out of scope.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘R | Re-read everything |
| ⌘1–⌘9 | Select the Nth visible project |
| ⌘F | Search the changed files |
| ⌘O | Add projects |
| ⌘L | Toggle the chat panel |
| ↑ ↓ | Move through projects (list focused) or files (tree focused) |
| Esc | Clear the file selection |
