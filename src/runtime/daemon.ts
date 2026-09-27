import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { type Config, ensureDirectories } from "../config.ts";
import {
  getServerPidPath,
  isProcessRunning,
  stopRunningServer,
} from "../api/server.ts";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  host: string;
  port: number;
  startedAt?: number;
  logPath: string;
}

export interface StartDaemonOptions {
  /** Default true: append --quiet when no explicit log-level flag is given. */
  quiet?: boolean;
  /** Extra args forwarded to `serve` (e.g. ["--port", "11435"]). */
  serveArgs?: string[];
  /** Max time to wait for the daemon to become healthy. Default 15000ms. */
  waitTimeoutMs?: number;
}

export interface StartDaemonResult {
  started: boolean;
  alreadyRunning: boolean;
  pid?: number;
  host: string;
  port: number;
  logPath: string;
  message: string;
}

/**
 * Standard path to the detached daemon log file.
 */
export function getDaemonLogPath(config: Config): string {
  return path.join(config.runtimeDir, "daemon.log");
}

/**
 * Resolve the CLI entrypoint (src/index.ts) for the detached child process.
 * daemon.ts lives at src/runtime/daemon.ts, so ../index.ts is src/index.ts.
 */
export function getDaemonEntryPath(): string {
  return path.resolve(import.meta.dir, "../index.ts");
}

/**
 * Resolve the Bun binary used to spawn the detached daemon.
 * Prefers the currently running Bun executable, falls back to PATH lookup.
 */
export function getBunBinary(): string {
  const execPath = process.execPath || "";
  try {
    if (execPath && path.basename(execPath).includes("bun")) {
      return execPath;
    }
  } catch {}
  try {
    const resolved =
      typeof (Bun as any)?.which === "function"
        ? (Bun as any).which("bun")
        : null;
    if (resolved) return resolved;
  } catch {}
  return "bun";
}

function hasLogLevelFlag(args: string[]): boolean {
  return args.some(
    (a) =>
      a === "-q" ||
      a === "--quiet" ||
      a === "-s" ||
      a === "--silent" ||
      a === "-d" ||
      a === "--debug" ||
      a === "--log-level" ||
      a.startsWith("--log-level=")
  );
}

function readPidFile(config: Config): {
  pid?: number;
  port: number;
  host: string;
  startedAt?: number;
} {
  const pidPath = getServerPidPath(config);
  let pid: number | undefined;
  let port = config.port;
  let host = config.host;
  let startedAt: number | undefined;
  if (fs.existsSync(pidPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pidPath, "utf-8"));
      if (typeof parsed.pid === "number") pid = parsed.pid;
      if (typeof parsed.port === "number") port = parsed.port;
      if (typeof parsed.host === "string") host = parsed.host;
      if (typeof parsed.startedAt === "number") startedAt = parsed.startedAt;
    } catch {}
  }
  return { pid, port, host, startedAt };
}

