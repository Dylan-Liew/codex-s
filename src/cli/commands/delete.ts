import process from "node:process";
import type { CommandModule } from "yargs";
import { fail } from "../../lib/errors.js";
import { sanitizeInline } from "../../output/format.js";
import { requireDeleteConfirmation } from "../../output/prompt.js";
import { formatTable } from "../../output/table.js";
import { selectSessionIds } from "../session-picker.js";
import {
  deleteSessions,
  defaultCodexHome,
  listSessions,
  resolveSessionInputs,
  shortTime,
  type CodexSession,
} from "../../services/sessions.js";

interface DeleteArgv {
  home?: unknown;
  session?: unknown;
}

function renderDeletePlan(sessions: CodexSession[]): string {
  const rows = sessions.map((session) => [
    session.id.slice(0, 12),
    shortTime(session.updatedAt),
    session.location,
    sanitizeInline(session.title),
    session.filePaths.length,
    session.fromIndex ? "yes" : "no",
  ]);

  return formatTable(["id", "updated", "state", "title", "files", "index"], rows);
}

async function resolveDeleteSessions(inputs: string[], codexHome: string): Promise<CodexSession[]> {
  const sessions = listSessions(codexHome);

  if (sessions.length === 0) {
    fail(`No Codex sessions found under: ${codexHome}`);
  }

  if (inputs.length > 0) {
    return resolveSessionInputs(sessions, inputs);
  }

  const selectedIds = new Set(await selectSessionIds(sessions));
  return sessions.filter((session) => selectedIds.has(session.id));
}

export async function runDeleteCommand(
  inputs: string[],
  options: { home?: string } = {},
): Promise<void> {
  const codexHome = defaultCodexHome(options);
  const selectedSessions = await resolveDeleteSessions(inputs, codexHome);

  process.stdout.write(`\nDelete ${selectedSessions.length} Codex session(s):\n\n`);
  process.stdout.write(renderDeletePlan(selectedSessions));

  if (!(await requireDeleteConfirmation("\nType DELETE to confirm: "))) {
    fail("Cancelled.");
  }

  const summary = deleteSessions(selectedSessions, codexHome);

  process.stdout.write(
    `\nDeleted ${summary.deletedFiles} session file(s).\n` +
      `Removed ${summary.removedIndexEntries} index entr${summary.removedIndexEntries === 1 ? "y" : "ies"}.\n`,
  );

  if (summary.backupPath) {
    process.stdout.write(`Index backup: ${summary.backupPath}\n`);
  }
}

export const deleteCommand: CommandModule = {
  command: "delete [session..]",
  aliases: ["d", "rm"],
  describe: "Delete Codex sessions after confirmation",
  builder: (yargs) =>
    yargs.positional("session", {
      describe: "Session ID, unique prefix, or title",
      type: "string",
      array: true,
    }),
  handler: async (argv) => {
    const args = argv as DeleteArgv;
    const sessions = Array.isArray(args.session) ? args.session.map(String) : [];
    await runDeleteCommand(sessions, {
      home: typeof args.home === "string" ? args.home : undefined,
    });
  },
};
