import Database from "better-sqlite3";
import { DB_PATH, ensureMaxHome } from "../paths.js";

const MESSAGE_TTL_MS = 24 * 3600_000; // 24 hours — shared by startup prune & periodic prune
const ts = () => new Date().toISOString();

let db: Database.Database | undefined;
let logInsertCount = 0;
let fts5Available = false;

export function getDb(): Database.Database {
  if (!db) {
    ensureMaxHome();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        copilot_session_id TEXT,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration: add config_dir to worker_sessions (existing DBs)
    try {
      db.exec(`ALTER TABLE worker_sessions ADD COLUMN config_dir TEXT`);
    } catch {
      // Column already exists, ignore
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS max_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate: if the table already existed with a stricter CHECK, recreate it
    try {
      db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`).run();
      db.prepare(`DELETE FROM conversation_log WHERE content = '__migration_test__'`).run();
    } catch {
      // CHECK constraint doesn't allow 'system' — recreate table preserving data
      db.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
      db.exec(`
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`);
      db.exec(`DROP TABLE conversation_log_old`);
    }
    // Prune conversation log at startup — keep more history for better recovery
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 1000)`).run();

    // Persistent message dedup — survives restarts so Feishu replay doesn't loop
    db.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      )
    `);
    // Prune entries older than 24 hours on startup
    const cutoff = Date.now() - MESSAGE_TTL_MS;
    const pruneResult = db.prepare(`DELETE FROM processed_messages WHERE processed_at < ?`).run(cutoff);
    if (pruneResult.changes > 0) {
      console.log(`[db] ${ts()} Pruned ${pruneResult.changes} expired message(s) on startup`);
    }

    // Set up FTS5 for memory search (graceful fallback if not available)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content_rowid='id'
        )
      `);
      // Sync triggers
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      // Backfill: check if FTS is in sync by comparing row counts
      const memCount = (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
      const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memories_fts`).get() as { c: number }).c;
      if (memCount > 0 && ftsCount < memCount) {
        db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
      }
      fts5Available = true;
    } catch {
      // FTS5 not available in this SQLite build — fall back to LIKE queries
      fts5Available = false;
    }
  }
  return db;
}

export function getState(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM max_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO max_state (key, value) VALUES (?, ?)`).run(key, value);
}

/** Remove a key from persistent state. */
export function deleteState(key: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM max_state WHERE key = ?`).run(key);
}

/** Log a conversation turn (user, assistant, or system). */
export function logConversation(role: "user" | "assistant" | "system", content: string, source: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES (?, ?, ?)`).run(role, content, source);
  // Keep last 1000 entries to support context recovery after session loss
  logInsertCount++;
  if (logInsertCount % 50 === 0) {
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 1000)`).run();
  }
}

/** Get recent conversation history formatted for injection into system message. */
export function getRecentConversation(limit = 20): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as { role: string; content: string; source: string; ts: string }[];

  if (rows.length === 0) return "";

  // Reverse so oldest is first (chronological order)
  rows.reverse();

  return rows.map((r) => {
    const tag = r.role === "user" ? "User"
      : r.role === "system" ? "System"
      : "Max";
    // Truncate long messages to keep context manageable
    const content = r.content.length > 1500 ? r.content.slice(0, 1500) + "…" : r.content;
    return `${tag}: ${content}`;
  }).join("\n\n");
}

/** Get the most recent N user messages (role='user') for goal extraction. */
export function getRecentUserMessages(limit = 10): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT content FROM conversation_log WHERE role = 'user' ORDER BY id DESC LIMIT ?`
  ).all(limit) as { content: string }[];
  // Reverse so oldest is first (chronological)
  return rows.map(r => r.content).reverse();
}

// ---------------------------------------------------------------------------
// SQLite memory functions removed — wiki is the single source of truth.

// ── Persistent message deduplication ──────────────────────────────

let pruneCounter = 0;

/** Returns true if this message_id was already processed. */
export function isMessageProcessed(messageId: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT processed_at FROM processed_messages WHERE message_id = ?`).get(messageId) as { processed_at: number } | undefined;
  if (row) {
    const ageMs = Date.now() - row.processed_at;
    console.log(`[db] ${ts()} Duplicate message_id=${messageId} (age=${(ageMs / 1000).toFixed(0)}s)`);
    return true;
  }
  return false;
}

/** Mark a message_id as processed. Ignores duplicates. */
export function markMessageProcessed(messageId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)`).run(messageId, now);
  console.log(`[db] ${ts()} Marked message_id=${messageId}`);
  // Periodic prune — every 50th insert, clean up expired entries
  pruneCounter++;
  if (pruneCounter % 50 === 0) {
    db.prepare(`DELETE FROM processed_messages WHERE processed_at < ?`).run(Date.now() - MESSAGE_TTL_MS);
  }
}
// The memories table and FTS5 index are preserved in the schema for safety
// (existing data is not deleted), but no code reads or writes to them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspace management (using worker_sessions + max_state)
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  name: string;
  working_dir: string;
  copilot_session_id: string | null;
  config_dir: string | null;
}

export function listWorkspaces(): WorkspaceRow[] {
  const db = getDb();
  return db.prepare(`SELECT name, working_dir, copilot_session_id, config_dir FROM worker_sessions ORDER BY name`).all() as WorkspaceRow[];
}

export function getWorkspace(name: string): WorkspaceRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT name, working_dir, copilot_session_id, config_dir FROM worker_sessions WHERE name = ?`).get(name) as WorkspaceRow | undefined;
}

export function createWorkspace(name: string, workingDir: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO worker_sessions (name, working_dir, status) VALUES (?, ?, 'idle')`).run(name, workingDir);
}

export function deleteWorkspace(name: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(name);
}

export function saveWorkspaceSessionId(name: string, sessionId: string): void {
  const db = getDb();
  db.prepare(`UPDATE worker_sessions SET copilot_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(sessionId, name);
}

export function saveWorkspaceConfigDir(name: string, configDir: string): void {
  const db = getDb();
  db.prepare(`UPDATE worker_sessions SET config_dir = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(configDir, name);
}

export function clearWorkspaceSessionId(name: string): void {
  const db = getDb();
  db.prepare(`UPDATE worker_sessions SET copilot_session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(name);
}

/** Map per-connection TUI keys (tui:tui-1, tui:tui-2) to a single stable key
 *  so workspace preferences survive SSE reconnects.
 *  Feishu and other channels pass through unchanged so each user is isolated. */
function normalizeChannelKey(channelKey: string): string {
  if (channelKey.startsWith("tui:")) return "tui:main";
  return channelKey;
}

/** Get the active workspace name for a channel key (e.g. "telegram:123"). Returns "default" if not set. */
export function getActiveWorkspace(channelKey: string): string {
  return getState(`active_ws:${normalizeChannelKey(channelKey)}`) ?? "default";
}

/** Set the active workspace for a channel key. */
export function setActiveWorkspace(channelKey: string, name: string): void {
  setState(`active_ws:${normalizeChannelKey(channelKey)}`, name);
}

/** Force-flush all pending DB writes to disk. Call before process.exit(). */
export function syncDb(): void {
  if (!db) return;
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
}

export function closeDb(): void {
  if (db) {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
    db.close();
    db = undefined;
  }
}
