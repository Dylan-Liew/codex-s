import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "../lib/errors.js";
import { resolveCodexHome, type CodexHomeOptions } from "./config.js";

const SESSION_ID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export interface CodexSession {
  id: string;
  title: string;
  updatedAt: string;
  location: "active" | "archived" | "missing";
  filePaths: string[];
  fromIndex: boolean;
  fromCatalog: boolean;
  indexRecord?: Record<string, unknown>;
}

interface IndexRow {
  session: CodexSession;
  record: Record<string, unknown>;
}

export interface DeleteSummary {
  deletedFiles: number;
  removedIndexEntries: number;
  removedDatabaseEntries: number;
  removedStateReferences: number;
  backupPath?: string;
  additionalBackupPaths: string[];
}

interface CatalogRecord {
  id: string;
  title: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultCodexHome(options: CodexHomeOptions = {}): string {
  return resolveCodexHome(options);
}

export function getIndexPath(codexHome = defaultCodexHome()): string {
  return path.join(codexHome, "session_index.jsonl");
}

export function getDesktopCatalogPath(codexHome = defaultCodexHome()): string {
  return path.join(codexHome, "sqlite", "codex-dev.db");
}

export function getStateDatabasePath(codexHome = defaultCodexHome()): string {
  return path.join(codexHome, "state_5.sqlite");
}

function getSessionDirs(codexHome: string): string[] {
  return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

export function sessionIdFromPath(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const match = SESSION_ID_RE.exec(stem);
  return match ? match[0] : stem;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function cleanThreadName(text: string): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0 || lines[0].startsWith("<environment_context>")) {
    return "";
  }

  return lines[0];
}

function sessionFileInfo(filePath: string): Pick<CodexSession, "id" | "title"> {
  const info = { id: sessionIdFromPath(filePath), title: "" };

  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, 500);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let item: unknown;

      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      if (!isRecord(item)) {
        continue;
      }

      const payload = isRecord(item.payload) ? item.payload : {};

      if (item.type === "session_meta") {
        if (typeof payload.id === "string") {
          info.id = payload.id;
        }

        if (typeof payload.cwd === "string" && !info.title) {
          info.title = path.basename(payload.cwd).replace(/-/g, " ");
        }

        continue;
      }

      let text = "";

      if (item.type === "event_msg" && payload.type === "user_message") {
        text = typeof payload.message === "string" ? payload.message : "";
      } else if (item.type === "response_item") {
        if (payload.type === "message" && payload.role === "user") {
          text = messageContentText(payload.content);
        }
      }

      const title = cleanThreadName(text);

      if (title) {
        info.title = title;
        break;
      }
    }
  } catch {
    // Ignore unreadable session files and fall back to the filename.
  }

  if (!info.title) {
    info.title = path.basename(filePath);
  }

  return info;
}

function walkJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
}

function sessionLocation(filePaths: string[]): CodexSession["location"] {
  if (filePaths.length === 0) {
    return "missing";
  }

  return filePaths.some((filePath) => filePath.includes(`${path.sep}archived_sessions${path.sep}`))
    ? "archived"
    : "active";
}

function readIndexRows(codexHome: string): IndexRow[] {
  const indexPath = getIndexPath(codexHome);

  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const rows: IndexRow[] = [];
  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      continue;
    }

    let record: unknown;

    try {
      record = JSON.parse(line);
    } catch {
      process.stderr.write(`Skipping invalid JSON on line ${index + 1}\n`);
      continue;
    }

    if (!isRecord(record) || typeof record.id !== "string") {
      continue;
    }

    rows.push({
      record,
      session: {
        id: record.id,
        title: typeof record.thread_name === "string" ? record.thread_name : "(untitled)",
        updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
        location: "missing",
        filePaths: [],
        fromIndex: true,
        fromCatalog: false,
        indexRecord: record,
      },
    });
  }

  return rows;
}

