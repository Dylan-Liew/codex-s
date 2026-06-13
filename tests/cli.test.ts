import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseNumberSelection } from "../dist/output/prompt.js";
import { sessionIdFromPath } from "../dist/services/sessions.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtCliPath = "./dist/cli/index.js";

function runCli(args: string[]) {
  return spawnSync(process.execPath, [builtCliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("cx CLI", () => {
  test("shows help output", () => {
    const result = runCli(["help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cx <command>");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("delete");
    expect(result.stdout).toContain("config");
  });

  test("prints fish completion script", () => {
    const result = runCli(["completion", "fish"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("complete -c cx -f");
    expect(result.stdout).toContain("cx __complete");
  });

  test("rejects unknown commands", () => {
    const result = runCli(["wat"]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Did you mean");
  });

  test("parses number selections", () => {
    expect(parseNumberSelection("1,3,5-7", 8)).toEqual([0, 2, 4, 5, 6]);
    expect(parseNumberSelection("", 8)).toBeNull();
    expect(parseNumberSelection("2-1", 8)).toBeNull();
    expect(parseNumberSelection("9", 8)).toBeNull();
  });

  test("extracts Codex session IDs from filenames", () => {
    expect(
      sessionIdFromPath(
        "/tmp/rollout-2026-01-01T00-00-00-000Z-550e8400-e29b-41d4-a716-446655440000.jsonl",
      ),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
