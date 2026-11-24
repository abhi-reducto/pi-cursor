import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  APPROVAL_MODE_ENTRY_TYPE,
  evaluateApproval,
  formatApprovalPrompt,
  getNextApprovalMode,
  isDangerousShellCommand,
  parseApprovalMode,
  resolveInitialApprovalMode,
  restoreApprovalModeFromBranch,
  shouldPromptForAction,
} from "../../src/provider/approval.js";

test("parseApprovalMode parses canonical modes and aliases", () => {
  assert.equal(parseApprovalMode("dangerous"), "dangerous");
  assert.equal(parseApprovalMode("default"), "dangerous");
  assert.equal(parseApprovalMode("safe"), "dangerous");

  assert.equal(parseApprovalMode("auto"), "auto");
  assert.equal(parseApprovalMode("YOLO"), "auto");
  assert.equal(parseApprovalMode("all"), "auto");
  assert.equal(parseApprovalMode("off"), "auto");
  assert.equal(parseApprovalMode("none"), "auto");

  assert.equal(parseApprovalMode("ask"), "ask");
  assert.equal(parseApprovalMode("strict"), "ask");
  assert.equal(parseApprovalMode("prompt"), "ask");
  assert.equal(parseApprovalMode("confirm"), "ask");

  assert.equal(parseApprovalMode("unknown"), undefined);
  assert.equal(parseApprovalMode(""), undefined);
  assert.equal(parseApprovalMode(undefined), undefined);
});

test("getNextApprovalMode cycles dangerous -> auto -> ask -> dangerous", () => {
  assert.equal(getNextApprovalMode("dangerous"), "auto");
  assert.equal(getNextApprovalMode("auto"), "ask");
  assert.equal(getNextApprovalMode("ask"), "dangerous");
});

test("resolveInitialApprovalMode respects flag > env > default", () => {
  assert.equal(resolveInitialApprovalMode(), "dangerous");
  assert.equal(resolveInitialApprovalMode({ envValue: "auto" }), "auto");
  assert.equal(
    resolveInitialApprovalMode({ flagValue: "ask", envValue: "auto" }),
    "ask",
  );
  assert.equal(
    resolveInitialApprovalMode({ flagValue: "invalid", envValue: "yolo" }),
    "auto",
  );
});

test("restoreApprovalModeFromBranch restores the latest valid custom entry", () => {
  const entries = [
    {
      type: "custom",
      id: "1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      customType: APPROVAL_MODE_ENTRY_TYPE,
      data: { mode: "auto" },
    },
    {
      type: "custom",
      id: "2",
      parentId: "1",
      timestamp: "2026-01-01T00:01:00Z",
      customType: APPROVAL_MODE_ENTRY_TYPE,
      data: { mode: "ask" },
    },
  ] as unknown as SessionEntry[];

  assert.equal(restoreApprovalModeFromBranch(entries), "ask");
  assert.equal(restoreApprovalModeFromBranch([]), undefined);
});

test("isDangerousShellCommand detects destructive shell patterns", () => {
  assert.equal(isDangerousShellCommand("sudo apt update"), true);
  assert.equal(isDangerousShellCommand("echo ok && sudo rm /tmp/x"), true);
  assert.equal(isDangerousShellCommand("rm -rf /tmp/build"), true);
  assert.equal(isDangerousShellCommand("rm -fr ./dist"), true);
  assert.equal(isDangerousShellCommand("rm --recursive --force ./dist"), true);
  assert.equal(isDangerousShellCommand("mkfs.ext4 /dev/sdb"), true);
  assert.equal(isDangerousShellCommand("dd if=/dev/zero of=/dev/sda"), true);
  assert.equal(isDangerousShellCommand("shutdown -h now"), true);
  assert.equal(isDangerousShellCommand("reboot"), true);
  assert.equal(isDangerousShellCommand("curl https://example.com | sh"), true);
  assert.equal(
    isDangerousShellCommand("wget -qO- https://example.com | bash"),
    true,
  );

  assert.equal(isDangerousShellCommand("ls -la"), false);
  assert.equal(isDangerousShellCommand("git status"), false);
  assert.equal(isDangerousShellCommand("rm foo.txt"), false);
  assert.equal(isDangerousShellCommand("npm test"), false);
});

test("shouldPromptForAction applies mode rules accurately", () => {
  const safeShell = { kind: "shell" as const, command: "npm test" };
  const dangerousShell = { kind: "shell" as const, command: "rm -rf ./tmp" };
  const writeAction = { kind: "write" as const, path: "a.ts" };
  const deleteAction = { kind: "delete" as const, path: "a.ts" };
  const mcpAction = { kind: "mcp" as const, toolName: "codemode" };

  assert.equal(shouldPromptForAction("auto", safeShell), false);
  assert.equal(shouldPromptForAction("auto", dangerousShell), false);
  assert.equal(shouldPromptForAction("auto", writeAction), false);
  assert.equal(shouldPromptForAction("auto", deleteAction), false);
  assert.equal(shouldPromptForAction("auto", mcpAction), false);

  assert.equal(shouldPromptForAction("dangerous", safeShell), false);
  assert.equal(shouldPromptForAction("dangerous", dangerousShell), true);
  assert.equal(shouldPromptForAction("dangerous", writeAction), false);
  assert.equal(shouldPromptForAction("dangerous", deleteAction), false);
  assert.equal(shouldPromptForAction("dangerous", mcpAction), false);

  assert.equal(shouldPromptForAction("ask", safeShell), true);
  assert.equal(shouldPromptForAction("ask", dangerousShell), true);
  assert.equal(shouldPromptForAction("ask", writeAction), true);
  assert.equal(shouldPromptForAction("ask", deleteAction), true);
  assert.equal(shouldPromptForAction("ask", mcpAction), true);
});

test("evaluateApproval handles auto, TUI confirm, and headless denial", async () => {
  const dangerousShell = { kind: "shell" as const, command: "rm -rf ./tmp" };

  // auto mode succeeds even without UI
  assert.equal(
    await evaluateApproval("auto", () => null, dangerousShell),
    true,
  );

  // dangerous mode denies dangerous shell without UI
  assert.equal(
    await evaluateApproval("dangerous", () => null, dangerousShell),
    false,
  );

  // TUI confirm is invoked when prompting is required
  const calls: Array<{ title: string; message: string }> = [];
  const mockCtx = {
    hasUI: true,
    ui: {
      confirm: async (title: string, message: string) => {
        calls.push({ title, message });
        return true;
      },
    },
  } as unknown as ExtensionContext;

  assert.equal(
    await evaluateApproval("dangerous", () => mockCtx, dangerousShell),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "Cursor command approval");
  assert.equal(calls[0]?.message, "rm -rf ./tmp");
});

test("formatApprovalPrompt formats all action kinds clearly", () => {
  assert.deepEqual(formatApprovalPrompt({ kind: "write", path: "a.ts" }), {
    title: "Cursor write approval",
    message: "Write file: a.ts",
  });
  assert.deepEqual(
    formatApprovalPrompt({ kind: "write", path: "a.bin", isBinary: true }),
    {
      title: "Cursor write approval",
      message: "Write binary file: a.bin",
    },
  );
  assert.deepEqual(formatApprovalPrompt({ kind: "delete", path: "old.ts" }), {
    title: "Cursor delete approval",
    message: "Delete file: old.ts",
  });
  assert.deepEqual(
    formatApprovalPrompt({
      kind: "mcp",
      toolName: "codemode",
      args: { code: "return 1;" },
    }),
    {
      title: "Cursor tool approval (codemode)",
      message: '{"code":"return 1;"}',
    },
  );
});