async function isHttpReachable(host: string, port: number): Promise<boolean> {
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  for (const endpoint of [`/health`, `/`]) {
    try {
      const res = await fetch(`http://${connectHost}:${port}${endpoint}`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

/**
 * Reports whether the daemon (the background `serve` process) is running.
 * A stale PID file alone does not count: the PID must be alive.
 */
export async function getDaemonStatus(config: Config): Promise<DaemonStatus> {
  const logPath = getDaemonLogPath(config);
  const { pid, port, host, startedAt } = readPidFile(config);
  if (pid !== undefined && isProcessRunning(pid)) {
    return { running: true, pid, host, port, startedAt, logPath };
  }
  return { running: false, pid: undefined, host, port, startedAt: undefined, logPath };
}

/**
 * Starts `bun run src/index.ts serve --quiet` as a detached background daemon.
 * Equivalent to the documented `serve --quiet` invocation, but returns
 * immediately instead of blocking the terminal. Logs go to runtimeDir/daemon.log.
 */
export async function startDaemon(
  config: Config,
  options?: StartDaemonOptions
): Promise<StartDaemonResult> {
  ensureDirectories(config);
  const logPath = getDaemonLogPath(config);
  const quiet = options?.quiet ?? true;
  const serveArgs = [...(options?.serveArgs ?? [])];
  if (quiet && !hasLogLevelFlag(serveArgs)) {
    serveArgs.push("--quiet");
  }

  const existing = await getDaemonStatus(config);
  if (existing.running) {
    const reachable = await isHttpReachable(existing.host, existing.port);
    return {
      started: false,
      alreadyRunning: true,
      pid: existing.pid,
      host: existing.host,
      port: existing.port,
      logPath,
      message: reachable
        ? `Ollama Lite daemon already running (PID ${existing.pid}) at http://${existing.host}:${existing.port}.`
        : `Ollama Lite daemon process (PID ${existing.pid}) exists but is not yet reachable at http://${existing.host}:${existing.port}. See ${logPath}.`,
    };
  }

  // Remove a stale PID file left by a dead process so the child starts clean.
  try {
    const pidPath = getServerPidPath(config);
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {}

  const entry = getDaemonEntryPath();
  const bunBin = getBunBinary();
  const childArgs = [entry, "serve", ...serveArgs];

  // The child is a fresh `serve` process: it rebuilds Config from disk + env,
  // so forward the effective in-memory config via env. The explicit serveArgs
  // (e.g. --quiet) still win for log verbosity. apiKey is intentionally not
  // forwarded; the child re-reads it from file/env itself.
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  childEnv.OLLAMA_LITE_HOST = config.host;
  childEnv.OLLAMA_LITE_PORT = String(config.port);
  childEnv.OLLAMA_LITE_MODELS = config.modelsDir;
  childEnv.OLLAMA_LITE_RUNTIME = config.runtimeDir;
  childEnv.OLLAMA_LITE_CONTEXT = String(config.defaultContext);
  childEnv.OLLAMA_LITE_IDLE_TIMEOUT = String(config.idleTimeout);
  if (config.llamaServer) childEnv.OLLAMA_LITE_LLAMA_SERVER = config.llamaServer;
  if (config.ollamaCloudHost) {
    childEnv.OLLAMA_CLOUD_HOST = config.ollamaCloudHost;
    childEnv.OLLAMA_LITE_CLOUD_HOST = config.ollamaCloudHost;
  }
  if (!hasLogLevelFlag(serveArgs) && config.logLevel) {
    childEnv.OLLAMA_LITE_LOG_LEVEL = config.logLevel;
  }

  const logFd = fs.openSync(logPath, "a");
  try {
    fs.appendFileSync(
      logFd,
      `\n[${new Date().toISOString()}] Starting ollama-lite daemon: ${bunBin} ${childArgs.join(" ")}\n`
    );
  } catch {}

  const child = spawn(bunBin, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: childEnv,
  });
  child.unref();
  // The child keeps its own copies; the parent can close its fd immediately.
  try {
    fs.closeSync(logFd);
  } catch {}

  const childPid = child.pid;
  const waitTimeoutMs = options?.waitTimeoutMs ?? 15000;
  const deadline = Date.now() + waitTimeoutMs;
  let pidFromFile: number | undefined;
  let reachable = false;

  while (Date.now() < deadline) {
    const status = await getDaemonStatus(config);
    if (status.running) {
      pidFromFile = status.pid;
      reachable = await isHttpReachable(status.host, status.port);
      if (reachable) break;
    } else if (childPid !== undefined && !(await isProcessRunningSafe(childPid))) {
      break;
    }
    await Bun.sleep(200);
  }

  const finalStatus = await getDaemonStatus(config);
  if (finalStatus.running && (reachable || (await isHttpReachable(finalStatus.host, finalStatus.port)))) {
    return {
      started: true,
      alreadyRunning: false,
      pid: finalStatus.pid,
      host: finalStatus.host,
      port: finalStatus.port,
      logPath,
      message: `Ollama Lite daemon started (PID ${finalStatus.pid}) at http://${finalStatus.host}:${finalStatus.port}. Logs: ${logPath}`,
    };
  }

  if (finalStatus.running) {
    return {
      started: true,
      alreadyRunning: false,
      pid: finalStatus.pid,
      host: finalStatus.host,
      port: finalStatus.port,
      logPath,
      message: `Ollama Lite daemon starting (PID ${finalStatus.pid}). Health check pending — see ${logPath}.`,
    };
  }

  let logTail = "";
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    logTail = content.slice(-2000);
  } catch {}
  throw new Error(
    `Failed to start Ollama Lite daemon. See ${logPath}.${logTail ? `\nLog tail:\n${logTail}` : ""}`
  );
}

async function isProcessRunningSafe(pid: number): Promise<boolean> {
  try {
    return isProcessRunning(pid);
  } catch {
    return false;
  }
}

/**
 * Stops the background daemon (same path as `serve end`).
 */
export async function stopDaemon(config: Config) {
  return stopRunningServer(config);
}

/**
 * Reads the last N lines of the daemon log file.
 */
export function readDaemonLogs(config: Config, lines = 50): string {
  const logPath = getDaemonLogPath(config);
  if (!fs.existsSync(logPath)) {
    return `(no daemon log yet at ${logPath})`;
  }
  const content = fs.readFileSync(logPath, "utf-8");
  const all = content.split("\n");
  return all.slice(-Math.max(1, lines)).join("\n");
}