function scanSessionFiles(codexHome: string): CodexSession[] {
  const sessions: CodexSession[] = [];
  const seen = new Set<string>();
  const files = getSessionDirs(codexHome)
    .flatMap((sessionDir) => walkJsonlFiles(sessionDir))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  for (const filePath of files) {
    const info = sessionFileInfo(filePath);

    if (seen.has(info.id)) {
      continue;
    }

    seen.add(info.id);
    sessions.push({
      id: info.id,
      title: info.title,
      updatedAt: new Date(fs.statSync(filePath).mtimeMs).toISOString(),
      location: sessionLocation([filePath]),
      filePaths: [filePath],
      fromIndex: false,
      fromCatalog: false,
    });
  }

  return sessions;
}

export function findSessionFiles(sessionId: string, codexHome = defaultCodexHome()): string[] {
  return getSessionDirs(codexHome)
    .flatMap((sessionDir) => walkJsonlFiles(sessionDir))
    .filter((filePath) => path.basename(filePath).includes(sessionId))
    .sort();
}

function sortSessionTime(session: CodexSession): number {
  if (!session.updatedAt) {
    return 0;
  }

  const time = Date.parse(session.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

function latestIndexRowsById(indexRows: IndexRow[]): IndexRow[] {
  const latestRows = new Map<string, IndexRow>();

  for (const row of indexRows) {
    const existing = latestRows.get(row.session.id);

    if (!existing || sortSessionTime(row.session) >= sortSessionTime(existing.session)) {
      latestRows.set(row.session.id, row);
    }
  }

  return [...latestRows.values()];
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function catalogSessions(codexHome: string, fileRows: CodexSession[]): CodexSession[] | undefined {
  const databasePath = getDesktopCatalogPath(codexHome);

  if (!fs.existsSync(databasePath)) {
    return undefined;
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });

  try {
    if (!tableExists(database, "local_thread_catalog")) {
      return undefined;
    }

    const records = database
      .prepare(
        `SELECT thread_id AS id,
                display_title AS title,
                MAX(source_recency_at, source_updated_at, source_created_at) AS updated_at
           FROM local_thread_catalog
          WHERE host_id = 'local' AND missing_candidate = 0
          ORDER BY updated_at DESC, thread_id DESC`,
      )
      .all() as unknown as Array<{ id: string; title: string; updated_at: number }>;
    const filesById = new Map(fileRows.map((session) => [session.id, session]));
    const latestRecords = new Map<string, CatalogRecord>();

    for (const record of records) {
      if (latestRecords.has(record.id)) {
        continue;
      }

      latestRecords.set(record.id, {
        id: record.id,
        title: record.title || "(untitled)",
        updatedAt: new Date(record.updated_at * 1000).toISOString(),
      });
    }

    return [...latestRecords.values()].map((record) => {
      const fileSession = filesById.get(record.id);
      return {
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        location: "active",
        filePaths: fileSession?.filePaths ?? [],
        fromIndex: false,
        fromCatalog: true,
      };
    });
  } finally {
    database.close();
  }
}

export function listSessions(codexHome = defaultCodexHome()): CodexSession[] {
  const fileRows = scanSessionFiles(codexHome);
  const desktopSessions = catalogSessions(codexHome, fileRows);

  // The Desktop catalog is the source that backs the visible Codex thread list.
  // Only fall back to the legacy index/file merge on older installations.
  if (desktopSessions !== undefined) {
    return desktopSessions;
  }

  const indexRows = latestIndexRowsById(readIndexRows(codexHome));
  const filesById = new Map(fileRows.map((session) => [session.id, session]));
  const seenIds = new Set<string>();
  const sessions: CodexSession[] = [];

  for (const row of indexRows) {
    const fileSession = filesById.get(row.session.id);
    const mergedSession = fileSession
      ? {
          ...row.session,
          filePaths: fileSession.filePaths,
          location: fileSession.location,
          updatedAt: row.session.updatedAt || fileSession.updatedAt,
        }
      : row.session;

    seenIds.add(mergedSession.id);
    sessions.push(mergedSession);
  }

  for (const session of fileRows) {
    if (!seenIds.has(session.id)) {
      seenIds.add(session.id);
      sessions.push(session);
    }
  }

  return sessions.sort((left, right) => sortSessionTime(right) - sortSessionTime(left));
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function backupDatabase(database: DatabaseSync, databasePath: string): string {
  const backupPath = `${databasePath}.bak-${backupStamp()}`;
  database.prepare("VACUUM INTO ?").run(backupPath);
  return backupPath;
}

function removeDesktopCatalogEntries(
  selectedIds: Set<string>,
  codexHome: string,
): {
  removed: number;
  backupPath?: string;
} {
  const databasePath = getDesktopCatalogPath(codexHome);

  if (!fs.existsSync(databasePath)) {
    return { removed: 0 };
  }

  const database = new DatabaseSync(databasePath);

  try {
    if (!tableExists(database, "local_thread_catalog")) {
      return { removed: 0 };
    }

    const ids = [...selectedIds];
    const placeholders = ids.map(() => "?").join(", ");
    const count = Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count
               FROM local_thread_catalog
              WHERE host_id = 'local' AND thread_id IN (${placeholders})`,
          )
          .get(...ids) as { count: number }
      ).count,
    );

    if (count === 0) {
      return { removed: 0 };
    }

    const backupPath = backupDatabase(database, databasePath);
    database.exec("BEGIN IMMEDIATE");

    try {
      if (tableExists(database, "thread_timeline_ledger")) {
        database
          .prepare(
            `DELETE FROM thread_timeline_ledger
              WHERE host_id = 'local' AND thread_id IN (${placeholders})`,
          )
          .run(...ids);
      }

      database
        .prepare(
          `DELETE FROM local_thread_catalog
            WHERE host_id = 'local' AND thread_id IN (${placeholders})`,
        )
        .run(...ids);

      if (tableExists(database, "local_thread_catalog_metadata")) {
        database.exec(
          "UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1",
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return { removed: count, backupPath };
  } finally {
    database.close();
  }
}

function removeStateDatabaseEntries(
  selectedIds: Set<string>,
  codexHome: string,
): {
  removed: number;
  backupPath?: string;
} {
  const databasePath = getStateDatabasePath(codexHome);

  if (!fs.existsSync(databasePath)) {
    return { removed: 0 };
  }

  const database = new DatabaseSync(databasePath);

  try {
    if (!tableExists(database, "threads")) {
      return { removed: 0 };
    }

    const ids = [...selectedIds];
    const placeholders = ids.map(() => "?").join(", ");
    const count = Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM threads WHERE id IN (${placeholders})`)
          .get(...ids) as { count: number }
      ).count,
    );

    if (count === 0) {
      return { removed: 0 };
    }

    const backupPath = backupDatabase(database, databasePath);
    database.exec("BEGIN IMMEDIATE");

    try {
      if (tableExists(database, "thread_dynamic_tools")) {
        database
          .prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`)
          .run(...ids);
      }

      if (tableExists(database, "thread_spawn_edges")) {
        database
          .prepare(
            `DELETE FROM thread_spawn_edges
              WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
          )
          .run(...ids, ...ids);
      }

      database.prepare(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...ids);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return { removed: count, backupPath };
  } finally {
    database.close();
  }
}

