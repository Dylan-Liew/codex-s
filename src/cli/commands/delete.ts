import process from "node:process";
import type { CommandModule } from "yargs";
import { fail } from "../../lib/errors.js";
import { sanitizeInline } from "../../output/format.js";
import { confirm } from "../../output/prompt.js";
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
  all?: unknown;
  host?: unknown;
}

function renderDeletePlan(sessions: CodexSession[]): string {
  const rows = sessions.map((session) => [
    session.id.slice(0, 12),
    shortTime(session.updatedAt),
    session.location,
    session.hostLabel,
    sanitizeInline(session.title),
    session.filePaths.length,
    session.fromCatalog ? "desktop" : session.fromIndex ? "index" : "file",
  ]);

  return formatTable(["id", "updated", "state", "host", "title", "files", "source"], rows);
}

async function resolveDeleteSessions(
  inputs: string[],
  codexHome: string,
  selection: { all?: boolean; host?: string } = {},
): Promise<CodexSession[]> {
  const sessions = listSessions(codexHome);

  if (sessions.length === 0) {
    fail(`No Codex sessions found under: ${codexHome}`);
  }

  if (selection.all) {
    return sessions;
  }

  if (selection.host) {
    const hostLabel = selection.host.toLowerCase();
    const matches = sessions.filter((session) => session.hostLabel.toLowerCase() === hostLabel);

    if (matches.length === 0) {
      const knownLabels = [...new Set(sessions.map((session) => session.hostLabel))].sort();
      fail(
        `No sessions found for host: ${selection.host}\n\n` +
          `Known hosts:\n${knownLabels.map((label) => `  ${label}`).join("\n")}`,
      );
    }

    return matches;
  }

  if (inputs.length > 0) {
    return resolveSessionInputs(sessions, inputs);
  }

  const selectedIds = new Set(await selectSessionIds(sessions));
  return sessions.filter((session) => selectedIds.has(session.id));
}

export async function runDeleteCommand(
  inputs: string[],
  options: { home?: string; all?: boolean; host?: string } = {},
): Promise<void> {
  if (options.all && (options.host || inputs.length > 0)) {
    fail("Use either --all or an explicit selection, not both.");
  }

  if (options.host && inputs.length > 0) {
    fail("Use either --host or explicit sessions, not both.");
  }

  const codexHome = defaultCodexHome(options);
  const selectedSessions = await resolveDeleteSessions(inputs, codexHome, {
    all: options.all,
    host: options.host,
  });

  const scope = options.all ? "all hosts" : options.host ? `host "${options.host}"` : "selection";
  process.stdout.write(`\nDelete ${selectedSessions.length} Codex session(s) (${scope}):\n\n`);
  process.stdout.write(renderDeletePlan(selectedSessions));

  const prompt = options.all
    ? "\nDelete ALL listed sessions? [y/N] "
    : options.host
      ? `\nDelete all sessions on host "${options.host}"? [y/N] `
      : "\nDelete selected sessions? [y/N] ";

  if (!(await confirm(prompt))) {
    fail("Cancelled.");
  }

  const summary = deleteSessions(selectedSessions, codexHome);

  process.stdout.write(
    `\nDeleted ${summary.deletedFiles} session file(s).\n` +
      `Removed ${summary.removedIndexEntries} legacy index entr${summary.removedIndexEntries === 1 ? "y" : "ies"}.\n` +
      `Removed ${summary.removedDatabaseEntries} database entr${summary.removedDatabaseEntries === 1 ? "y" : "ies"}.\n` +
      `Removed ${summary.removedStateReferences} Desktop state reference${summary.removedStateReferences === 1 ? "" : "s"}.\n` +
      `Removed ${summary.removedHistoryEntries} history entr${summary.removedHistoryEntries === 1 ? "y" : "ies"}.\n`,
  );

  if (summary.backupPath) {
    process.stdout.write(`Index backup: ${summary.backupPath}\n`);
  }

  for (const backupPath of summary.additionalBackupPaths) {
    process.stdout.write(`State backup: ${backupPath}\n`);
  }
}

export const deleteCommand: CommandModule = {
  command: "delete [session..]",
  aliases: ["d", "rm"],
  describe: "Delete Codex sessions after confirmation",
  builder: (yargs) =>
    yargs
      .positional("session", {
        describe: "Session ID, unique prefix, or title",
        type: "string",
        array: true,
      })
      .option("all", {
        describe: "Select every session across all hosts",
        type: "boolean",
        default: false,
      })
      .option("host", {
        describe: "Select all sessions on a host (chatgpt, local, or SSH label)",
        type: "string",
      }),
  handler: async (argv) => {
    const args = argv as DeleteArgv;
    const sessions = Array.isArray(args.session) ? args.session.map(String) : [];
    await runDeleteCommand(sessions, {
      home: typeof args.home === "string" ? args.home : undefined,
      all: args.all === true,
      host: typeof args.host === "string" ? args.host : undefined,
    });
  },
};
