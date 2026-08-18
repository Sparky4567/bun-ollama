import fs from "node:fs";
import path from "node:path";
import { normalizeModelName } from "../utils/paths.ts";
import { logger } from "../utils/logging.ts";

export interface SpawnLlamaServerOptions {
  modelPath: string;
  modelName: string;
  port: number;
  contextSize?: number;
  llamaServerBin: string;
  runtimeDir: string;
  threads?: number;
}

export interface ManagedLlamaServer {
  process: any;
  port: number;
  modelName: string;
  modelPath: string;
  runtimePath: string;
  logFile: string;
  getStderr: () => string;
  kill: (signal?: number | "SIGTERM" | "SIGKILL") => void;
}

/**
 * Spawns a llama-server instance using Bun.spawn with safe argument array.
 */
export function spawnLlamaServer(options: SpawnLlamaServerOptions): ManagedLlamaServer {
  const {
    modelPath,
    modelName,
    port,
    contextSize = 2048,
    llamaServerBin,
    runtimeDir,
    threads,
  } = options;

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found at: ${modelPath}`);
  }

  const normalized = normalizeModelName(modelName);
  const modelRuntimeDir = path.join(runtimeDir, normalized);

  if (!fs.existsSync(modelRuntimeDir)) {
    fs.mkdirSync(modelRuntimeDir, { recursive: true });
  }

  const stdoutLogFile = path.join(modelRuntimeDir, "stdout.log");
  const stderrLogFile = path.join(modelRuntimeDir, "stderr.log");
  const configLogFile = path.join(modelRuntimeDir, "config.json");

  // Save runtime config for inspection
  fs.writeFileSync(
    configLogFile,
    JSON.stringify(
      {
        modelName,
        modelPath,
        port,
        contextSize,
        llamaServerBin,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  const args: string[] = [
    llamaServerBin,
    "-m",
    modelPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    String(contextSize),
  ];

  if (threads && threads > 0) {
    args.push("-t", String(threads));
  }

  logger.info(`Starting llama-server on port ${port} for model ${modelName}`);
  logger.debug(`Command: ${args.join(" ")}`);

  const stdoutStream = fs.createWriteStream(stdoutLogFile, { flags: "a" });
  const stderrStream = fs.createWriteStream(stderrLogFile, { flags: "a" });

  let stderrBuffer = "";

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    onExit(subprocess, exitCode, signalCode, error) {
      stdoutStream.end();
      stderrStream.end();
      if (exitCode !== 0 && exitCode !== null) {
        logger.warn(
          `llama-server for ${modelName} on port ${port} exited with code ${exitCode} (signal: ${signalCode})`
        );
      }
    },
  });

  // Read stdout stream in background and write to log file
  if (proc.stdout) {
    (async () => {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            stdoutStream.write(Buffer.from(value));
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }

  // Read stderr stream in background for error diagnostics
  if (proc.stderr) {
    (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            stderrStream.write(Buffer.from(value));
            const chunk = decoder.decode(value, { stream: true });
            stderrBuffer += chunk;
            // Keep last 10KB of stderr
            if (stderrBuffer.length > 10000) {
              stderrBuffer = stderrBuffer.slice(-10000);
            }
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }

  return {
    process: proc,
    port,
    modelName,
    modelPath,
    runtimePath: modelRuntimeDir,
    logFile: stdoutLogFile,
    getStderr: () => stderrBuffer,
    kill: (signal = "SIGTERM") => {
      try {
        proc.kill(signal);
      } catch {
        // Process might already be dead
      }
    },
  };
}
