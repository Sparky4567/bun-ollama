import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.ts";
import {
  getDaemonLogPath,
  getDaemonStatus,
  readDaemonLogs,
  startDaemon,
  stopDaemon,
} from "../src/runtime/daemon.ts";

describe("Daemon (detached serve --quiet)", () => {
  let tmpDir: string;
  let testPort: number;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ollama-lite-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    testPort = 22000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    try {
      const config = loadConfig({
        host: "127.0.0.1",
        port: testPort,
        modelsDir: path.join(tmpDir, "models"),
        runtimeDir: path.join(tmpDir, "runtime"),
        logLevel: "none",
      });
      await stopDaemon(config);
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("resolves daemon log path inside runtimeDir", () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });
    expect(getDaemonLogPath(config)).toBe(path.join(config.runtimeDir, "daemon.log"));
  });

  it("reports not running before start and reads empty logs", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });
    const status = await getDaemonStatus(config);
    expect(status.running).toBe(false);
    expect(readDaemonLogs(config)).toContain("no daemon log yet");
  });

  it("starts a detached daemon and stops it", async () => {
    const config = loadConfig({
      host: "127.0.0.1",
      port: testPort,
      modelsDir: path.join(tmpDir, "models"),
      runtimeDir: path.join(tmpDir, "runtime"),
      logLevel: "none",
    });

    const started = await startDaemon(config, { quiet: true });
    expect(started.started).toBe(true);
    expect(started.pid).toBeGreaterThan(0);
    expect(started.port).toBe(testPort);

    // Daemon outlives the start call: PID file + HTTP health both present.
    const status = await getDaemonStatus(config);
    expect(status.running).toBe(true);
    const health = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(health.status).toBe(200);

    // Second start is a no-op reporting the existing daemon.
    const again = await startDaemon(config, { quiet: true });
    expect(again.alreadyRunning).toBe(true);
    expect(again.pid).toBe(status.pid);

    const stopped = await stopDaemon(config);
    expect(stopped.success).toBe(true);

    const after = await getDaemonStatus(config);
    expect(after.running).toBe(false);
  }, 30000);
});
