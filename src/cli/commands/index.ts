import type { CommandModule } from "yargs";
import { cleanupCommand } from "./cleanup.js";
import { completeCommand, completionCommand } from "./completion.js";
import { configCommand } from "./config.js";
import { deleteCommand } from "./delete.js";
import { helpCommand } from "./help.js";
import { listCommand } from "./list.js";

export const commandModules = [
  listCommand,
  deleteCommand,
  cleanupCommand,
  configCommand,
  helpCommand,
  completionCommand,
] as const satisfies ReadonlyArray<CommandModule>;

export const internalCommandModules = [
  completeCommand,
] as const satisfies ReadonlyArray<CommandModule>;
