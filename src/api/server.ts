import { type Config, ensureDirectories } from "../config.ts";
import { ProcessManager } from "../runtime/process-manager.ts";
import { ApiRouter } from "./router.ts";
import { logger } from "../utils/logging.ts";

export interface ServerInstance {
  server: ReturnType<typeof Bun.serve>;
  processManager: ProcessManager;
  stop: () => Promise<void>;
}

/**
 * Starts the Ollama Lite HTTP API server.
 */
export function startServer(config: Config): ServerInstance {
  ensureDirectories(config);

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

  logger.info(`Ollama Lite server is listening at http://${config.host}:${config.port}`);

  const stop = async () => {
    logger.info("Stopping Ollama Lite server...");
    server.stop();
    await processManager.shutdownAll();
    logger.info("Server stopped.");
  };

  return {
    server,
    processManager,
    stop,
  };
}
