import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.ts";
import { startServer, stopRunningServer, getServerPidPath, isProcessRunning } from "../src/api/server.ts";
import { cliServe, cliServeEnd } from "../src/cli.ts";

describe("Server Lifecycle & serve end", () => {
  let tmpDir: string;
  let testPort: number;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ollama-lite-stop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    testPort = 20000 + Math.floor(Math.random() * 10000);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("writes PID file on startServer and cleans it on stop()", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });

    const instance = startServer(config);
    const pidPath = getServerPidPath(config);

    expect(fs.existsSync(pidPath)).toBe(true);
    const pidContent = JSON.parse(fs.readFileSync(pidPath, "utf-8"));
    expect(pidContent.pid).toBe(process.pid);
    expect(pidContent.port).toBe(testPort);
    expect(isProcessRunning(pidContent.pid)).toBe(true);

    // Stop server
    await instance.stop();
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("gracefully stops running server via stopRunningServer using HTTP shutdown", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });

    const instance = startServer(config, { exitOnShutdown: false });

    // Check that server is responding to HTTP
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);

    // Stop server via stopRunningServer
    const stopResult = await stopRunningServer(config);
    expect(stopResult.success).toBe(true);
    expect(stopResult.message).toContain("stopped");

    // Verify server no longer accepts requests
    let reached = false;
    try {
      await fetch(`http://127.0.0.1:${testPort}/health`, { signal: AbortSignal.timeout(500) });
      reached = true;
    } catch {
      reached = false;
    }
    expect(reached).toBe(false);

    // Clean up instance just in case
    await instance.stop();
  });

  it("handles stopRunningServer when no server is running", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });

    const stopResult = await stopRunningServer(config);
    expect(stopResult.success).toBe(false);
    expect(stopResult.message).toContain("No running Ollama Lite server found");
  });

  it("cleans up stale PID file when process is not alive", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });

    const runtimeDir = config.runtimeDir;
    fs.mkdirSync(runtimeDir, { recursive: true });
    const pidPath = getServerPidPath(config);

    // Write a PID that doesn't exist (e.g. 9999999)
    fs.writeFileSync(
      pidPath,
      JSON.stringify({
        pid: 9999999,
        port: testPort,
        host: "127.0.0.1",
        startedAt: Date.now(),
      }),
      "utf-8"
    );

    const stopResult = await stopRunningServer(config);
    expect(stopResult.success).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("executes cliServe with 'end' subcommand without hanging", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });

    // Should return immediately without hanging
    await cliServe(["end"], config);
    await cliServe(["stop"], config);
  });
});
