import fs from "node:fs";
import path from "node:path";
import { type Config, ensureDirectories } from "../config.ts";
import { ProcessManager } from "../runtime/process-manager.ts";
import { ApiRouter } from "./router.ts";
import { logger } from "../utils/logging.ts";

export interface ServerInstance {
  server: ReturnType<typeof Bun.serve>;
  processManager: ProcessManager;
  stop: () => Promise<void>;
  pidPath?: string;
}

export interface StopServerResult {
  success: boolean;
  message: string;
  pid?: number;
}

/**
 * Returns the standard path to the server PID file.
 */
export function getServerPidPath(config: Config): string {
  return path.join(config.runtimeDir, "server.pid");
}

/**
 * Checks whether a given process ID is currently alive.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

export interface StartServerOptions {
  exitOnShutdown?: boolean;
}

/**
 * Starts the Ollama Lite HTTP API server.
 */
export function startServer(config: Config, options?: StartServerOptions): ServerInstance {
  ensureDirectories(config);
  const exitOnShutdown = options?.exitOnShutdown ?? true;

  const processManager = new ProcessManager(config);
  const router = new ApiRouter(config, processManager);

  logger.info(`Starting Ollama Lite API server on ${config.host}:${config.port}`);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(req) {
      return router.handle(req);
    },
  });

  const pidPath = getServerPidPath(config);
  try {
    fs.writeFileSync(
      pidPath,
      JSON.stringify({
        pid: process.pid,
        port: config.port,
        host: config.host,
        startedAt: Date.now(),
      }),
      "utf-8"
    );
  } catch (err: any) {
    logger.warn(`Could not write server PID file: ${err.message}`);
  }

  logger.info(`Ollama Lite server is listening at http://${config.host}:${config.port}`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    logger.info("Stopping Ollama Lite server...");
    try {
      server.stop(true);
    } catch {}
    await processManager.shutdownAll();
    try {
      if (fs.existsSync(pidPath)) {
        fs.unlinkSync(pidPath);
      }
    } catch {}
    logger.info("Server stopped.");
  };

  router.setShutdownHandler(async () => {
    logger.info("Shutdown requested via API endpoint.");
    setTimeout(async () => {
      try {
        await stop();
      } finally {
        if (exitOnShutdown) {
          process.exit(0);
        }
      }
    }, 50);
  });

  return {
    server,
    processManager,
    stop,
    pidPath,
  };
}

/**
 * Stops an active Ollama Lite server daemon gracefully via HTTP endpoint or process signal.
 */
export async function stopRunningServer(config: Config): Promise<StopServerResult> {
  const pidPath = getServerPidPath(config);
  let storedPid: number | undefined;
  let targetPort = config.port;
  let targetHost = config.host;

  if (fs.existsSync(pidPath)) {
    try {
      const content = fs.readFileSync(pidPath, "utf-8");
      const parsed = JSON.parse(content);
      if (typeof parsed.pid === "number") storedPid = parsed.pid;
      if (typeof parsed.port === "number") targetPort = parsed.port;
      if (typeof parsed.host === "string") targetHost = parsed.host;
    } catch {
      // ignore JSON parse error
    }
  }

  const hostToConnect =
    targetHost === "0.0.0.0" || targetHost === "::" ? "127.0.0.1" : targetHost;
  const endpoint = `http://${hostToConnect}:${targetPort}/api/shutdown`;

  let stoppedViaHttp = false;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      stoppedViaHttp = true;
    }
  } catch {
    // HTTP request failed or timed out
  }

  if (stoppedViaHttp) {
    if (storedPid) {
      for (let i = 0; i < 30; i++) {
        if (!isProcessRunning(storedPid)) break;
        await Bun.sleep(100);
      }
    } else {
      await Bun.sleep(200);
    }

    try {
      if (fs.existsSync(pidPath)) {
        fs.unlinkSync(pidPath);
      }
    } catch {}

    return {
      success: true,
      message: `Ollama Lite server (http://${targetHost}:${targetPort}) stopped successfully.`,
      pid: storedPid,
    };
  }

  // If HTTP failed, check if stored PID is alive and kill it
  if (storedPid && isProcessRunning(storedPid)) {
    try {
      process.kill(storedPid, "SIGTERM");

      for (let i = 0; i < 30; i++) {
        if (!isProcessRunning(storedPid)) break;
        await Bun.sleep(100);
      }

      if (isProcessRunning(storedPid)) {
        process.kill(storedPid, "SIGKILL");
        await Bun.sleep(100);
      }

      try {
        if (fs.existsSync(pidPath)) {
          fs.unlinkSync(pidPath);
        }
      } catch {}

      return {
        success: true,
        message: `Ollama Lite server (PID: ${storedPid}) stopped.`,
        pid: storedPid,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to stop Ollama Lite server process ${storedPid}: ${err.message}`,
        pid: storedPid,
      };
    }
  }

  // If stale PID file exists but process is not running, clean it up
  if (fs.existsSync(pidPath)) {
    try {
      fs.unlinkSync(pidPath);
    } catch {}
  }

  return {
    success: false,
    message: `No running Ollama Lite server found on http://${targetHost}:${targetPort}.`,
  };
}
