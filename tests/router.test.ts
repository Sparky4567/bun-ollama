import { describe, it, expect } from "bun:test";
import { ApiRouter } from "../src/api/router.ts";
import { ProcessManager } from "../src/runtime/process-manager.ts";
import { loadConfig } from "../src/config.ts";

describe("API Router", () => {
  const config = loadConfig({ logLevel: "none" });
  const pm = new ProcessManager(config);
  const router = new ApiRouter(config, pm);

  it("handles GET / root health text", async () => {
    const req = new Request("http://localhost:11434/");
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("Ollama Lite is running");
  });

  it("handles GET /health json", async () => {
    const req = new Request("http://localhost:11434/health");
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.status).toBe("ok");
  });

  it("handles GET /api/tags list", async () => {
    const req = new Request("http://localhost:11434/api/tags");
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(Array.isArray(json.models)).toBe(true);
  });

  it("handles GET /v1/models list", async () => {
    const req = new Request("http://localhost:11434/v1/models");
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.object).toBe("list");
  });

  it("handles CORS OPTIONS preflight", async () => {
    const req = new Request("http://localhost:11434/api/chat", { method: "OPTIONS" });
    const res = await router.handle(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("handles POST /api/shutdown and executes shutdown handler", async () => {
    let handlerCalled = false;
    router.setShutdownHandler(() => {
      handlerCalled = true;
    });

    const req = new Request("http://localhost:11434/api/shutdown", { method: "POST" });
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.status).toBe("ok");
    expect(handlerCalled).toBe(true);
  });

  it("handles POST /api/serve/end as shutdown alias", async () => {
    let handlerCalled = false;
    router.setShutdownHandler(() => {
      handlerCalled = true;
    });

    const req = new Request("http://localhost:11434/api/serve/end", { method: "POST" });
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.status).toBe("ok");
    expect(handlerCalled).toBe(true);
  });

  it("returns 404 for unknown routes", async () => {
    const req = new Request("http://localhost:11434/api/nonexistent");
    const res = await router.handle(req);
    expect(res.status).toBe(404);
  });
});
