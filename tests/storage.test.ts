import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveManifest,
  getManifest,
  listManifests,
  deleteModel,
  getBlobPath,
} from "../src/models/storage.ts";
import { createManifest } from "../src/models/manifest.ts";
import { loadConfig, type Config } from "../src/config.ts";

describe("Model Storage", () => {
  let testDir: string;
  let testConfig: Config;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `ollama-lite-test-${Date.now()}`);
    testConfig = loadConfig({
      modelsDir: path.join(testDir, "models"),
      runtimeDir: path.join(testDir, "runtime"),
    });
    fs.mkdirSync(path.join(testDir, "models", "manifests"), { recursive: true });
    fs.mkdirSync(path.join(testDir, "models", "blobs"), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("saves and retrieves model manifests with existing blobs", async () => {
    const dummyBlobPath = getBlobPath("sha256:1234567890abcdef", testConfig.modelsDir);
    fs.writeFileSync(dummyBlobPath, "fake gguf data");

    const manifest = createManifest({
      name: "test-model:1b",
      digest: "sha256:1234567890abcdef",
      size: 14,
      quantization: "Q4_K_M",
      repository: "test/repo",
      filename: "test.gguf",
      blobPath: dummyBlobPath,
    });

    await saveManifest(manifest, testConfig);

    const retrieved = await getManifest("test-model:1b", testConfig);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe("test-model:1b");
    expect(retrieved?.digest).toBe("sha256:1234567890abcdef");
    expect(retrieved?.size).toBe(14);
  });

  it("lists all valid stored models", async () => {
    const blob1 = getBlobPath("sha256:11111", testConfig.modelsDir);
    fs.writeFileSync(blob1, "blob 1");
    const m1 = createManifest({
      name: "model-one:1b",
      digest: "sha256:11111",
      size: 6,
      quantization: "Q4_K_M",
      repository: "test/1",
      filename: "m1.gguf",
      blobPath: blob1,
    });
    await saveManifest(m1, testConfig);

    const list = await listManifests(testConfig);
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("model-one:1b");
  });

  it("deletes a model and its unreferenced blob", async () => {
    const blob = getBlobPath("sha256:22222", testConfig.modelsDir);
    fs.writeFileSync(blob, "blob 2");
    const m = createManifest({
      name: "model-two:1b",
      digest: "sha256:22222",
      size: 6,
      quantization: "Q4_K_M",
      repository: "test/2",
      filename: "m2.gguf",
      blobPath: blob,
    });
    await saveManifest(m, testConfig);

    const deleted = await deleteModel("model-two:1b", testConfig);
    expect(deleted).toBe(true);
    expect(await getManifest("model-two:1b", testConfig)).toBeNull();
    expect(fs.existsSync(blob)).toBe(false);
  });
});
