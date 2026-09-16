import process from "node:process";
import type { CommandModule } from "yargs";
import { cleanupCodexHome } from "../../services/cleanup.js";
import { defaultCodexHome } from "../../services/sessions.js";

interface CleanupArgv {
  home?: unknown;
}

export async function runCleanupCommand(options: { home?: string } = {}): Promise<void> {
  const codexHome = defaultCodexHome(options);
  const summary = cleanupCodexHome(codexHome);

  process.stdout.write(`Codex home: ${codexHome}\n\n`);
  process.stdout.write(
    `Removed ${summary.removedTempFiles.length} temp file(s).\n` +
      `Removed ${summary.removedOrphanDatabaseRows} orphaned database row(s).\n` +
      `Removed ${summary.removedOrphanHistoryEntries} orphaned history entr${summary.removedOrphanHistoryEntries === 1 ? "y" : "ies"}.\n`,
  );

  for (const backupPath of summary.backupPaths) {
    process.stdout.write(`Backup: ${backupPath}\n`);
  }

  for (const warning of summary.warnings) {
    process.stderr.write(`! Could not clean ${warning}\n`);
  }

  if (summary.warnings.length > 0) {
    process.stderr.write("Close Codex Desktop and run `cx cleanup` again to finish.\n");
  }

  if (
    summary.removedTempFiles.length === 0 &&
    summary.removedOrphanDatabaseRows === 0 &&
    summary.removedOrphanHistoryEntries === 0 &&
    summary.warnings.length === 0
  ) {
    process.stdout.write("\nNothing else to clean.\n");
  }
}

export const cleanupCommand: CommandModule = {
  command: "cleanup",
  describe: "Remove stale temp files and orphaned session data",
  handler: async (argv) => {
    const home = (argv as CleanupArgv).home;
    await runCleanupCommand({ home: typeof home === "string" ? home : undefined });
  },
};
