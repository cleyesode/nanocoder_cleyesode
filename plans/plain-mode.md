# Plain Mode (`--plain`) — Lightweight, Ink-Free Runtime

## Problem

Nanocoder's UI is built on React + Ink. Ink works beautifully on a modern local terminal, but it has costs that make Nanocoder painful or unusable in three real environments:

1. **Low-spec / underpowered hardware** — Ink reconciles a virtual DOM and repaints on every state change. Big transcripts + streaming tokens + an active spinner can pin a slow CPU at 100%.
2. **SSH sessions** — Latency amplifies every redraw. Cursor flicker, partial repaints, and `\x1b[?25l` hide-cursor sequences misbehave on flaky links and over `mosh`/`tmux`/`screen`.
3. **Non-TTY environments** — GitHub Actions, GitLab runners, Docker logs, log aggregators. Even today's `nanocoder run` boots Ink, which means TTY assumptions, ANSI control sequences, and a render tree we don't need.

The existing `run` subcommand already short-circuits most interactive UI (see `source/app/components/non-interactive-shell.tsx`), but it still imports and renders through Ink. A `--vscode` flag launches a server; there is no flag to opt out of the renderer.

## Goal

Add a `--plain` flag that swaps Ink for a tiny, line-oriented Node.js runtime **for non-interactive runs only** (`nanocoder --plain run "..."`). Same model, same tools, same MCP, same agents.config.json — different I/O surface.

When `--plain run` is invoked:

- No `import('ink')`, no React render tree.
- Output is line-buffered plain text via `process.stdout.write` and `console.log`.
- Colors are still emitted when stdout is a TTY; auto-disabled otherwise (and respect `NO_COLOR`).
- All UI surfaces beyond the transcript and a single status line are dropped.

## Non-Goals

- **Not for interactive use (v1).** `--plain` without `run` is a CLI error in v1. A plain interactive REPL may come later but is out of scope here — building a usable readline shell, history, mid-stream cancel, and tool-confirmation prompts is its own project.
- **Not a port of every slash command.** `run` mode doesn't take slash commands today; plain mode keeps that constraint.
- **Not a parallel feature track.** Plain mode is a thin shell over the same backend; new tools/providers/MCP integrations should require zero plain-mode work.
- **Not a JSON/structured-output mode.** That's a separate concern (`--json`); plain stays human-readable.
- **No bidirectional VS Code or IDE integration.** Plain explicitly disables `--vscode` (errors if both passed).

## Naming & UX

### Flag

```
--plain
```

Pattern matches `git --no-pager`, `npm --no-color`, `terraform -no-color` — readers immediately understand "drop the fancy UI, give me text."

Alternatives considered: `--no-tui` (clear but ugly), `--no-ink` (leaks implementation), `--lite`/`--basic` (too vague). Going with `--plain`.

### Auto-detection

Plain mode auto-enables for `run` invocations when:

- `process.stdout.isTTY === false`, **or**
- `process.env.CI === 'true'`, **or**
- Common CI sentinels are set: `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`.

Auto-detection only applies to the `run` subcommand. Interactive invocations (`nanocoder` with no `run`) always boot Ink in v1.

A `--no-plain` escape hatch forces Ink even in non-TTY/CI environments (rare, but useful for debugging).

### Combinations

| Flags | Behavior |
|---|---|
| `nanocoder` | Ink interactive (today, unchanged) |
| `nanocoder --plain` | **Error** — `--plain` requires `run` in v1 |
| `nanocoder run "..."` | Ink non-interactive (today) |
| `nanocoder --plain run "..."` | Plain non-interactive |
| `nanocoder run "..."` (in CI/non-TTY) | Auto-promotes to plain |
| `nanocoder --plain --vscode run "..."` | **Error** at CLI parse |

## Architecture

The current React tree owns more than rendering — it owns most of the orchestration glue (chat lifecycle, tool confirmation, mode switching). We don't try to make that tree headless. We build a **parallel entrypoint** that reuses the framework-agnostic backend and drives a tiny stdio loop.