function referencesSelectedId(value: unknown, selectedIds: Set<string>): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return [value.id, value.threadId, value.thread_id].some(
    (candidate) => typeof candidate === "string" && selectedIds.has(candidate),
  );
}

function purgeStateReferences(value: unknown, selectedIds: Set<string>): number {
  let removed = 0;

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];

      if (
        (typeof item === "string" && selectedIds.has(item)) ||
        referencesSelectedId(item, selectedIds)
      ) {
        value.splice(index, 1);
        removed += 1;
      } else {
        removed += purgeStateReferences(item, selectedIds);
      }
    }

    return removed;
  }

  if (!isRecord(value)) {
    return removed;
  }

  for (const [key, item] of Object.entries(value)) {
    if (
      [...selectedIds].some((id) => key.includes(id)) ||
      referencesSelectedId(item, selectedIds)
    ) {
      delete value[key];
      removed += 1;
    } else {
      removed += purgeStateReferences(item, selectedIds);
    }
  }

  return removed;
}

function removeGlobalStateReferences(
  selectedIds: Set<string>,
  codexHome: string,
): {
  removed: number;
  backupPath?: string;
} {
  const statePath = path.join(codexHome, ".codex-global-state.json");

  if (!fs.existsSync(statePath)) {
    return { removed: 0 };
  }

  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  const removed = purgeStateReferences(state, selectedIds);

  if (removed === 0) {
    return { removed: 0 };
  }

  const backupPath = `${statePath}.bak-${backupStamp()}`;
  const tmpPath = `${statePath}.tmp`;
  fs.copyFileSync(statePath, backupPath);
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, statePath);
  return { removed, backupPath };
}

