import { readFileSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeConfig {
  server: { host: string; port: number; shutdownTimeoutMs: number };
  storage: { dbPath: string; tempDir: string };
  logging: { level: LogLevel };
  github: { pollIntervalMs: number };
  openRouter: { model: string; reviewModel: string; securityModel: string };
}

const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const USER_WHITELIST_ENV = "STRAPPY_USER_WHITELIST";
const COMMITTER_NAME_ENV = "STRAPPY_GIT_NAME";
const COMMITTER_EMAIL_ENV = "STRAPPY_GIT_EMAIL";
const capturedGitHubToken = captureEnv(GITHUB_TOKEN_ENV);
const capturedUserWhitelist = captureEnv(USER_WHITELIST_ENV);
const capturedCommitterName = captureEnv(COMMITTER_NAME_ENV);
const capturedCommitterEmail = captureEnv(COMMITTER_EMAIL_ENV);

function captureEnv(name: string): string | undefined {
  const value = process.env[name];
  delete process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const root = objectAt(value, "config");
  exactKeys(root, ["server", "storage", "logging", "github", "openRouter"], "config");
  const server = objectAt(root.server, "config.server");
  const storage = objectAt(root.storage, "config.storage");
  const logging = objectAt(root.logging, "config.logging");
  const github = objectAt(root.github, "config.github");
  const openRouter = objectAt(root.openRouter, "config.openRouter");
  exactKeys(server, ["host", "port", "shutdownTimeoutMs"], "config.server");
  exactKeys(storage, ["dbPath", "tempDir"], "config.storage");
  exactKeys(logging, ["level"], "config.logging");
  exactKeys(github, ["pollIntervalMs"], "config.github");
  exactKeys(openRouter, ["model", "reviewModel", "securityModel"], "config.openRouter");
  return {
    server: {
      host: stringAt(server.host, "config.server.host"),
      port: positiveIntAt(server.port, "config.server.port"),
      shutdownTimeoutMs: positiveIntAt(server.shutdownTimeoutMs, "config.server.shutdownTimeoutMs"),
    },
    storage: {
      dbPath: stringAt(storage.dbPath, "config.storage.dbPath"),
      tempDir: stringAt(storage.tempDir, "config.storage.tempDir"),
    },
    logging: { level: logLevelAt(logging.level) },
    github: {
      pollIntervalMs: positiveIntAt(github.pollIntervalMs, "config.github.pollIntervalMs"),
    },
    openRouter: {
      model: stringAt(openRouter.model, "config.openRouter.model"),
      reviewModel: stringAt(openRouter.reviewModel, "config.openRouter.reviewModel"),
      securityModel: stringAt(openRouter.securityModel, "config.openRouter.securityModel"),
    },
  };
}

function objectAt(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`[config] ${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`[config] ${name} keys must be: ${wanted.join(", ")}`);
  }
}

function stringAt(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`[config] ${name} must be a non-empty string`);
  return value;
}

function positiveIntAt(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`[config] ${name} must be a positive integer`);
  return value as number;
}

function logLevelAt(value: unknown): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("[config] config.logging.level must be one of debug|info|warn|error");
}

function loadRuntimeConfig(): RuntimeConfig {
  const configPath = path.resolve(process.cwd(), "config/runtime.json");
  try {
    return parseRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[config] failed to load ${configPath}: ${message}`, { cause: error });
  }
}

const runtime = loadRuntimeConfig();

export const config = {
  port: runtime.server.port,
  host: runtime.server.host,
  shutdownTimeoutMs: runtime.server.shutdownTimeoutMs,
  logLevel: runtime.logging.level,
  modelsPath: path.resolve(process.cwd(), "config/models.json"),
  dbPath: path.resolve(process.cwd(), runtime.storage.dbPath),
  openRouter: {
    provider: "openrouter",
    ...runtime.openRouter,
    apiKeyEnv: OPENROUTER_API_KEY_ENV,
  },
  github: {
    tokenEnv: GITHUB_TOKEN_ENV,
    userWhitelistEnv: USER_WHITELIST_ENV,
    committerNameEnv: COMMITTER_NAME_ENV,
    committerEmailEnv: COMMITTER_EMAIL_ENV,
    userWhitelist: (capturedUserWhitelist ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    pollIntervalMs: runtime.github.pollIntervalMs,
    tempDir: runtime.storage.tempDir,
    committerName: capturedCommitterName ?? "strappy",
    committerEmail: capturedCommitterEmail ?? "strappy@users.noreply.github.com",
  },
} as const;

export function requireOpenRouterKey(): string {
  const key = process.env[config.openRouter.apiKeyEnv];
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`[config.requireOpenRouterKey] missing env ${config.openRouter.apiKeyEnv}`);
  }
  return key;
}

export function gitHubToken(): string | undefined {
  return capturedGitHubToken;
}

export function requireGitHubToken(): string {
  if (capturedGitHubToken === undefined) {
    throw new Error(`[config.requireGitHubToken] missing env ${config.github.tokenEnv}`);
  }
  return capturedGitHubToken;
}
