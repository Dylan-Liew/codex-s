import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL_CONFIG_FILE = "codex-s.config.json";

interface CodexConfig {
  codexHome?: string;
  home?: string;
}

export interface CodexHomeOptions {
  home?: string;
}

export interface SetCodexHomeOptions {
  local?: boolean;
}

function expandHome(value: string): string {
  return value.replace(/^~(?=$|[/\\])/, os.homedir());
}

export function normalizePath(value: string): string {
  return path.resolve(expandHome(value));
}

function readConfigHome(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const config = JSON.parse(fs.readFileSync(filePath, "utf8")) as CodexConfig;
    const configuredHome = config.codexHome || config.home;
    return configuredHome ? normalizePath(configuredHome) : undefined;
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${(error as Error).message}`);
  }
}

export function getLocalConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, LOCAL_CONFIG_FILE);
}

export function getUserConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configRoot = xdgConfigHome
    ? normalizePath(xdgConfigHome)
    : path.join(os.homedir(), ".config");
  return path.join(configRoot, "codex-s", "config.json");
}

function getAutoDetectedCodexHome(): string {
  const candidates = [path.join(os.homedir(), ".codex")];
  const windowsUsers = "/mnt/c/Users";

  if (fs.existsSync(windowsUsers)) {
    for (const entry of fs.readdirSync(windowsUsers, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(windowsUsers, entry.name, ".codex"));
      }
    }
  }

  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  return existing.length === 1 ? existing[0] : path.join(os.homedir(), ".codex");
}

export function resolveCodexHome(options: CodexHomeOptions = {}): string {
  if (options.home) {
    return normalizePath(options.home);
  }

  const envHome = process.env.CODEX_S_HOME || process.env.CODEX_HOME;

  if (envHome) {
    return normalizePath(envHome);
  }

  return (
    readConfigHome(getLocalConfigPath()) ||
    readConfigHome(getUserConfigPath()) ||
    getAutoDetectedCodexHome()
  );
}

export function writeCodexHomeConfig(codexHome: string, options: SetCodexHomeOptions = {}): string {
  const configPath = options.local ? getLocalConfigPath() : getUserConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ codexHome: normalizePath(codexHome) }, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}
