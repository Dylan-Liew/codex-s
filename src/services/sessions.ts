import fs from "node:fs";
import path from "node:path";
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
  indexRecord?: Record<string, unknown>;
}

interface IndexRow {
  session: CodexSession;
  record: Record<string, unknown>;
}

export interface DeleteSummary {
  deletedFiles: number;
  removedIndexEntries: number;
  backupPath?: string;
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

export function listSessions(codexHome = defaultCodexHome()): CodexSession[] {
  const indexRows = readIndexRows(codexHome);
  const fileRows = scanSessionFiles(codexHome);
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
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    backupPath = path.join(path.dirname(indexPath), `session_index.jsonl.bak-${stamp}`);
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

  return { deletedFiles, removedIndexEntries, backupPath };
}
