import { setTimeout } from "node:timers/promises";
import {
  rejectPendingExceptSession,
  rejectPendingForSession,
} from "../bridge/cursor-to-pi/tool-bridge";
import { retainOnlyAgentStore } from "../lib/agent-store";
import { evictAgentStore, resetAgentStore } from "./agent-store";
import {
  deleteLiveSession,
  getLiveSession,
  retainOnlyLiveSession,
} from "./agent-stream-hook";

const TERMINATION_WAIT_MS = 2_000;

export async function terminateSession(
  sessionId: string,
  reason: string,
  options?: { persist?: boolean; resetStore?: boolean },
): Promise<void> {
  const persist = options?.persist !== false;
  const live = getLiveSession(sessionId);

  if (live) {
    live.abort(reason);
  }

  rejectPendingForSession(sessionId, reason);

  if (live) {
    await Promise.race([
      live.cursorRunPromise.catch(() => {}),
      setTimeout(TERMINATION_WAIT_MS),
    ]);
  }

  let flushed = false;
  if (live && persist) {
    try {
      await live.flushSessionState();
      flushed = true;
    } catch {}
  }

  deleteLiveSession(sessionId);
  await evictAgentStore(sessionId, { persist: persist && !flushed }).catch(
    () => {},
  );
  if (options?.resetStore) {
    resetAgentStore(sessionId);
  }
}

export function retainOnlyActiveSessionMemory(
  sessionId: string | null,
  reason = "Session ended",
): void {
  rejectPendingExceptSession(sessionId, reason);
  retainOnlyLiveSession(sessionId);
  retainOnlyAgentStore(sessionId);
}
