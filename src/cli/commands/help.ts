import type { CommandModule } from "yargs";
import { showHelpForArgs } from "../app.js";

export const helpCommand: CommandModule = {
  command: "help [command]",
  describe: "Show CLI help",
  builder: (yargs) =>
    yargs.positional("command", {
      describe: "Command to show help for",
      type: "string",
    }),
  handler: async (argv) => {
    const command = (argv as { command?: unknown }).command;
    await showHelpForArgs(typeof command === "string" ? [command, "--help"] : []);
  },
};
