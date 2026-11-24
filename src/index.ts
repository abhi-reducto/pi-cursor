import type {
  Api,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import AiService from "./api/ai-service";
import Auth from "./api/auth";
import { resolveToolResult } from "./bridge/cursor-to-pi/tool-bridge";
import AuthManager from "./lib/auth";
import {
  CURSOR_API_URL,
  CURSOR_CLIENT_VERSION,
  CURSOR_WEBSITE_URL,
} from "./lib/env";
import { restoreAgentStoreFromBranch } from "./provider/agent-store";
import {
  APPROVAL_MODE_ENTRY_TYPE,
  APPROVAL_MODE_ENV_VAR,
  APPROVAL_MODE_INFO,
  APPROVAL_MODE_SHORTCUT,
  APPROVAL_MODE_STATUS_KEY,
  APPROVAL_MODES,
  type ApprovalMode,
  evaluateApproval,
  getNextApprovalMode,
  parseApprovalMode,
  resolveInitialApprovalMode,
  restoreApprovalModeFromBranch,
} from "./provider/approval";
import {
  getCachedPiModels,
  updateCachedPiModelsIfStale,
} from "./provider/models";
import {
  retainOnlyActiveSessionMemory,
  terminateSession,
} from "./provider/session-lifecycle";
import { createStateStore } from "./provider/state";
import { streamCursorAgent } from "./provider/stream";

const auth = new AuthManager(new Auth(CURSOR_API_URL), CURSOR_WEBSITE_URL);

const createAiService = (accessToken: string) => {
  return new AiService(CURSOR_API_URL, {
    accessToken,
    clientVersion: CURSOR_CLIENT_VERSION,
    clientType: "cli",
  });
};

const updateCachedModelsInBackground = (accessToken: string) => {
  const ai = createAiService(accessToken);
  void updateCachedPiModelsIfStale(ai).catch(() => {}); // ignore
};

const updateCachedModelsFromContextInBackground = (ctx: ExtensionContext) => {
  void (async () => {
    const accessToken =
      await ctx.modelRegistry.getApiKeyForProvider("cursor-agent");
    if (!accessToken) {
      return;
    }

    await updateCachedPiModelsIfStale(createAiService(accessToken));
  })().catch(() => {}); // ignore
};

const login = async (
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> => {
  const credentials = await auth.login(callbacks);
  updateCachedModelsInBackground(credentials.access);
  return credentials;
};

const refreshToken = async (
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> => {
  const refreshed = await auth.refresh(credentials);
  updateCachedModelsInBackground(refreshed.access);
  return refreshed;
};

export default (pi: ExtensionAPI) => {
  let lastCtx: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  const getCtx = () => lastCtx;

  pi.registerFlag("cursor-approval", {
    description:
      "Cursor tool approval mode: dangerous (default), auto (run everything), or ask (prompt all)",
    type: "string",
  });

  const resolveDefaultApprovalMode = (): ApprovalMode =>
    resolveInitialApprovalMode({
      flagValue: pi.getFlag("cursor-approval"),
      envValue: process.env[APPROVAL_MODE_ENV_VAR],
    });

  let approvalMode: ApprovalMode = resolveInitialApprovalMode({
    envValue: process.env[APPROVAL_MODE_ENV_VAR],
  });

  const updateApprovalStatus = (ctx: ExtensionContext | null) => {
    if (!ctx?.hasUI) return;
    if (ctx.model?.provider === "cursor-agent") {
      const info = APPROVAL_MODE_INFO[approvalMode];
      ctx.ui.setStatus(
        APPROVAL_MODE_STATUS_KEY,
        ctx.ui.theme.fg(info.badgeColor, info.badge),
      );
    } else {
      ctx.ui.setStatus(APPROVAL_MODE_STATUS_KEY, undefined);
    }
  };

  const setApprovalMode = (
    nextMode: ApprovalMode,
    ctx: ExtensionContext | null,
    options?: { persist?: boolean; notify?: boolean },
  ) => {
    approvalMode = nextMode;
    if (options?.persist !== false) {
      pi.appendEntry(APPROVAL_MODE_ENTRY_TYPE, { mode: nextMode });
    }
    updateApprovalStatus(ctx);
    if (options?.notify && ctx?.hasUI) {
      const info = APPROVAL_MODE_INFO[nextMode];
      ctx.ui.notify(
        `Cursor approval mode: ${nextMode} — ${info.description}`,
        nextMode === "auto" ? "warning" : "info",
      );
    }
  };

  const state = createStateStore((type, data) => {
    pi.appendEntry(type, data);
  });

  const cleanupPreviousSession = async (newSessionId: string) => {
    const previousSessionId = currentSessionId;
    currentSessionId = newSessionId;
    if (previousSessionId && previousSessionId !== newSessionId) {
      await terminateSession(previousSessionId, "Session ended");
    }
  };

  const refreshBranchState = async (ctx: ExtensionContext) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    await cleanupPreviousSession(sessionId);
    const branch = ctx.sessionManager.getBranch();
    state.resetFromContext(ctx);
    approvalMode =
      restoreApprovalModeFromBranch(branch) ?? resolveDefaultApprovalMode();
    updateApprovalStatus(ctx);
    try {
      await restoreAgentStoreFromBranch(sessionId, branch);
    } catch {}
    retainOnlyActiveSessionMemory(sessionId);
  };

  const ensureBranchStateSynced = async (ctx: ExtensionContext) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    if (currentSessionId !== sessionId) {
      await refreshBranchState(ctx);
    } else {
      updateApprovalStatus(ctx);
    }
  };

  pi.registerCommand("cursor-approval", {
    description:
      "Set or inspect Cursor tool approval mode (dangerous | auto | ask)",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const items = APPROVAL_MODES.map((mode) => ({
        value: mode,
        label: mode,
        description: APPROVAL_MODE_INFO[mode].description,
      }));
      const filtered = query
        ? items.filter((item) => item.value.startsWith(query))
        : items;
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const trimmed = args.trim();
      if (!trimmed) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`Cursor approval mode: ${approvalMode}`, "info");
          return;
        }
        const options = APPROVAL_MODES.map((mode) => {
          const info = APPROVAL_MODE_INFO[mode];
          return mode === approvalMode ? `${info.label} [active]` : info.label;
        });
        const chosen = await ctx.ui.select(
          "Cursor tool approval mode",
          options,
        );
        if (!chosen) return;
        const selectedMode = APPROVAL_MODES.find((mode) =>
          chosen.startsWith(mode),
        );
        if (selectedMode) {
          setApprovalMode(selectedMode, ctx, { notify: true });
        }
        return;
      }

      if (
        trimmed.toLowerCase() === "cycle" ||
        trimmed.toLowerCase() === "next"
      ) {
        setApprovalMode(getNextApprovalMode(approvalMode), ctx, {
          notify: true,
        });
        return;
      }

      const parsed = parseApprovalMode(trimmed);
      if (!parsed) {
        ctx.ui.notify(
          `Unknown approval mode "${trimmed}". Use: dangerous, auto (or yolo), or ask`,
          "error",
        );
        return;
      }

      setApprovalMode(parsed, ctx, { notify: true });
    },
  });

  pi.registerShortcut(APPROVAL_MODE_SHORTCUT, {
    description: "Cycle Cursor approval mode (dangerous → auto → ask)",
    handler: async (ctx) => {
      lastCtx = ctx;
      setApprovalMode(getNextApprovalMode(approvalMode), ctx, { notify: true });
    },
  });

  pi.on("before_agent_start", async (_, ctx) => {
    await ensureBranchStateSynced(ctx);
  });

  pi.on("agent_start", async (_, ctx) => {
    await ensureBranchStateSynced(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    lastCtx = ctx;
    updateApprovalStatus(ctx);
    if (event.model.provider === "cursor-agent") {
      updateCachedModelsFromContextInBackground(ctx);
    }
  });

  pi.on("session_start", async (_, ctx) => {
    await refreshBranchState(ctx);
    updateCachedModelsFromContextInBackground(ctx);
  });

  // Compatibility with Pi <0.65 where session switches fired a separate event.
  (
    pi.on as (
      event: string,
      handler: (_event: unknown, ctx: ExtensionContext) => Promise<void>,
    ) => void
  )("session_switch", async (_event, ctx) => {
    await refreshBranchState(ctx);
    updateCachedModelsFromContextInBackground(ctx);
  });

  pi.on("session_tree", async (_, ctx) => {
    await refreshBranchState(ctx);
  });

  pi.on("session_compact", async (_, ctx) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    await terminateSession(sessionId, "Session compacted", {
      persist: false,
      resetStore: true,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    resolveToolResult({
      role: "toolResult",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.result?.content ?? [],
      details: event.result?.details,
      isError: event.isError,
      timestamp: Date.now(),
    });
  });

  pi.registerProvider("cursor-agent", {
    baseUrl: CURSOR_API_URL,
    apiKey: "CURSOR_ACCESS_TOKEN",
    api: "cursor-agent" as unknown as Api,
    streamSimple: (model, context, options) =>
      streamCursorAgent(pi, getCtx, state, model, context, options, (action) =>
        evaluateApproval(approvalMode, getCtx, action),
      ),
    models: getCachedPiModels(),
    oauth: {
      name: "Cursor",
      login,
      refreshToken,
      getApiKey: (cred) => cred.access,
    },
  });
};
