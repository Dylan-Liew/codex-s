import process from "node:process";
import type { CommandModule } from "yargs";
import { sanitizeInline } from "../../output/format.js";
import { formatTable } from "../../output/table.js";
import {
  defaultCodexHome,
  listSessions,
  shortTime,
  type CodexSession,
} from "../../services/sessions.js";

interface HomeArgv {
  home?: unknown;
}

function groupSessionsByHost(sessions: CodexSession[]): Map<string, CodexSession[]> {
  const groups = new Map<string, CodexSession[]>();

  for (const session of sessions) {
    const label = session.hostLabel || "local";
    groups.set(label, [...(groups.get(label) ?? []), session]);
  }

  return groups;
}

export function runListCommand(options: { home?: string } = {}): void {
  const codexHome = defaultCodexHome(options);
  const sessions = listSessions(codexHome);

  if (sessions.length === 0) {
    process.stdout.write(`No Codex sessions found under: ${codexHome}\n`);
    return;
  }

  process.stdout.write(`Codex home: ${codexHome}\n\n`);

  const groups = groupSessionsByHost(sessions);

  for (const [hostLabel, hostSessions] of groups) {
    process.stdout.write(`[${hostLabel}]\n`);
    process.stdout.write(
      formatTable(
        ["id", "updated", "state", "title"],
        hostSessions.map((session) => [
          session.id.slice(0, 12),
          shortTime(session.updatedAt),
          session.location,
          sanitizeInline(session.title),
        ]),
      ),
    );
    process.stdout.write("\n");
  }
}

export const listCommand: CommandModule = {
  command: "list",
  aliases: ["ls"],
  describe: "List local Codex sessions",
  handler: (argv) => {
    const home = (argv as HomeArgv).home;
    runListCommand({ home: typeof home === "string" ? home : undefined });
  },
};
