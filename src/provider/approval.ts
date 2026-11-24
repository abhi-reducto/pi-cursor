import type {
  ExtensionContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";

export type ApprovalMode = "dangerous" | "auto" | "ask";

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  "dangerous",
  "auto",
  "ask",
] as const;

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "dangerous";
export const APPROVAL_MODE_ENTRY_TYPE = "pi-cursor-agent:approval-mode";
export const APPROVAL_MODE_STATUS_KEY = "cursor-approval";
export const APPROVAL_MODE_ENV_VAR = "PI_CURSOR_APPROVAL";
export const APPROVAL_MODE_SHORTCUT = "ctrl+alt+a";

export type ApprovalAction =
  | { kind: "shell"; command: string; workingDirectory?: string }
  | { kind: "write"; path: string; isBinary?: boolean }
  | { kind: "delete"; path: string }
  | { kind: "mcp"; toolName: string; args?: Record<string, unknown> };

export interface ApprovalModeInfo {
  mode: ApprovalMode;
  label: string;
  description: string;
  badge: string;
  badgeColor: "dim" | "warning" | "accent";
}

export const APPROVAL_MODE_INFO: Record<ApprovalMode, ApprovalModeInfo> = {
  dangerous: {
    mode: "dangerous",
    label: "dangerous — prompt only on destructive shell commands (default)",
    description:
      "Auto-approve normal tools; prompt before dangerous shell commands (sudo, rm -rf, mkfs, dd, curl|sh, etc.)",
    badge: "cursor:safe",
    badgeColor: "dim",
  },
  auto: {
    mode: "auto",
    label: "auto — run everything without prompts",
    description:
      "Auto-approve all shell commands, file writes, deletes, and custom/MCP tools (TUI and headless)",
    badge: "cursor:auto",
    badgeColor: "warning",
  },
  ask: {
    mode: "ask",
    label: "ask — prompt before every mutating action",
    description:
      "Prompt before every shell command, file write, file delete, and custom/MCP tool call",
    badge: "cursor:ask",
    badgeColor: "accent",
  },
};

export function parseApprovalMode(
  raw: string | undefined | null,
): ApprovalMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "auto":
    case "yolo":
    case "all":
    case "off":
    case "none":
      return "auto";
    case "dangerous":
    case "default":
    case "safe":
      return "dangerous";
    case "ask":
    case "strict":
    case "prompt":
    case "confirm":
      return "ask";
    default:
      return undefined;
  }
}

export function getNextApprovalMode(current: ApprovalMode): ApprovalMode {
  const index = APPROVAL_MODES.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + 1) % APPROVAL_MODES.length;
  return APPROVAL_MODES[nextIndex] ?? DEFAULT_APPROVAL_MODE;
}

export function resolveInitialApprovalMode(options?: {
  flagValue?: unknown;
  envValue?: string | undefined;
}): ApprovalMode {
  const fromFlag =
    typeof options?.flagValue === "string"
      ? parseApprovalMode(options.flagValue)
      : undefined;
  if (fromFlag) return fromFlag;

  const fromEnv = parseApprovalMode(options?.envValue);
  if (fromEnv) return fromEnv;

  return DEFAULT_APPROVAL_MODE;
}

export function restoreApprovalModeFromBranch(
  entries: SessionEntry[],
): ApprovalMode | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.type !== "custom" ||
      entry.customType !== APPROVAL_MODE_ENTRY_TYPE
    ) {
      continue;
    }
    const data = entry.data as { mode?: unknown } | undefined;
    if (typeof data?.mode === "string") {
      const parsed = parseApprovalMode(data.mode);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

export function isDangerousShellCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (/(^|[\s;&|(])sudo\b/.test(c)) return true;
  if (
    /\brm\b.*(\s-[a-z]*r[a-z]*f\b|\s-[a-z]*f[a-z]*r\b|\s--recursive\b.*\s--force\b|\s--force\b.*\s--recursive\b)/.test(
      c,
    )
  ) {
    return true;
  }
  if (/\bmkfs(\.[a-z0-9]+)?\b|\bdd\b|\bshutdown\b|\breboot\b/.test(c)) {
    return true;
  }
  if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/.test(c)) return true;
  return false;
}

export function shouldPromptForAction(
  mode: ApprovalMode,
  action: ApprovalAction,
): boolean {
  switch (mode) {
    case "auto":
      return false;
    case "dangerous":
      return action.kind === "shell" && isDangerousShellCommand(action.command);
    case "ask":
      return true;
  }
}

const MAX_PROMPT_ARGS_CHARS = 300;

function formatMcpArgsPreview(
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return "{}";
  try {
    const text = JSON.stringify(args);
    if (!text) return "{}";
    if (text.length <= MAX_PROMPT_ARGS_CHARS) return text;
    return `${text.slice(0, MAX_PROMPT_ARGS_CHARS)}…`;
  } catch {
    return "{}";
  }
}

export function formatApprovalPrompt(action: ApprovalAction): {
  title: string;
  message: string;
} {
  switch (action.kind) {
    case "shell":
      return {
        title: "Cursor command approval",
        message: action.command,
      };
    case "write":
      return {
        title: "Cursor write approval",
        message: action.isBinary
          ? `Write binary file: ${action.path}`
          : `Write file: ${action.path}`,
      };
    case "delete":
      return {
        title: "Cursor delete approval",
        message: `Delete file: ${action.path}`,
      };
    case "mcp":
      return {
        title: `Cursor tool approval (${action.toolName})`,
        message: formatMcpArgsPreview(action.args),
      };
  }
}

export async function evaluateApproval(
  mode: ApprovalMode,
  getCtx: () => ExtensionContext | null,
  action: ApprovalAction,
): Promise<boolean> {
  if (!shouldPromptForAction(mode, action)) {
    return true;
  }
  const ctx = getCtx();
  if (!ctx?.hasUI) {
    return false;
  }
  const { title, message } = formatApprovalPrompt(action);
  return ctx.ui.confirm(title, message);
}
