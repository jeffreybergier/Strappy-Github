import { config, type LogLevel } from "./config.js";

const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug: (method: string, message: string, ...rest: unknown[]) => void;
  info: (method: string, message: string, ...rest: unknown[]) => void;
  warn: (method: string, message: string, ...rest: unknown[]) => void;
  error: (method: string, message: string, ...rest: unknown[]) => void;
}

export function createLogger(scope: string, level: LogLevel = config.logLevel): Logger {
  if (typeof scope !== "string" || scope.trim() === "") {
    throw new Error("[createLogger] scope must be a non-empty string");
  }
  const emit = (messageLevel: LogLevel, method: string, message: string, rest: unknown[]): void => {
    if (rank[messageLevel] < rank[level]) return;
    const prefix = messageLevel === "warn" ? "[WARNING] " : "";
    console[messageLevel](`${new Date().toISOString()} ${prefix}[${scope}.${method}] ${message}`, ...rest);
  };
  return {
    debug: (method, message, ...rest) => emit("debug", method, message, rest),
    info: (method, message, ...rest) => emit("info", method, message, rest),
    warn: (method, message, ...rest) => emit("warn", method, message, rest),
    error: (method, message, ...rest) => emit("error", method, message, rest),
  };
}
