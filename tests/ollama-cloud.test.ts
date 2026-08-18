import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveModel } from "../src/models/resolver.ts";
import { resolveOllamaRegistryModel } from "../src/models/ollama-registry.ts";
import { downloadModel } from "../src/models/downloader.ts";
import { getManifest, listManifests, deleteModel, saveManifest } from "../src/models/storage.ts";
import { ProcessManager } from "../src/runtime/process-manager.ts";
import { proxyCloudChat, proxyCloudGenerate, getEffectiveApiKey } from "../src/runtime/cloud-client.ts";
import { ApiRouter } from "../src/api/router.ts";
import { type Config, loadConfig } from "../src/config.ts";

describe("Ollama Cloud Models Support", () => {
  let testDir: string;
  let testConfig: Config;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `ollama-cloud-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(testDir, "models", "manifests"), { recursive: true });
    fs.mkdirSync(path.join(testDir, "models", "blobs"), { recursive: true });
    fs.mkdirSync(path.join(testDir, "runtime"), { recursive: true });

    testConfig = loadConfig({
      modelsDir: path.join(testDir, "models"),
      runtimeDir: path.join(testDir, "runtime"),
      logLevel: "none",
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("resolves gpt-oss:120b-cloud as an Ollama Cloud model descriptor", async () => {
    const descriptor = await resolveModel("gpt-oss:120b-cloud");

    expect(descriptor.name).toBe("gpt-oss:120b-cloud");
    expect(descriptor.isCloud).toBe(true);
    expect(descriptor.source).toBe("ollama-cloud");
    expect(descriptor.remoteHost).toBe("https://ollama.com");
    expect(descriptor.remoteModel).toBe("gpt-oss:120b");
    expect(descriptor.context).toBe(131072);
    expect(descriptor.quantization).toBe("MXFP4");
  });

  it("resolves explicit prefix ollama:gpt-oss:120b-cloud", async () => {
    const descriptor = await resolveOllamaRegistryModel("ollama:gpt-oss:120b-cloud");

    expect(descriptor.name).toBe("gpt-oss:120b-cloud");
    expect(descriptor.isCloud).toBe(true);
    expect(descriptor.remoteHost).toBe("https://ollama.com");
    expect(descriptor.remoteModel).toBe("gpt-oss:120b");
  });

  it("downloads/registers cloud model manifest without requiring weight blobs", async () => {
    const manifest = await downloadModel("gpt-oss:120b-cloud", { config: testConfig });

    expect(manifest.name).toBe("gpt-oss:120b-cloud");
    expect(manifest.is_cloud).toBe(true);
    expect(manifest.format).toBe("cloud");
    expect(manifest.remote_host).toBe("https://ollama.com");
    expect(manifest.remote_model).toBe("gpt-oss:120b");

    // Manifest can be retrieved from storage without requiring local blob
    const saved = await getManifest("gpt-oss:120b-cloud", testConfig);
    expect(saved).not.toBeNull();
    expect(saved?.name).toBe("gpt-oss:120b-cloud");
    expect(saved?.is_cloud).toBe(true);

    // Shows in listManifests
    const all = await listManifests(testConfig);
    expect(all.some((m) => m.name === "gpt-oss:120b-cloud")).toBe(true);

    // Deletes cleanly
    const deleted = await deleteModel("gpt-oss:120b-cloud", testConfig);
    expect(deleted).toBe(true);
    const afterDelete = await getManifest("gpt-oss:120b-cloud", testConfig);
    expect(afterDelete).toBeNull();
  });

  it("handles ProcessManager readiness for cloud models without spawning llama-server", async () => {
    const pm = new ProcessManager(testConfig);
    try {
      const proc = await pm.ensureModelReady("gpt-oss:120b-cloud");

      expect(proc.model).toBe("gpt-oss:120b-cloud");
      expect(proc.isCloud).toBe(true);
      expect(proc.state).toBe("ready");
      expect(proc.port).toBe(0);
      expect(proc.remoteHost).toBe("https://ollama.com");
      expect(proc.remoteModel).toBe("gpt-oss:120b");

      const runningList = pm.list();
      expect(runningList.length).toBe(1);
      expect(runningList[0]?.isCloud).toBe(true);

      const stopped = await pm.stop("gpt-oss:120b-cloud");
      expect(stopped).toBe(true);
      expect(pm.list().length).toBe(0);
    } finally {
      await pm.shutdownAll();
    }
  });

  it("extracts effective API key from config, env, and request header", () => {
    // 1. From request header
    const key1 = getEffectiveApiKey({ apiKey: "config-key" } as any, "Bearer custom-request-token");
    expect(key1).toBe("custom-request-token");

    // 2. From config
    const key2 = getEffectiveApiKey({ apiKey: "config-key" } as any, null);
    expect(key2).toBe("config-key");
  });

  it("handles cloud chat and generate proxy with mock Ollama Cloud server", async () => {
    // Start local mock cloud server
    let lastReceivedPath = "";
    let lastReceivedAuth = "";
    let lastReceivedBody: any = null;

    const mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        lastReceivedPath = url.pathname;
        lastReceivedAuth = req.headers.get("authorization") || "";
        lastReceivedBody = await req.json();

        if (url.pathname === "/api/chat") {
          return new Response(
            JSON.stringify({
              model: lastReceivedBody.model,
              created_at: new Date().toISOString(),
              message: { role: "assistant", content: "Hello from mock Ollama Cloud!" },
              done: true,
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.pathname === "/api/generate") {
          return new Response(
            JSON.stringify({
              model: lastReceivedBody.model,
              created_at: new Date().toISOString(),
              response: "Generated from mock cloud!",
              done: true,
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const mockHost = `http://127.0.0.1:${mockServer.port}`;
      const mockManifest = {
        name: "gpt-oss:120b-cloud",
        digest: "sha256:1111",
        size: 0,
        format: "cloud" as const,
        quantization: "cloud",
        repository: "registry.ollama.ai",
        filename: "(cloud)",
        blob_path: "",
        modified_at: new Date().toISOString(),
        is_cloud: true,
        remote_host: mockHost,
        remote_model: "gpt-oss:120b",
      };

      const pm = new ProcessManager(testConfig);
      const router = new ApiRouter(testConfig, pm);

      // Save manifest
      await downloadModel("gpt-oss:120b-cloud", { config: testConfig });
      // Update saved manifest to point to mock server
      const saved = (await getManifest("gpt-oss:120b-cloud", testConfig))!;
      saved.remote_host = mockHost;
      await saveManifest(saved, testConfig);

      // Test POST /api/chat via ApiRouter
      const chatReq = new Request("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-cloud-api-key",
        },
        body: JSON.stringify({
          model: "gpt-oss:120b-cloud",
          messages: [{ role: "user", content: "Hello cloud" }],
          stream: false,
        }),
      });

      const chatRes = await router.handle(chatReq);
      expect(chatRes.status).toBe(200);
      const chatJson: any = await chatRes.json();

      expect(chatJson.message?.content).toBe("Hello from mock Ollama Cloud!");
      expect(lastReceivedPath).toBe("/api/chat");
      expect(lastReceivedAuth).toBe("Bearer test-cloud-api-key");
      expect(lastReceivedBody.model).toBe("gpt-oss:120b"); // Translated from gpt-oss:120b-cloud to remote_model

      // Test POST /api/generate via ApiRouter
      const genReq = new Request("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-cloud-api-key",
        },
        body: JSON.stringify({
          model: "gpt-oss:120b-cloud",
          prompt: "Write a poem",
          stream: false,
        }),
      });

      const genRes = await router.handle(genReq);
      expect(genRes.status).toBe(200);
      const genJson: any = await genRes.json();

      expect(genJson.response).toBe("Generated from mock cloud!");
      expect(lastReceivedPath).toBe("/api/generate");

      // Test GET /api/tags
      const tagsReq = new Request("http://127.0.0.1:11434/api/tags");
      const tagsRes = await router.handle(tagsReq);
      const tagsJson: any = await tagsRes.json();
      const cloudTag = tagsJson.models.find((m: any) => m.name === "gpt-oss:120b-cloud");
      expect(cloudTag).toBeDefined();
      expect(cloudTag.is_cloud).toBe(true);
      expect(cloudTag.details.format).toBe("cloud");

      // Test POST /api/show
      const showReq = new Request("http://127.0.0.1:11434/api/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "gpt-oss:120b-cloud" }),
      });
      const showRes = await router.handle(showReq);
      const showJson: any = await showRes.json();
      expect(showJson.remote_model).toBe("gpt-oss:120b");
      expect(showJson.details.format).toBe("cloud");

      await pm.shutdownAll();
    } finally {
      mockServer.stop(true);
    }
  });

  it("handles 401 Unauthorized from Ollama Cloud with a helpful error message", async () => {
    const unauthMockServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const mockHost = `http://127.0.0.1:${unauthMockServer.port}`;
      const mockManifest = {
        name: "gpt-oss:120b-cloud",
        digest: "sha256:1111",
        size: 0,
        format: "cloud" as const,
        quantization: "cloud",
        repository: "registry.ollama.ai",
        filename: "(cloud)",
        blob_path: "",
        modified_at: new Date().toISOString(),
        is_cloud: true,
        remote_host: mockHost,
        remote_model: "gpt-oss:120b",
      };

      const res = await proxyCloudChat({
        req: new Request("http://127.0.0.1:11434/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-oss:120b-cloud", messages: [] }),
        }),
        body: { model: "gpt-oss:120b-cloud", messages: [] },
        manifest: mockManifest,
        config: testConfig,
      });

      expect(res.status).toBe(401);
      const data: any = await res.json();
      expect(data.error).toContain("Ollama Cloud authentication failed (401 Unauthorized)");
      expect(data.error).toContain("OLLAMA_API_KEY");
      expect(data.error).toContain("https://ollama.com/settings/keys");
    } finally {
      unauthMockServer.stop(true);
    }
  });

  it("generates and retrieves ed25519 SSH public keys", () => {
    const { getOrCreateKeypair, getPublicKey } = require("../src/runtime/auth.ts");
    const keypair = getOrCreateKeypair(testDir);

    expect(keypair.publicKey).toContain("ssh-ed25519");
    expect(fs.existsSync(keypair.publicKeyPath)).toBe(true);
    expect(fs.existsSync(keypair.privateKeyPath)).toBe(true);

    const retrieved = getPublicKey(testDir);
    expect(retrieved).toBe(keypair.publicKey);
  });

  it("handles signin, signout, and auth status lifecycle", async () => {
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization");
        if (auth === "Bearer valid-secret-key") {
          return Response.json({
            object: "list",
            data: [
              { id: "gpt-oss:120b" },
              { id: "gpt-oss:20b" },
              { id: "deepseek-v4-pro:preview" },
            ],
          });
        }
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      },
    });

    try {
      const mockHost = `http://127.0.0.1:${mockAuthServer.port}`;
      const authConfig = loadConfig({
        modelsDir: path.join(testDir, "models"),
        runtimeDir: path.join(testDir, "runtime"),
        ollamaCloudHost: mockHost,
        logLevel: "none",
      });

      const { signIn, signOut, getAuthStatus } = require("../src/runtime/auth.ts");

      // 1. Initial status - not authenticated
      const initialStatus = await getAuthStatus(authConfig);
      expect(initialStatus.authenticated).toBe(false);

      // 2. Signin with invalid key
      const failResult = await signIn("wrong-key", authConfig);
      expect(failResult.success).toBe(false);

      // 3. Signin with valid key
      const successResult = await signIn("valid-secret-key", authConfig);
      expect(successResult.success).toBe(true);
      expect(successResult.models?.length).toBe(3);
      expect(successResult.models).toContain("gpt-oss:120b-cloud");

      // 4. Manifests were synced
      const manifests = await listManifests(authConfig);
      expect(manifests.some((m) => m.name === "gpt-oss:120b-cloud")).toBe(true);
      expect(manifests.some((m) => m.name === "gpt-oss:20b-cloud")).toBe(true);

      // 5. Auth status is now true
      const activeStatus = await getAuthStatus(loadConfig({ ...authConfig, apiKey: "valid-secret-key" }));
      expect(activeStatus.authenticated).toBe(true);
      expect(activeStatus.models?.length).toBe(3);

      // 6. Test router auth endpoints
      const pm = new ProcessManager(authConfig);
      const router = new ApiRouter(authConfig, pm);

      const statusReq = new Request("http://127.0.0.1:11434/api/auth/status");
      const statusRes = await router.handle(statusReq);
      expect(statusRes.status).toBe(200);

      const keyReq = new Request("http://127.0.0.1:11434/api/auth/key");
      const keyRes = await router.handle(keyReq);
      expect(keyRes.status).toBe(200);
      const keyJson: any = await keyRes.json();
      expect(keyJson.public_key).toBeDefined();

      // 7. Sign out
      const signoutResult = await signOut(authConfig);
      expect(signoutResult.success).toBe(true);

      await pm.shutdownAll();
    } finally {
      mockAuthServer.stop(true);
    }
  });
});
