import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { DeleteArgs } from "../../../src/__generated__/agent/v1/delete_exec_pb.js";
import { McpArgs } from "../../../src/__generated__/agent/v1/mcp_tool_pb.js";
import { ShellArgs } from "../../../src/__generated__/agent/v1/shell_exec_pb.js";
import { WriteArgs } from "../../../src/__generated__/agent/v1/write_exec_pb.js";
import { LocalDeleteExecutor } from "../../../src/bridge/cursor-to-pi/executors/delete.js";
import {
  buildMcpResultFromToolResult,
  LocalMcpExecutor,
  resolveMcpToolName,
} from "../../../src/bridge/cursor-to-pi/executors/mcp.js";
import { buildReadResultFromToolResult } from "../../../src/bridge/cursor-to-pi/executors/read.js";
import {
  buildScopedShellCommand,
  LocalShellExecutor,
} from "../../../src/bridge/cursor-to-pi/executors/shell.js";
import { LocalWriteExecutor } from "../../../src/bridge/cursor-to-pi/executors/write.js";
import type { PiToolContext } from "../../../src/bridge/cursor-to-pi/local-resource-provider/types.js";

test("resolveMcpToolName handles toolName and provider-prefixed name", () => {
  assert.equal(
    resolveMcpToolName({
      name: "pi-agent-codemode",
      toolName: "codemode",
      providerIdentifier: "pi-agent",
    }),
    "codemode",
  );
  assert.equal(
    resolveMcpToolName({
      name: "pi-agent-codemode",
      toolName: "",
      providerIdentifier: "pi-agent",
    }),
    "codemode",
  );
});

test("buildMcpResultFromToolResult preserves text and image blocks", () => {
  const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "codemode",
    content: [
      { type: "text", text: "Generated output" },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 1,
  };

  const mcpRes = buildMcpResultFromToolResult(result);
  assert.equal(mcpRes.result.case, "success");
  assert.equal(mcpRes.result.value.content.length, 2);
  assert.equal(mcpRes.result.value.content[0]?.content.case, "text");
  assert.equal(mcpRes.result.value.content[1]?.content.case, "image");
  if (mcpRes.result.value.content[1]?.content.case === "image") {
    assert.equal(
      mcpRes.result.value.content[1].content.value.mimeType,
      "image/png",
    );
    assert.deepEqual(
      Array.from(mcpRes.result.value.content[1].content.value.data),
      [0x89, 0x50, 0x4e, 0x47],
    );
  }
});

test("buildReadResultFromToolResult returns binary data for image reads", () => {
  const pngBase64 = Buffer.from([1, 2, 3, 4]).toString("base64");
  const res = buildReadResultFromToolResult("/tmp/a.png", {
    role: "toolResult",
    toolCallId: "r1",
    toolName: "read",
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 1,
  });

  assert.equal(res.result.case, "success");
  assert.equal(res.result.value.output.case, "data");
  if (res.result.value.output.case === "data") {
    assert.deepEqual(Array.from(res.result.value.output.value), [1, 2, 3, 4]);
  }
});

test("buildScopedShellCommand scopes workingDirectory when different from cwd", () => {
  assert.equal(
    buildScopedShellCommand("ls", "/home/user/repo", "/home/user/repo"),
    "ls",
  );
  assert.equal(
    buildScopedShellCommand("ls || true", "/tmp/sub dir", "/home/user/repo"),
    "cd '/tmp/sub dir' && {\nls || true\n}",
  );
});

test("buildReadResultFromToolResult maps ENOENT and EACCES to typed ReadResult cases", () => {
  const notFound = buildReadResultFromToolResult("/tmp/missing.ts", {
    role: "toolResult",
    toolCallId: "r2",
    toolName: "read",
    content: [
      {
        type: "text",
        text: "ENOENT: no such file or directory, access '/tmp/missing.ts'",
      },
    ],
    isError: true,
    timestamp: 1,
  });
  assert.equal(notFound.result.case, "fileNotFound");

  const denied = buildReadResultFromToolResult("/tmp/secret.ts", {
    role: "toolResult",
    toolCallId: "r3",
    toolName: "read",
    content: [{ type: "text", text: "EACCES: permission denied" }],
    isError: true,
    timestamp: 1,
  });
  assert.equal(denied.result.case, "permissionDenied");
});

test("executors honor requestApproval rejection for shell, write, delete, and mcp", async () => {
  const deniedActions: string[] = [];
  const ctx: PiToolContext = {
    cwd: "/tmp",
    getActiveTools: () => new Set(["bash", "write", "codemode"]),
    getCtx: () => null,
    requestApproval: async (action) => {
      deniedActions.push(action.kind);
      return false;
    },
  };

  const shellRes = await new LocalShellExecutor(ctx).execute(
    null,
    new ShellArgs({ command: "echo hi", toolCallId: "s1" }),
  );
  assert.equal(shellRes.result.case, "rejected");

  const writeRes = await new LocalWriteExecutor(ctx).execute(
    null,
    new WriteArgs({ path: "a.ts", fileText: "hi", toolCallId: "w1" }),
  );
  assert.equal(writeRes.result.case, "rejected");

  const deleteRes = await new LocalDeleteExecutor(ctx).execute(
    null,
    new DeleteArgs({ path: "a.ts", toolCallId: "d1" }),
  );
  assert.equal(deleteRes.result.case, "rejected");

  const mcpRes = await new LocalMcpExecutor(ctx).execute(
    null,
    new McpArgs({ toolName: "codemode", toolCallId: "m1" }),
  );
  assert.equal(mcpRes.result.case, "error");
  if (mcpRes.result.case === "error") {
    assert.match(mcpRes.result.value.error, /rejected/i);
  }

  assert.deepEqual(deniedActions, ["shell", "write", "delete", "mcp"]);
});
