/**
 * Delegate Store
 *
 * In-memory state management for Delegate (attention proxy) mode.
 * Goals are scoped to composite key `${channelKey}:${wsName}`.
 *
 * Persistence is optional — Phase 2 (P2-persist) can add SQLite storage.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface DelegateEntry {
  goal: string;
  iterationCount: number;
  status: "active" | "completed" | "exited";
  lastContinuePrompt?: string;
}

export type DelegateStatus = { status: string; goal: string };

// ── Store ──────────────────────────────────────────────────────────

const store = new Map<string, DelegateEntry>();

// ── Public API ─────────────────────────────────────────────────────

/**
 * Enter delegate mode for a workspace.
 * Overwrites any existing entry (re-entrant).
 */
export function enter(wsKey: string, goal: string): void {
  store.set(wsKey, { goal, iterationCount: 0, status: "active" });
}

/**
 * Exit delegate mode for a workspace.
 * No-op if the workspace is not in delegate mode.
 */
export function exit(wsKey: string): void {
  store.delete(wsKey);
}

/**
 * Returns true if the workspace is currently in active delegate mode.
 */
export function isActive(wsKey: string): boolean {
  const entry = store.get(wsKey);
  return entry !== undefined && entry.status === "active";
}

/**
 * Returns the current goal text, or null if not in delegate mode.
 */
export function getGoal(wsKey: string): string | null {
  const entry = store.get(wsKey);
  return entry?.goal ?? null;
}

/**
 * Returns a summary of delegate status for display in /max:delegate status
 * and /max:status commands. Returns null if not in delegate mode.
 */
export function getStatus(wsKey: string): DelegateStatus | null {
  const entry = store.get(wsKey);
  if (!entry) return null;
  return { status: entry.status, goal: entry.goal };
}

/**
 * Increment the iteration counter and return the new value.
 * Returns -1 if the workspace is not in delegate mode.
 */
export function incrementIteration(wsKey: string): number {
  const entry = store.get(wsKey);
  if (!entry) return -1;
  entry.iterationCount++;
  return entry.iterationCount;
}

/**
 * Record the last "继续" prompt text for dedup detection.
 * If the same prompt is produced twice in a row, treat the goal as achieved.
 */
export function setLastContinuePrompt(wsKey: string, prompt: string): void {
  const entry = store.get(wsKey);
  if (entry) entry.lastContinuePrompt = prompt;
}

/**
 * Returns the last "继续" prompt text, or empty string if none.
 */
export function getLastContinuePrompt(wsKey: string): string {
  return store.get(wsKey)?.lastContinuePrompt ?? "";
}
