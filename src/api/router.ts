import type { Config } from "../config.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import { handleHealth } from "./health.ts";
import {
  handleListTags,
  handleListRunning,
  handleShowModel,
  handlePullModel,
  handleDeleteModel,
  handleOpenAIListModels,
} from "./models.ts";
import { handleOllamaChat, handleOpenAIChat } from "./chat.ts";
import { handleOllamaGenerate, handleOpenAICompletions } from "./generate.ts";
import { logger } from "../utils/logging.ts";

export class ApiRouter {
  private config: Config;
  private processManager: ProcessManager;
  private onShutdown?: () => Promise<void> | void;

  constructor(config: Config, processManager: ProcessManager) {
    this.config = config;
    this.processManager = processManager;
  }

  setShutdownHandler(handler: () => Promise<void> | void): void {
    this.onShutdown = handler;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        },
      });
    }

    try {
      let res: Response;

      // Root endpoint (Ollama standard)
      if (pathname === "/" && method === "GET") {
        res = new Response("Ollama Lite is running", {
          headers: { "Content-Type": "text/plain" },
        });
      }
      // Health
      else if ((pathname === "/health" || pathname === "/api/health") && method === "GET") {
        res = handleHealth();
      }
      // Server Shutdown / Stop
      else if (
        (pathname === "/api/shutdown" ||
          pathname === "/api/serve/end" ||
          pathname === "/api/serve/stop" ||
          pathname === "/shutdown") &&
        (method === "POST" || method === "GET")
      ) {
        if (this.onShutdown) {
          try {
            const maybePromise = this.onShutdown();
            if (maybePromise instanceof Promise) {
              maybePromise.catch((err) => {
                logger.error(`Error in shutdown handler: ${err.message}`);
              });
            }
          } catch (err: any) {
            logger.error(`Error invoking shutdown handler: ${err.message}`);
          }
        }
        res = Response.json({
          status: "ok",
          message: "Ollama Lite server is shutting down",
        });
      }
      // Ollama Models & Tags
      else if (pathname === "/api/tags" && method === "GET") {
        res = await handleListTags(this.config);
      }
      // Ollama Running Models (ps)
      else if (pathname === "/api/ps" && method === "GET") {
        res = await handleListRunning(this.processManager, this.config);
      }
      // Ollama Show
      else if (pathname === "/api/show" && method === "POST") {
        res = await handleShowModel(req, this.config);
      }
      // Ollama Pull
      else if (pathname === "/api/pull" && method === "POST") {
        res = await handlePullModel(req, this.config);
      }
      // Ollama Delete
      else if (pathname === "/api/delete" && (method === "POST" || method === "DELETE")) {
        res = await handleDeleteModel(req, this.config, this.processManager);
      }
      // Ollama Chat
      else if (pathname === "/api/chat" && method === "POST") {
        res = await handleOllamaChat(req, this.processManager, this.config);
      }
      // Ollama Generate
      else if (pathname === "/api/generate" && method === "POST") {
        res = await handleOllamaGenerate(req, this.processManager, this.config);
      }
      // OpenAI Models
      else if (pathname === "/v1/models" && method === "GET") {
        res = await handleOpenAIListModels(this.config);
      }
      // OpenAI Chat
      else if (pathname === "/v1/chat/completions" && method === "POST") {
        res = await handleOpenAIChat(req, this.processManager, this.config);
      }
      // OpenAI Completions
      else if (pathname === "/v1/completions" && method === "POST") {
        res = await handleOpenAICompletions(req, this.processManager, this.config);
      }
      // Not Found
      else {
        res = Response.json(
          { error: `Route not found: ${method} ${pathname}` },
          { status: 404 }
        );
      }

      // Add CORS headers to all responses
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch (err: any) {
      logger.error(`Unhandled router error on ${method} ${pathname}: ${err.stack || err.message}`);
      return Response.json(
        { error: "Internal server error" },
        {
          status: 500,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  }
}
