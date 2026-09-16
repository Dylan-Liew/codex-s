import fs from "node:fs";
import { tmpdir } from "node:os";
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
  hostLabel: string;
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
  removedHistoryEntries: number;
  backupPath?: string;
  additionalBackupPaths: string[];
}

export type ThreadKeyedTable = {
  name: string;
  kind: "id" | "thread_id" | "spawn";
};

interface CatalogRecord {
  id: string;
  title: string;
  updatedAt: string;
  hostLabel: string;
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

const THREAD_DATABASE_FILES = [
  "state_5.sqlite",
  "goals_1.sqlite",
  "memories_1.sqlite",
  "queue_1.sqlite",
];

export function getThreadDatabasePaths(codexHome = defaultCodexHome()): string[] {
  return THREAD_DATABASE_FILES.map((file) => path.join(codexHome, file));
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
        hostLabel: "local",
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
      hostLabel: "local",
      filePaths: [filePath],
      fromIndex: false,
      fromCatalog: false,
    });
  }

  return sessions;
}

export function hostLabelFromId(hostId: string): string {
  if (hostId === "local") {
    return "local";
  }

  if (hostId.startsWith("remote-ssh-discovered:")) {
    return hostId.slice("remote-ssh-discovered:".length) || hostId;
  }

  if (hostId.startsWith("chatgpt:")) {
    return "chatgpt";
  }

  return hostId;
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

export function tableExists(database: DatabaseSync, tableName: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

export function threadKeyedTables(database: DatabaseSync): ThreadKeyedTable[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const keyed: ThreadKeyedTable[] = [];

  for (const { name } of tables) {
    if (name.startsWith("sqlite_") || name.startsWith("_sqlx_")) {
      continue;
    }

    const columns = (
      database.prepare(`PRAGMA table_info('${name.replace(/'/g, "''")}')`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);

    if (columns.includes("thread_id")) {
      keyed.push({ name, kind: "thread_id" });
    } else if (columns.includes("parent_thread_id") || columns.includes("child_thread_id")) {
      keyed.push({ name, kind: "spawn" });
    } else if (name === "threads" && columns.includes("id")) {
      keyed.push({ name, kind: "id" });
    }
  }

  return keyed;
}

function threadRowWhere(table: ThreadKeyedTable, idCount: number): string {
  const placeholders = Array.from({ length: idCount }, () => "?").join(", ");

  if (table.kind === "id") {
    return `id IN (${placeholders})`;
  }

  if (table.kind === "spawn") {
    return `parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`;
  }

  return `thread_id IN (${placeholders})`;
}

function threadRowParams(table: ThreadKeyedTable, ids: string[]): string[] {
  return table.kind === "spawn" ? [...ids, ...ids] : ids;
}

function countThreadRows(
  database: DatabaseSync,
  tables: ThreadKeyedTable[],
  ids: string[],
): number {
  let count = 0;

  for (const table of tables) {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count FROM "${table.name}" WHERE ${threadRowWhere(table, ids.length)}`,
      )
      .get(...threadRowParams(table, ids)) as { count: number };
    count += Number(row.count);
  }

  return count;
}

function deleteThreadRows(
  database: DatabaseSync,
  tables: ThreadKeyedTable[],
  ids: string[],
): number {
  let removed = 0;

  for (const table of tables) {
    const result = database
      .prepare(`DELETE FROM "${table.name}" WHERE ${threadRowWhere(table, ids.length)}`)
      .run(...threadRowParams(table, ids));
    removed += Number(result.changes);
  }

  return removed;
}

export function readFromSqliteSnapshot<T>(
  databasePath: string,
  read: (database: DatabaseSync) => T,
): T {
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      return read(database);
    } finally {
      database.close();
    }
  } catch (error) {
    // WAL sidecars on network/DrvFS mounts can make direct reads fail with
    // disk I/O errors; retry against a point-in-time copy in a temp directory.
    if (!isRecord(error) || error.code !== "ERR_SQLITE_ERROR") {
      throw error;
    }
  }

  const snapshotDir = fs.mkdtempSync(path.join(tmpdir(), "codex-s-snapshot-"));

  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const sidecarPath = `${databasePath}${suffix}`;

      if (fs.existsSync(sidecarPath)) {
        fs.copyFileSync(sidecarPath, path.join(snapshotDir, path.basename(sidecarPath)));
      }
    }

    const database = new DatabaseSync(path.join(snapshotDir, path.basename(databasePath)), {
      readOnly: true,
    });

    try {
      return read(database);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function catalogSessions(codexHome: string, fileRows: CodexSession[]): CodexSession[] | undefined {
  const databasePath = getDesktopCatalogPath(codexHome);

  if (!fs.existsSync(databasePath)) {
    return undefined;
  }

  return readFromSqliteSnapshot(databasePath, (database) => {
    if (!tableExists(database, "local_thread_catalog")) {
      return undefined;
    }

    const records = database
      .prepare(
        `SELECT thread_id AS id,
                host_id AS host_id,
                display_title AS title,
                MAX(source_recency_at, source_updated_at, source_created_at) AS updated_at
           FROM (
             SELECT *,
                    ROW_NUMBER() OVER (
                      PARTITION BY thread_id
                      ORDER BY source_recency_at DESC,
                               source_updated_at DESC,
                               source_created_at DESC,
                               host_id DESC
                    ) AS row_number
               FROM local_thread_catalog
              WHERE missing_candidate = 0
           )
          WHERE row_number = 1
          ORDER BY updated_at DESC, id DESC`,
      )
      .all() as unknown as Array<{
      id: string;
      host_id: string;
      title: string;
      updated_at: number;
    }>;
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
        hostLabel: hostLabelFromId(record.host_id),
      });
    }

    return [...latestRecords.values()].map((record) => {
      const fileSession = filesById.get(record.id);
      return {
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        location: "active",
        hostLabel: record.hostLabel,
        filePaths: fileSession?.filePaths ?? [],
        fromIndex: false,
        fromCatalog: true,
      };
    });
  });
}

export function listSessions(codexHome = defaultCodexHome()): CodexSession[] {
  const fileRows = scanSessionFiles(codexHome);
  const desktopSessions = catalogSessions(codexHome, fileRows);
  const indexRows = latestIndexRowsById(readIndexRows(codexHome));
  const filesById = new Map(fileRows.map((session) => [session.id, session]));
  const seenIds = new Set<string>();
  const sessions: CodexSession[] = [];

  // The Desktop catalog backs the visible thread list, but recent Codex builds can
  // also keep local-only sessions in state/index/files before the catalog catches up.
  if (desktopSessions !== undefined) {
    for (const session of desktopSessions) {
      seenIds.add(session.id);
      sessions.push(session);
    }
  }

  for (const row of indexRows) {
    if (seenIds.has(row.session.id)) {
      continue;
    }

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

export function backupDatabase(database: DatabaseSync, databasePath: string): string {
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
              WHERE thread_id IN (${placeholders})`,
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
              WHERE thread_id IN (${placeholders})`,
          )
          .run(...ids);
      }

      database
        .prepare(
          `DELETE FROM local_thread_catalog
            WHERE thread_id IN (${placeholders})`,
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

export function removeThreadDatabaseEntries(
  selectedIds: Set<string>,
  codexHome: string,
): {
  removed: number;
  backupPaths: string[];
} {
  const ids = [...selectedIds];
  let removed = 0;
  const backupPaths: string[] = [];

  for (const databasePath of getThreadDatabasePaths(codexHome)) {
    if (!fs.existsSync(databasePath)) {
      continue;
    }

    const database = new DatabaseSync(databasePath);

    try {
      const tables = threadKeyedTables(database);

      if (tables.length === 0 || countThreadRows(database, tables, ids) === 0) {
        continue;
      }

      backupPaths.push(backupDatabase(database, databasePath));
      database.exec("BEGIN IMMEDIATE");

      try {
        removed += deleteThreadRows(database, tables, ids);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }

  return { removed, backupPaths };
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

export function removeHistoryEntries(
  selectedIds: Set<string>,
  codexHome: string,
): {
  removed: number;
  backupPath?: string;
} {
  const historyPath = path.join(codexHome, "history.jsonl");

  if (!fs.existsSync(historyPath)) {
    return { removed: 0 };
  }

  const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/);
  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line) as unknown;

      if (
        isRecord(record) &&
        typeof record.session_id === "string" &&
        selectedIds.has(record.session_id)
      ) {
        removed += 1;
        continue;
      }
    } catch {
      // Keep malformed lines untouched.
    }

    kept.push(line);
  }

  if (removed === 0) {
    return { removed: 0 };
  }

  const backupPath = `${historyPath}.bak-${backupStamp()}`;
  const tmpPath = `${historyPath}.tmp`;
  fs.copyFileSync(historyPath, backupPath);
  fs.writeFileSync(tmpPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  fs.renameSync(tmpPath, historyPath);
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
  const threadDatabaseResult = removeThreadDatabaseEntries(selectedIds, codexHome);
  const globalStateResult = removeGlobalStateReferences(selectedIds, codexHome);
  const historyResult = removeHistoryEntries(selectedIds, codexHome);
  const additionalBackupPaths = [
    catalogResult.backupPath,
    ...threadDatabaseResult.backupPaths,
    globalStateResult.backupPath,
    historyResult.backupPath,
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
    removedDatabaseEntries: catalogResult.removed + threadDatabaseResult.removed,
    removedStateReferences: globalStateResult.removed,
    removedHistoryEntries: historyResult.removed,
    backupPath,
    additionalBackupPaths,
  };
}