```
                   ┌─ source/cli.tsx ──── parses --plain ─┐
                   │                                       │
        Ink path ──┴─→ render(<App/>)                       │
                                                            │
        Plain path ──→ runPlainShell({ interactive, ... }) ─┘
                            │
                            ├── reuses (no React/Ink):
                            │     • client-factory.ts (LLMClient)
                            │     • tools/tool-manager.ts
                            │     • mcp/* (MCP init + tool exposure)
                            │     • custom-commands/*
                            │     • tool-calling/* (XML fallback parsing)
                            │     • subagents/*
                            │     • auth/* (Codex/Copilot device flow)
                            │     • config/* (agents.config.json loading)
                            │     • commands/* (curated subset)
                            │
                            └── plain-only modules (new):
                                  • source/plain/shell.ts          ← entry
                                  • source/plain/writer.ts         ← stdout w/ ANSI
                                  • source/plain/streaming.ts      ← token printer
```

### Why a parallel entrypoint, not a headless render

`useAppState`, `useChatHandler`, `useToolHandler`, and friends bake React state semantics (refs, effects, callback identity, batching) into the orchestration. Trying to render `<App/>` to `/dev/null` while running the same hooks is fragile — Ink owns its own scheduler, and any `process.stdout.write` collisions corrupt the stream.

