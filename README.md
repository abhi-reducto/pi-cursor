# pi-cursor

Run **full-featured [Pi](https://github.com/badlogic/pi-mono)** — including Pi 1.6 `codemode`, MCP servers, skills, `AGENTS.md` project context, custom extension tools, subagents, image inputs/outputs, and session branching — powered by your existing **Cursor subscription**.

## Why `pi-cursor`?

Cursor's Agent API exposes models (Claude, GPT, Gemini, Grok, Composer, Kimi, including reasoning variants) under your Cursor subscription, but a thin provider bridge loses most of Pi's harness capabilities — especially in Pi 1.6+, where tools and structured prompt sections moved into `TranscriptContext` system messages.

`pi-cursor` bridges Pi's full feature set cleanly onto Cursor's Agent protocol:

- **All Pi Tools (`codemode`, `edit`, custom extension tools, subagents, MCP)**
  - Extracts active tools from Pi 1.6 `TranscriptContext` (`role: "system"` `toolsAdded` / `toolsRemoved` deltas) with fallback to legacy `context.tools`.
  - Sanitizes TypeBox / JSON schemas and advertises every non-native Pi tool via Cursor's `McpToolDefinition` under the `pi-agent` provider.
  - Bridges tool execution back into Pi's tool runtime (preserving both text and image result blocks).
- **All Pi Artifacts (`AGENTS.md`, Skills, `mcp_servers`, Guidelines, Custom Sections)**
  - Parses Pi 1.6 `<project_instructions path="...">` (and legacy `# Project Context`) into Cursor global workspace rules (`CursorRuleTypeGlobal`).
  - Converts Pi `<available_skills>` entries into Cursor `agentFetched` skill rules (`CursorRuleTypeAgentFetched`).
  - Forwards Pi's structured prompt sections (`mcp_servers`, `rules`, `docs`, `addendum`, custom preamble, extension-contributed sections, and a `pi-agent/tools` overview) as Cursor global rules so models see Pi's full environment on turn 1.
- **Native Tool Bridge Fidelity**
  - Bridges Cursor's native `Read`, `Write`, `Delete`, `Shell`, `Grep`, and `Ls` calls through Pi's native tools.
  - Forwards binary image data on `Read` so vision-capable models can inspect images directly.
  - Scopes `Shell` commands to `workingDirectory` when it differs from the session `cwd`, separates error output on `stderr`, excludes `.git` from hidden ripgrep searches, and returns written file content when `returnFileContentAfterWrite` is requested.
- **Configurable Command & Tool Approval Modes**
  - Switch between `dangerous` (default — prompt only on destructive shell commands), `auto` (run everything without prompts, including headless), and `ask` (prompt before every shell, write, delete, and custom/MCP tool call).
  - Change modes on the fly via `/cursor-approval`, `Ctrl+Alt+A`, `--cursor-approval <mode>`, or `PI_CURSOR_APPROVAL=<mode>`; active mode persists per session and displays a status badge (`cursor:safe`, `cursor:auto`, `cursor:ask`) in Pi's footer.
- **Accurate Context & Cost Tracking**
  - Reads Cursor's checkpoint `tokenDetails` (`usedTokens` and `maxTokens`) so Pi's context bar and auto-compaction reflect the real context window and token usage instead of only output deltas.
  - Computes API-equivalent token costs from model pricing (displayed as `$X.XXX (sub)` in Pi's footer for OAuth subscriptions).
- **Reliable Conversation History & Session Lifecycle**
  - Uses Cursor's native KV blob cache across consecutive `cursor-agent` turns for fast prompt caching.
  - Validates blob integrity and branch alignment (`lastAssistantTimestamp`) before reusing cached state; automatically reconstructs `<prior_conversation_history>` on `/fork`, cache eviction, `/tree` navigation, `/compact`, or switching back from another provider — without losing rules, skills, or tools.
  - Resets live Cursor streams cleanly on `session_compact` so auto-compaction never reuses stale pre-compaction context, keeps ephemeral calls (like compaction summarization) isolated from session state, re-syncs branch state cleanly after `/reload`, and surfaces API errors instead of silently terminating streams.

## Installation

Install directly from GitHub in Pi:

```sh
pi install git:github.com/abhi-reducto/pi-cursor
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/abhi-reducto/pi-cursor"
  ]
}
```

If Pi is already open, run `/reload` after installing.

## Authentication

1. Open Pi and run `/login`.
2. Select **Cursor** (`cursor-agent`) from the provider list.
3. Complete sign-in in your browser with your Cursor account.

Alternatively, set `CURSOR_ACCESS_TOKEN` in your environment.

## Models

Models available to your Cursor account are fetched and cached automatically on login and selection. Canonical model IDs map thinking levels (`minimal`, `low`, `medium`, `high`, `xhigh`) to the corresponding Cursor reasoning variants automatically, while unmapped Cursor model IDs pass through as-is.

## Approval Modes

Control whether `pi-cursor` prompts for confirmation before running tools:

| Mode | Aliases | Behavior | Footer Badge |
|---|---|---|---|
| `dangerous` *(default)* | `safe`, `default` | Auto-approves normal tools; prompts before destructive shell commands (`sudo`, `rm -rf`/`-fr`, `mkfs`, `dd`, `shutdown`, `reboot`, `curl\|sh`, `wget\|bash`). Denies dangerous commands when running headless without a UI. | `cursor:safe` |
| `auto` | `yolo`, `all`, `off`, `none` | Runs **everything** without confirmation prompts — including dangerous shell commands, writes, deletes, and custom/MCP tools — in both interactive TUI and headless mode. | `cursor:auto` |
| `ask` | `strict`, `prompt`, `confirm` | Prompts before every shell command, file write, file delete, and custom/MCP tool call (read-only `read`/`grep`/`ls` remain auto-approved). | `cursor:ask` |

### Switching Modes

- **Slash command**:
  - `/cursor-approval` — open an interactive selector showing all modes and the active one
  - `/cursor-approval auto` (or `/cursor-approval yolo`) — switch to run-everything mode
  - `/cursor-approval dangerous` — restore default dangerous-command prompting
  - `/cursor-approval ask` — prompt before every mutating tool call
  - `/cursor-approval cycle` — cycle to the next mode
- **Keyboard shortcut**: press **`Ctrl+Alt+A`** to cycle `dangerous → auto → ask → dangerous`.
  > **Note on `Shift+Tab`**: Pi reserves `Shift+Tab` globally for cycling thinking levels (`app.thinking.cycle`) and blocks extensions from overriding reserved keybindings. `Ctrl+Alt+A` is conflict-free across Linux, macOS, and Windows.
- **CLI flag / environment variable** (for defaults or headless runs):
  - `pi --cursor-approval auto ...`
  - `PI_CURSOR_APPROVAL=auto pi ...`

Mode changes made during a session are persisted in the session branch and automatically restored when resuming or switching branches. Read-only operations (`read`, `grep`, `ls`) are never blocked by approval modes.

## How It Works

```text
Pi 1.6 TranscriptContext
  ├── role: "system" (content, sections, toolsAdded / toolsRemoved)
  │     ├── Non-native Pi tools (codemode, edit, subagent, extensions)
  │     │     ──▶ McpToolDefinition (provider: "pi-agent") ──▶ LocalMcpExecutor ──▶ Pi tool execution
  │     ├── Project context (<project_instructions> / # Project Context)
  │     │     ──▶ CursorRule (global)
  │     ├── Skills (<available_skills>)
  │     │     ──▶ CursorRule (agentFetched)
  │     └── Structured sections (mcp_servers, rules, docs, addendum, custom)
  │           ──▶ CursorRule (global)
  └── Conversation messages
        ├── Cache valid & branch aligned ──▶ Native Cursor KV blob reuse
        └── Fork / cache miss / provider switch ──▶ Cold request + <prior_conversation_history>
```

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
```

## Requirements

- Pi (`>= 0.52.10`, tested with Pi 1.6+)
- An active Cursor subscription

## Attribution & License

Based on `pi-cursor-agent` from [sudosubin/pi-frontier](https://github.com/sudosubin/pi-frontier).

MIT — see [LICENSE](./LICENSE).
