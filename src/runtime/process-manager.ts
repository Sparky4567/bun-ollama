import type { Config } from "../config.ts";
import { getManifest } from "../models/storage.ts";
import { downloadModel, type ProgressCallback } from "../models/downloader.ts";
import { portManager } from "./port-manager.ts";
import { spawnLlamaServer, type ManagedLlamaServer } from "./llama-server.ts";
import { waitForHealthy } from "./health-check.ts";
import { logger } from "../utils/logging.ts";

export type ModelState =
  | "unknown"
  | "downloading"
  | "available"
  | "starting"
  | "ready"
  | "busy"
  | "stopping"
  | "stopped"
  | "error";

export interface ModelProcess {
  model: string;
  port: number;
  server?: ManagedLlamaServer;
  startedAt: number;
  lastUsedAt: number;
  state: ModelState;
  digest: string;
  size: number;
  isCloud?: boolean;
  remoteHost?: string;
  remoteModel?: string;
}

export class ProcessManager {
  private processes: Map<string, ModelProcess> = new Map();
  private startupLocks: Map<string, Promise<ModelProcess>> = new Map();
  private idleCheckInterval: any = null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.startIdleChecker();
  }

  updateConfig(config: Config): void {
    this.config = config;
  }

  /**
   * Starts periodic idle check to unload inactive models.
   */
  private startIdleChecker(): void {
    if (this.idleCheckInterval) return;

    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      const idleTimeout = this.config.idleTimeout;

      for (const [model, proc] of this.processes.entries()) {
        if (proc.state === "ready" && now - proc.lastUsedAt > idleTimeout) {
          logger.info(`Model ${model} has been idle for > ${idleTimeout / 1000}s. Unloading.`);
          this.stop(model).catch((err) => {
            logger.error(`Error unloading idle model ${model}: ${err.message}`);
          });
        }
      }
    }, 15_000); // check every 15s

    if (this.idleCheckInterval.unref) {
      this.idleCheckInterval.unref();
    }
  }

  /**
   * Ensures a model exists and is running, pulling it if necessary.
   * Uses per-model startup locks to deduplicate simultaneous requests.
   */
  async ensureModelReady(
    modelName: string,
    onProgress?: ProgressCallback
  ): Promise<ModelProcess> {
    const existing = this.processes.get(modelName);
    if (existing && existing.state === "ready" && (existing.isCloud || !existing.server?.process.killed)) {
      this.touch(modelName);
      return existing;
    }

    // Check if another request is currently starting this model
    const pendingLock = this.startupLocks.get(modelName);
    if (pendingLock) {
      logger.debug(`Joining existing startup promise for ${modelName}`);
      return await pendingLock;
    }

    const startupPromise = (async () => {
      try {
        // 1. Check if model exists locally in manifests
        let manifest = await getManifest(modelName, this.config);

        if (!manifest) {
          logger.info(`Model ${modelName} not found locally. Starting automatic download/registration.`);
          manifest = await downloadModel(modelName, {
            config: this.config,
            onProgress,
          });
        }

        // Check if this is an Ollama Cloud model
        if (manifest.is_cloud || manifest.source === "ollama-cloud" || manifest.format === "cloud") {
          const cloudProc: ModelProcess = {
            model: modelName,
            port: 0,
            startedAt: Date.now(),
            lastUsedAt: Date.now(),
            state: "ready",
            digest: manifest.digest,
            size: manifest.size || 0,
            isCloud: true,
            remoteHost: manifest.remote_host,
            remoteModel: manifest.remote_model,
          };
          this.processes.set(modelName, cloudProc);
          logger.info(`Model ${modelName} is ready as an Ollama Cloud model.`);
          return cloudProc;
        }

        // 2. Start the local model server
        return await this.startProcess(modelName, manifest.blob_path, manifest.digest, manifest.size, manifest.parameters?.context_size);
      } finally {
        this.startupLocks.delete(modelName);
      }
    })();

    this.startupLocks.set(modelName, startupPromise);
    return await startupPromise;
  }

  /**
   * Spawns llama-server for a model and waits for health check.
   */
  private async startProcess(
    modelName: string,
    blobPath: string,
    digest: string,
    size: number,
    contextSize?: number
  ): Promise<ModelProcess> {
    // If an existing instance is in processes map, stop it first
    await this.stop(modelName);

    const port = await portManager.allocatePort(modelName);
    logger.info(`Allocated port ${port} for model ${modelName}`);

    const server = spawnLlamaServer({
      modelName,
      modelPath: blobPath,
      port,
      contextSize: contextSize || this.config.defaultContext,
      llamaServerBin: this.config.llamaServer,
      runtimeDir: this.config.runtimeDir,
    });

    const modelProc: ModelProcess = {
      model: modelName,
      port,
      server,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      state: "starting",
      digest,
      size,
    };

    this.processes.set(modelName, modelProc);

    try {
      await waitForHealthy(port, {
        timeoutMs: 120_000,
        intervalMs: 250,
        process: {
          get exitCode() {
            return server.process.exitCode;
          },
          getStderr: () => server.getStderr(),
        },
      });

      modelProc.state = "ready";
      modelProc.lastUsedAt = Date.now();
      logger.info(`Model ${modelName} is now READY on port ${port}`);
      return modelProc;
    } catch (err: any) {
      modelProc.state = "error";
      this.stop(modelName).catch(() => {});
      throw err;
    }
  }

  /**
   * Stops a running model process and releases its port.
   */
  async stop(modelName: string): Promise<boolean> {
    const proc = this.processes.get(modelName);
    if (!proc) return false;

    proc.state = "stopping";
    if (proc.isCloud) {
      this.processes.delete(modelName);
      proc.state = "stopped";
      return true;
    }

    logger.info(`Stopping model process ${modelName} on port ${proc.port}`);

    try {
      proc.server?.kill("SIGTERM");
      
      // Wait briefly for graceful shutdown, else SIGKILL
      const exitPromise = proc.server?.process.exited;
      const timeoutPromise = Bun.sleep(2000);
      await Promise.race([exitPromise, timeoutPromise]);

      if (proc.server?.process.exitCode === null) {
        proc.server?.kill("SIGKILL");
      }
    } catch {
      // Process may already have terminated
    } finally {
      portManager.releasePort(proc.port);
      this.processes.delete(modelName);
      proc.state = "stopped";
    }

    return true;
  }

  /**
   * Restarts a model process.
   */
  async restart(modelName: string): Promise<ModelProcess> {
    await this.stop(modelName);
    return await this.ensureModelReady(modelName);
  }

  /**
   * Gets a running model process if available.
   */
  get(modelName: string): ModelProcess | undefined {
    return this.processes.get(modelName);
  }

  /**
   * Lists all running model processes.
   */
  list(): ModelProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Updates the last used timestamp for a model.
   */
  touch(modelName: string): void {
    const proc = this.processes.get(modelName);
    if (proc) {
      proc.lastUsedAt = Date.now();
    }
  }

  /**
   * Shuts down all running model processes and clears timers.
   */
  async shutdownAll(): Promise<void> {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    const stopPromises = Array.from(this.processes.keys()).map((m) => this.stop(m));
    await Promise.all(stopPromises);
  }
}