The seams are already in the right places: `LLMClient`, `ToolManager`, `MCPManager`, `CustomCommandExecutor`, and the conversation utilities under `source/hooks/chat-handler/conversation/` are already framework-agnostic (they don't import Ink). We extract the conversation/tool-execution **logic** out of the React-bound hook and call it directly.

### Refactor required: extract conversation primitives

Today `useChatHandler` mixes pure orchestration with React state plumbing. We extract the pure parts into a class or set of functions in `source/conversation/` (new directory) that both `useChatHandler` and `runPlainShell` consume.

Concretely, lift these out of `source/hooks/chat-handler/`:

- `conversation/conversation-loop.tsx` → `source/conversation/loop.ts` (drop `.tsx`)
- `conversation/tool-executor.tsx` → `source/conversation/tool-executor.ts`
- `utils/message-helpers.tsx` → `source/conversation/message-helpers.ts`
- `state/ConversationStateManager` → unchanged, already pure

The React hook becomes a thin adapter that wires these primitives to React state. The plain shell wires them to plain callbacks. This is a load-bearing refactor — it should land as **Phase 0** before any plain-mode UI work.

## Phase Plan

### Phase 0 — Decouple conversation logic from React

Goal: zero behavior change for the existing Ink path; conversation primitives become callable from a non-React context.

Tasks:

1. Create `source/conversation/` with `loop.ts`, `tool-executor.ts`, `message-helpers.ts`. Move the implementations; keep the public function signatures.
2. Replace `useState`/`useRef`-driven internals with explicit parameters and return values (callers own the state).
3. Rewrite `useChatHandler` as a React adapter that owns the React state and delegates to the new primitives.
4. Make sure tests under `source/hooks/chat-handler/conversation/*.spec.ts` still pass; mirror them under `source/conversation/*.spec.ts`.

Acceptance: `pnpm run test:all` passes. No user-visible change.

### Phase 1 — Plain non-interactive (`--plain run "..."`)

Tasks:

1. Parse `--plain` and `--no-plain` in `source/cli.tsx`. Add auto-detection (TTY + CI env vars), gated on the `run` subcommand. Validate: `--plain --vscode` errors, `--plain run` is fine, `--plain` without `run` errors with a clear message ("--plain requires the `run` subcommand in this version").
2. New module `source/plain/shell.ts` exporting `runPlainShell({ prompt, mode, providerName, modelName, trustDirectory })`.
3. New module `source/plain/writer.ts`: thin wrapper around `process.stdout.write` with chalk-style coloring gated on `stdout.isTTY && !NO_COLOR`.
4. Reuse `source/auth/*` for Codex/Copilot login flows (no Ink today on the login path — already plain `console.log`, see `cli.tsx:200-244`). Confirm both login flows work without Ink.
5. Reuse `useAppInitialization`'s underlying setup logic (extract a non-hook `initializeApp(...)` function in `source/init/`) — creates LLM client, loads MCP, loads commands, returns plain objects.
6. Drive the conversation loop with the Phase 0 primitives. Stream tokens via `process.stdout.write`; on tool calls, render `[tool_name] arg=value\n` lines and dispatch to `ToolManager`.
7. Tool confirmation in `--plain run` reuses today's `auto-accept` semantics — no prompts, except destructive bash/git which print a refusal and exit non-zero (matches current `run` behavior).
8. Exit codes: 0 success, 1 error, 2 tool approval required (for `--mode normal --plain run`).

Acceptance:

- `nanocoder --plain run "list files in src/"` produces a clean stdout transcript with no ANSI escapes when piped.
- Setting `CI=true` and running `nanocoder run "..."` auto-enables plain mode (no `--plain` needed).
- `node --inspect-brk` shows zero `ink` modules in the require graph for the plain run path.
- New AVA test asserts `import('ink')` is never called when `--plain` is set.

### Phase 2 — Polish & docs

1. README section on `--plain` with copy-pasteable GitHub Actions example.
2. New `docs/features/plain-mode.md` documenting the flag, the auto-detection rules, and the dropped surfaces. Note that interactive `--plain` is intentionally not supported in v1 and may come later.
3. CHANGELOG entry.
4. A benchmark in `benchmarks/` comparing `--plain run` vs `run` (Ink) on a representative prompt on low CPU.

## Surfaces We Explicitly Drop in Plain Mode

`--plain run` already inherits the `run` mode's restrictions (no slash commands, no interactive input). On top of that, in plain:

| Feature | Plain `run` behavior |
|---|---|
| Welcome banner | Single-line version + provider/model summary |
| Boot summary box | Single line, no Ink box |
| Update info banner | Single line at boot, not styled |
| Compact tool display | Forced off (was a TUI affordance) |
| Reasoning expand/collapse | Always inline-printed with a `> ` prefix |
| ANSI title shapes, themes | Themes still control color choice; titles render as plain text |
| Spinners / live status line | Replaced by `[plain] <state>` lines emitted on transition only |
| VS Code server | CLI error if `--vscode` and `--plain` are combined |

## Open Questions

1. **Auto-detect aggressiveness.** Should `nanocoder run "..."` in CI silently switch to plain, or should we require explicit `--plain` and only print a warning that "TUI mode in CI is unsupported"? Leaning toward *silent auto-switch* with a one-line `[plain]` notice at boot.
2. **MCP server stderr.** MCP servers can spew to stderr. In Ink we capture and render in a panel; in plain we let it through. Confirm that's acceptable for CI logs.
3. **Custom commands that produce React elements.** The custom command system returns `React.ReactNode` today (`source/custom-commands/executor.ts`). Plain mode needs a string fallback — either a separate execution path that emits markdown, or a `react-to-text` shim. Phase 0 should clarify which.
4. **Login flows in plain.** `codex login` and `copilot login` are already plain `console.log`s. We should confirm device-flow polling still works under non-TTY (it should — no input required after the initial code).
5. **`--plain run --mode normal`.** Tool approvals can't be prompted in non-interactive mode. Today's `run` exits with code 2 when approval is needed; plain inherits that. Confirm that's the desired behavior (vs. forcing the user to choose `auto-accept` or `yolo` when combining `run` with `--plain`).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Phase 0 refactor regresses Ink behavior | Keep the React adapter's external interface byte-identical; rely on `useChatHandler.spec.tsx` and the existing 5000+ test suite. |
| Two code paths drift over time | Conversation logic lives in `source/conversation/` and is the single source of truth. Plain and Ink are both thin shells. CI test asserts both paths handle a smoke prompt identically. |
| Plain mode silently breaks when a new modal-only command is added | Add a CI lint that flags any new command not declared either `plainSupported: true` or `plainSupported: false`. |
| Auto-detect misfires (e.g., `tmux` in SSH) | Provide `--no-plain` escape hatch; document it. |

## Rough Sequencing

- **Week 1:** Phase 0 refactor + tests.
- **Week 2:** Phase 1 (non-interactive plain) + CI auto-detect + GitHub Actions example.
- **Week 3:** Phase 2 polish, docs, benchmark, ship.

## Smoke Test Matrix

Before merging, manually verify:

- `nanocoder --plain run "what is 2+2"` on macOS (TTY) — colored, clean.
- `nanocoder --plain run "what is 2+2" | tee out.log` — no ANSI in `out.log`.
- `CI=true nanocoder run "what is 2+2"` — auto-plain, exit 0.
- `nanocoder --plain` (no `run`) — errors with clear message before boot.
- `nanocoder --plain --vscode run "..."` — errors before boot.
- `nanocoder --plain run "edit file foo.ts"` with `--mode normal` — exits 2 (tool approval required).
- `nanocoder --plain --mode yolo run "..."` — runs all tools without prompting.
- `nanocoder --plain run "..."` over slow SSH — clean streaming, no flicker.
