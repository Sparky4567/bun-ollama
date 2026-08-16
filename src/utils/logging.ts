export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

let currentLogLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[currentLogLevel];
}

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

const isTTY = typeof process !== "undefined" && process.stdout && process.stdout.isTTY;

function formatTag(level: LogLevel): string {
  if (!isTTY) {
    return `[${level.toUpperCase()}]`;
  }
  switch (level) {
    case "debug":
      return `${colors.dim}[DEBUG]${colors.reset}`;
    case "info":
      return `${colors.cyan}[INFO]${colors.reset}`;
    case "warn":
      return `${colors.yellow}[WARN]${colors.reset}`;
    case "error":
      return `${colors.red}[ERROR]${colors.reset}`;
    default:
      return `[${level.toUpperCase()}]`;
  }
}

export const logger = {
  debug(message: string, ...args: any[]): void {
    if (shouldLog("debug")) {
      console.log(`${formatTag("debug")} ${message}`, ...args);
    }
  },

  info(message: string, ...args: any[]): void {
    if (shouldLog("info")) {
      console.log(`${formatTag("info")} ${message}`, ...args);
    }
  },

  warn(message: string, ...args: any[]): void {
    if (shouldLog("warn")) {
      console.warn(`${formatTag("warn")} ${message}`, ...args);
    }
  },

  error(message: string, ...args: any[]): void {
    if (shouldLog("error")) {
      console.error(`${formatTag("error")} ${message}`, ...args);
    }
  },
};
