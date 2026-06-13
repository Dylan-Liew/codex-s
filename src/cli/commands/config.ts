import process from "node:process";
import type { CommandModule } from "yargs";
import { defaultCodexHome } from "../../services/sessions.js";
import { writeCodexHomeConfig } from "../../services/config.js";

export const configCommand: CommandModule = {
  command: "config <action> [value]",
  describe: "Read or write codex-s configuration",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "Config action",
        choices: ["get-home", "set-home"] as const,
      })
      .positional("value", {
        describe: "Value for set-home",
        type: "string",
      })
      .option("local", {
        describe: "Write codex-s.config.json in the current directory",
        type: "boolean",
        default: false,
      }),
  handler: (argv) => {
    const args = argv as { action?: unknown; value?: unknown; local?: unknown };
    const action = String(args.action ?? "");

    if (action === "get-home") {
      process.stdout.write(`${defaultCodexHome()}\n`);
      return;
    }

    const value = typeof args.value === "string" ? args.value : "";

    if (!value) {
      throw new Error("Specify a Codex home path.");
    }

    const configPath = writeCodexHomeConfig(value, { local: args.local === true });
    process.stdout.write(`Wrote Codex home to ${configPath}\n`);
  },
};