export function shortTime(value: string): string {
  if (!value) {
    return "unknown time";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function resolveSessionInputs(sessions: CodexSession[], inputs: string[]): CodexSession[] {
  const selected = new Map<string, CodexSession>();

  for (const input of inputs.map((value) => value.trim()).filter(Boolean)) {
    const exactId = sessions.filter((session) => session.id === input);
    const exactTitle = sessions.filter((session) => session.title === input);
    const titlePrefix = sessions.filter((session) => session.title.startsWith(input));
    const idPrefix = sessions.filter((session) => session.id.startsWith(input));
    const matches = exactId.length
      ? exactId
      : exactTitle.length
        ? exactTitle
        : titlePrefix.length
          ? titlePrefix
          : idPrefix;

    if (matches.length === 0) {
      fail(`Session not found: ${input}`);
    }

    if (matches.length > 1) {
      fail(
        `Session is ambiguous: ${input}\n\n` +
          matches.map((session) => `${session.id}\t${session.title}`).join("\n"),
      );
    }

    selected.set(matches[0].id, matches[0]);
  }

  return [...selected.values()];
}

export function deleteSessions(
  selectedSessions: CodexSession[],
  codexHome = defaultCodexHome(),
): DeleteSummary {
  const selectedIds = new Set(selectedSessions.map((session) => session.id));
  const indexPath = getIndexPath(codexHome);
  const indexRows = readIndexRows(codexHome);
  const remainingRows = indexRows.filter((row) => !selectedIds.has(row.session.id));
  const removedIndexEntries = indexRows.length - remainingRows.length;
  let backupPath: string | undefined;

  if (removedIndexEntries > 0 && fs.existsSync(indexPath)) {
    backupPath = path.join(path.dirname(indexPath), `session_index.jsonl.bak-${backupStamp()}`);
    fs.copyFileSync(indexPath, backupPath);

    const tmpPath = `${indexPath}.tmp`;
    fs.writeFileSync(
      tmpPath,
      remainingRows.map((row) => JSON.stringify(row.record)).join("\n") +
        (remainingRows.length ? "\n" : ""),
      "utf8",
    );
    fs.renameSync(tmpPath, indexPath);
  }

  const catalogResult = removeDesktopCatalogEntries(selectedIds, codexHome);
  const stateDatabaseResult = removeStateDatabaseEntries(selectedIds, codexHome);
  const globalStateResult = removeGlobalStateReferences(selectedIds, codexHome);
  const additionalBackupPaths = [
    catalogResult.backupPath,
    stateDatabaseResult.backupPath,
    globalStateResult.backupPath,
  ].filter((value): value is string => Boolean(value));

  let deletedFiles = 0;

  for (const session of selectedSessions) {
    const matchingFiles = findSessionFiles(session.id, codexHome);
    const filePaths = matchingFiles.length > 0 ? matchingFiles : session.filePaths;

    for (const filePath of filePaths) {
      try {
        fs.unlinkSync(filePath);
        deletedFiles += 1;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return {
    deletedFiles,
    removedIndexEntries,
    removedDatabaseEntries: catalogResult.removed + stateDatabaseResult.removed,
    removedStateReferences: globalStateResult.removed,
    backupPath,
    additionalBackupPaths,
  };
}
