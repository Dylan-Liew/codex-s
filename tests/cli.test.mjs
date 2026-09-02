import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseNumberSelection } from "../dist/output/prompt.js";
import { deleteSessions, listSessions, sessionIdFromPath } from "../dist/services/sessions.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtCliPath = "./dist/cli/index.js";

function runCli(args) {
  return spawnSync(process.execPath, [builtCliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("cx CLI", () => {
  test("shows help output", () => {
    const result = runCli(["help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /cx <command>/);
    assert.match(result.stdout, /list/);
    assert.match(result.stdout, /delete/);
    assert.match(result.stdout, /config/);
  });

  test("prints fish completion script", () => {
    const result = runCli(["completion", "fish"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /complete -c cx -f/);
    assert.match(result.stdout, /cx __complete/);
  });

  test("rejects unknown commands", () => {
    const result = runCli(["wat"]);
    const output = `${result.stdout}${result.stderr}`;

    assert.notEqual(result.status, 0);
    assert.match(output, /Did you mean/);
  });

  test("parses number selections", () => {
    assert.deepEqual(parseNumberSelection("1,3,5-7", 8), [0, 2, 4, 5, 6]);
    assert.equal(parseNumberSelection("", 8), null);
    assert.equal(parseNumberSelection("2-1", 8), null);
    assert.equal(parseNumberSelection("9", 8), null);
  });

  test("extracts Codex session IDs from filenames", () => {
    assert.equal(
      sessionIdFromPath(
        "/tmp/rollout-2026-01-01T00-00-00-000Z-550e8400-e29b-41d4-a716-446655440000.jsonl",
      ),
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("lists the Desktop catalog and removes all persisted session state", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-s-test-"));
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const legacyOnlyId = "660e8400-e29b-41d4-a716-446655440000";
    const fileOnlyId = "770e8400-e29b-41d4-a716-446655440000";
    const sessionDir = path.join(codexHome, "sessions", "2026", "01", "01");
    const catalogPath = path.join(codexHome, "sqlite", "codex-dev.db");
    const statePath = path.join(codexHome, "state_5.sqlite");
    const rolloutPath = path.join(sessionDir, `rollout-${sessionId}.jsonl`);
    const fileOnlyPath = path.join(sessionDir, `rollout-${fileOnlyId}.jsonl`);

    try {
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        rolloutPath,
        `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`,
      );
      fs.writeFileSync(
        fileOnlyPath,
        `${JSON.stringify({ type: "session_meta", payload: { id: fileOnlyId } })}\n`,
      );
      fs.writeFileSync(
        path.join(codexHome, "session_index.jsonl"),
        `${JSON.stringify({ id: sessionId, thread_name: "old title" })}\n` +
          `${JSON.stringify({ id: legacyOnlyId, thread_name: "not on Desktop" })}\n`,
      );
      fs.writeFileSync(
        path.join(codexHome, ".codex-global-state.json"),
        `${JSON.stringify({
          "projectless-thread-ids": [sessionId],
          "thread-project-assignments": { [sessionId]: { cwd: "/tmp" } },
          "electron-persisted-atom-state": {
            [`thread-client-id-v1:local%3A${sessionId}`]: "cached",
          },
        })}\n`,
      );

      const catalog = new DatabaseSync(catalogPath);
      catalog.exec(`
        CREATE TABLE local_thread_catalog (
          host_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          display_title TEXT NOT NULL,
          source_created_at REAL NOT NULL,
          source_updated_at REAL NOT NULL,
          source_recency_at REAL NOT NULL,
          missing_candidate INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (host_id, thread_id)
        );
        CREATE TABLE local_thread_catalog_metadata (
          id INTEGER PRIMARY KEY,
          catalog_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE thread_timeline_ledger (
          host_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          sequence INTEGER NOT NULL
        );
        INSERT INTO local_thread_catalog VALUES
          ('chatgpt:account:user', '${sessionId}', 'Desktop title', 10, 20, 30, 0);
        INSERT INTO local_thread_catalog VALUES
          ('remote', '${sessionId}', 'Remote copy', 40, 50, 60, 0);
        INSERT INTO local_thread_catalog_metadata VALUES (1, 1);
        INSERT INTO thread_timeline_ledger VALUES ('chatgpt:account:user', '${sessionId}', 1);
        INSERT INTO thread_timeline_ledger VALUES ('remote', '${sessionId}', 2);
      `);
      catalog.close();

      const state = new DatabaseSync(statePath);
      state.exec(`
        CREATE TABLE threads (id TEXT PRIMARY KEY);
        CREATE TABLE thread_dynamic_tools (thread_id TEXT);
        CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
        INSERT INTO threads VALUES ('${sessionId}');
        INSERT INTO thread_dynamic_tools VALUES ('${sessionId}');
        INSERT INTO thread_spawn_edges VALUES ('${sessionId}', 'child');
      `);
      state.close();

      const sessions = listSessions(codexHome);
      assert.deepEqual(
        sessions.map((session) => session.id).sort(),
        [fileOnlyId, legacyOnlyId, sessionId].sort(),
      );
      const catalogSession = sessions.find((session) => session.id === sessionId);
      assert.ok(catalogSession);
      assert.equal(catalogSession?.title, "Remote copy");
      assert.equal(catalogSession?.fromCatalog, true);

      const summary = deleteSessions([catalogSession], codexHome);
      assert.equal(summary.deletedFiles, 1);
      assert.equal(summary.removedIndexEntries, 1);
      assert.equal(summary.removedDatabaseEntries, 3);
      assert.equal(summary.removedStateReferences, 3);
      assert.deepEqual(
        listSessions(codexHome)
          .map((session) => session.id)
          .sort(),
        [legacyOnlyId, fileOnlyId].sort(),
      );
      assert.equal(fs.existsSync(rolloutPath), false);
      assert.equal(fs.existsSync(fileOnlyPath), true);

      const remainingIndex = fs.readFileSync(path.join(codexHome, "session_index.jsonl"), "utf8");
      assert.match(remainingIndex, new RegExp(legacyOnlyId));
      assert.doesNotMatch(remainingIndex, new RegExp(sessionId));
      assert.doesNotMatch(
        fs.readFileSync(path.join(codexHome, ".codex-global-state.json"), "utf8"),
        new RegExp(sessionId),
      );

      const remainingCatalog = new DatabaseSync(catalogPath, { readOnly: true });
      const remainingRows = remainingCatalog
        .prepare("SELECT COUNT(*) AS count FROM local_thread_catalog WHERE thread_id = ?")
        .get(sessionId);
      const remainingLedgerRows = remainingCatalog
        .prepare("SELECT COUNT(*) AS count FROM thread_timeline_ledger WHERE thread_id = ?")
        .get(sessionId);
      assert.equal(remainingRows.count, 0);
      assert.equal(remainingLedgerRows.count, 0);
      remainingCatalog.close();
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
