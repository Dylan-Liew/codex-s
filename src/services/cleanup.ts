import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  backupDatabase,
  getDesktopCatalogPath,
  getThreadDatabasePaths,
  readFromSqliteSnapshot,
  tableExists,
  threadKeyedTables,
  type ThreadKeyedTable,
} from "./sessions.js";

const TEMP_FILE_PATTERNS = [/^\.+codex-global-state\.json\.tmp/, /^session_index\.jsonl\.tmp/];
const VALID_THREADS_TABLE = "_codex_s_valid_threads";

export interface CleanupSummary {
  removedTempFiles: string[];
  removedOrphanDatabaseRows: number;
  removedOrphanHistoryEntries: number;
  backupPaths: string[];
  warnings: string[];
}

function removeTempFiles(codexHome: string): string[] {
  if (!fs.existsSync(codexHome)) {
    return [];
  }

  const removed: string[] = [];

  for (const entry of fs.readdirSync(codexHome, { withFileTypes: true })) {
    if (!entry.isFile() || !TEMP_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      continue;
    }

    const filePath = path.join(codexHome, entry.name);
    fs.unlinkSync(filePath);
    removed.push(filePath);
  }

  return removed.sort();
}

function collectValidThreadIds(codexHome: string): Set<string> {
  const valid = new Set<string>();
  const sources: Array<{ databasePath: string; table: string; sql: string }> = [
    {
      databasePath: path.join(codexHome, "state_5.sqlite"),
      table: "threads",
      sql: "SELECT id FROM threads",
    },
    {
      databasePath: getDesktopCatalogPath(codexHome),
      table: "local_thread_catalog",
      sql: "SELECT thread_id AS id FROM local_thread_catalog",
    },
  ];

  for (const source of sources) {
    if (!fs.existsSync(source.databasePath)) {
      continue;
    }

    try {
      const ids = readFromSqliteSnapshot(source.databasePath, (database) => {
        if (!tableExists(database, source.table)) {
          return [];
        }

        return (database.prepare(source.sql).all() as Array<{ id: string }>)
          .map((row) => row.id)
          .filter(Boolean);
      });

      for (const id of ids) {
        valid.add(id);
      }
    } catch {
      // Unreadable sources must not turn every row into an orphan.
    }
  }

  return valid;
}

function orphanTableSql(table: ThreadKeyedTable): string {
  if (table.kind === "spawn") {
    return (
      `DELETE FROM "${table.name}" ` +
      `WHERE parent_thread_id NOT IN (SELECT id FROM ${VALID_THREADS_TABLE}) ` +
      `OR child_thread_id NOT IN (SELECT id FROM ${VALID_THREADS_TABLE})`
    );
  }

  return (
    `DELETE FROM "${table.name}" ` +
    `WHERE thread_id NOT IN (SELECT id FROM ${VALID_THREADS_TABLE})`
  );
}

function countOrphanRows(database: DatabaseSync, tables: ThreadKeyedTable[]): number {
  let count = 0;

  for (const table of tables) {
    const selectSql = orphanTableSql(table).replace(
      /^DELETE FROM ("[^"]+")/,
      "SELECT COUNT(*) AS count FROM $1",
    );
    const row = database.prepare(selectSql).get() as { count: number };
    count += Number(row.count);
  }

  return count;
}

function removeOrphanDatabaseRows(
  codexHome: string,
  validIds: Set<string>,
): {
  removed: number;
  backupPaths: string[];
  warnings: string[];
} {
  let removed = 0;
  const backupPaths: string[] = [];
  const warnings: string[] = [];

  for (const databasePath of getThreadDatabasePaths(codexHome)) {
    if (!fs.existsSync(databasePath)) {
      continue;
    }

    let database: DatabaseSync;

    try {
      database = new DatabaseSync(databasePath);
    } catch (error) {
      warnings.push(`${databasePath}: ${(error as Error).message}`);
      continue;
    }

    try {
      const tables = threadKeyedTables(database).filter((table) => table.kind !== "id");

      if (tables.length === 0) {
        continue;
      }

      database.exec(`CREATE TEMP TABLE ${VALID_THREADS_TABLE} (id TEXT PRIMARY KEY)`);
      const insert = database.prepare(
        `INSERT OR IGNORE INTO ${VALID_THREADS_TABLE} (id) VALUES (?)`,
      );

      for (const id of validIds) {
        insert.run(id);
      }

      try {
        if (countOrphanRows(database, tables) === 0) {
          continue;
        }

        backupPaths.push(backupDatabase(database, databasePath));
        database.exec("BEGIN IMMEDIATE");

        try {
          for (const table of tables) {
            removed += Number(database.prepare(orphanTableSql(table)).run().changes);
          }

          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        database.exec(`DROP TABLE IF EXISTS ${VALID_THREADS_TABLE}`);
      }
    } catch (error) {
      warnings.push(`${databasePath}: ${(error as Error).message}`);
    } finally {
      database.close();
    }
  }

  return { removed, backupPaths, warnings };
}

function removeOrphanHistoryEntries(
  codexHome: string,
  validIds: Set<string>,
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

    let sessionId: string | undefined;

    try {
      const record = JSON.parse(line) as unknown;

      if (typeof record === "object" && record !== null && "session_id" in record) {
        sessionId = (record as { session_id?: unknown }).session_id as string | undefined;
      }
    } catch {
      sessionId = undefined;
    }

    if (sessionId === undefined || validIds.has(sessionId)) {
      kept.push(line);
    } else {
      removed += 1;
    }
  }

  if (removed === 0) {
    return { removed: 0 };
  }

  const backupPath = `${historyPath}.bak-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  const tmpPath = `${historyPath}.tmp`;
  fs.copyFileSync(historyPath, backupPath);
  fs.writeFileSync(tmpPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  fs.renameSync(tmpPath, historyPath);
  return { removed, backupPath };
}

export function cleanupCodexHome(codexHome: string): CleanupSummary {
  const removedTempFiles = removeTempFiles(codexHome);
  const validIds = collectValidThreadIds(codexHome);
  let removedOrphanDatabaseRows = 0;
  let removedOrphanHistoryEntries = 0;
  const backupPaths: string[] = [];
  const warnings: string[] = [];

  if (validIds.size > 0) {
    const databaseResult = removeOrphanDatabaseRows(codexHome, validIds);
    removedOrphanDatabaseRows = databaseResult.removed;
    backupPaths.push(...databaseResult.backupPaths);
    warnings.push(...databaseResult.warnings);

    const historyResult = removeOrphanHistoryEntries(codexHome, validIds);
    removedOrphanHistoryEntries = historyResult.removed;

    if (historyResult.backupPath) {
      backupPaths.push(historyResult.backupPath);
    }
  }

  return {
    removedTempFiles,
    removedOrphanDatabaseRows,
    removedOrphanHistoryEntries,
    backupPaths,
    warnings,
  };
}
