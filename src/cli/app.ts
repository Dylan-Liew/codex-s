import process from "node:process";
import yargs, { type Argv, type CommandModule } from "yargs";
import { hideBin } from "yargs/helpers";
import { commandModules, internalCommandModules } from "./commands/index.js";
import { CliError } from "../lib/errors.js";

interface BuildCliOptions {
  includeInternalCommands?: boolean;
}

function registerCommands(cli: Argv, modules: ReadonlyArray<CommandModule>): Argv {
  return modules.reduce(
    (configuredCli, commandModule) => configuredCli.command(commandModule),
    cli,
  );
}

function sanitizeHelpText(help: string): string {
  return help.replace(/\[aliases:/g, "[alias:");
}

export async function showHelpForArgs(argv: string[]): Promise<void> {
  const output = await buildCli(argv).getHelp();
  const sanitized = sanitizeHelpText(output);
  process.stdout.write(sanitized.endsWith("\n") ? sanitized : `${sanitized}\n`);
}

function createCli(argv: string[], options: BuildCliOptions = {}): Argv {
  const { includeInternalCommands = false } = options;
  const examples = [
    ["$0 list", "List local Codex sessions"] as const,
    ["$0 --home /mnt/c/Users/me/.codex list", "List sessions from an explicit Codex home"] as const,
    ["$0 config set-home /mnt/c/Users/me/.codex --local", "Persist a local Codex home"] as const,
    ["$0 delete", "Interactively select sessions to delete"] as const,
    ["$0 delete 550e8400", "Delete by session ID prefix"] as const,
  ];

  let cli: Argv = yargs(argv)
    .scriptName("cx")
    .parserConfiguration({
      "parse-positional-numbers": false,
      "sort-commands": false,
    })
    .usage("Usage:\n  $0 <command>")
    .exitProcess(false)
    .help(false)
    .version(false)
    .option("home", {
      describe: "Codex home directory",
      type: "string",
      global: true,
    })
    .recommendCommands()
    .strictCommands()
    .demandCommand(1, "Specify a command.")
    .fail((message, error) => {
      if (error) {
        throw error;
      }

      throw new CliError(message || "Command failed");
    })
    .wrap(Math.min(120, process.stdout.columns || 120));

  for (const [command, description] of examples) {
    cli = cli.example(command, description);
  }

  cli = registerCommands(cli, commandModules);

  if (includeInternalCommands) {
    cli = registerCommands(cli, internalCommandModules);
  }

  return cli;
}

export function buildCli(argv = hideBin(process.argv), options: BuildCliOptions = {}): Argv {
  return createCli(argv, { includeInternalCommands: true, ...options });
}

export async function getCompletionCandidates(args: string[]): Promise<string[]> {
  const cli = createCli([], { includeInternalCommands: false }).completion();
  const suggestions = await cli.getCompletion(args);
  return [...new Set(suggestions.map(String).filter(Boolean))];
}

export async function main(argv = hideBin(process.argv)): Promise<void> {
  if (argv.length === 0) {
    await showHelpForArgs([]);
    return;
  }

  await buildCli(argv).parseAsync();
}
