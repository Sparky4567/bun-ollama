import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  detectOllamaDirectory,
  scanLocalOllamaModels,
  importLocalOllamaModel,
  importAllLocalOllamaModels,
} from "../src/models/ollama-local.ts";
import { getManifest, hasModel } from "../src/models/storage.ts";
import { type Config } from "../src/config.ts";

describe("Local Ollama Importer", () => {
  const tmpOllamaDir = `/tmp/test-ollama-src-${Date.now()}`;
  const tmpLiteDir = `/tmp/test-ollama-dest-${Date.now()}`;

  const modelHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const paramsHash = "1111111111111111111111111111111111111111111111111111111111111111";
  const templateHash = "2222222222222222222222222222222222222222222222222222222222222222";

  const dummyBlobContent = "GGUF-DUMMY-MODEL-CONTENT";
  const dummyParamsContent = JSON.stringify({
    num_ctx: 4096,
    temperature: 0.7,
    stop: ["<|endoftext|>", "<|im_end|>"],
  });
  const dummyTemplateContent = "{{ if .System }}{{ .System }}{{ end }}{{ .Prompt }}";

  const testConfig: Config = {
    host: "127.0.0.1",
    port: 11434,
    modelsDir: path.join(tmpLiteDir, "models"),
    runtimeDir: path.join(tmpLiteDir, "runtime"),
    defaultContext: 2048,
    defaultQuantization: "Q4_K_M",
    idleTimeout: 300000,
    llamaServer: "llama-server",
    logLevel: "none",
  };

  beforeAll(() => {
    // Create mock Ollama directory structure
    const manifestsDir = path.join(
      tmpOllamaDir,
      "manifests",
      "registry.ollama.ai",
      "library",
      "test-imported-model"
    );
    const blobsDir = path.join(tmpOllamaDir, "blobs");

    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.mkdirSync(blobsDir, { recursive: true });

    // Write dummy blobs
    fs.writeFileSync(path.join(blobsDir, `sha256-${modelHash}`), dummyBlobContent);
    fs.writeFileSync(path.join(blobsDir, `sha256-${paramsHash}`), dummyParamsContent);
    fs.writeFileSync(path.join(blobsDir, `sha256-${templateHash}`), dummyTemplateContent);

    // Write Ollama manifest
    const manifestJson = {
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        mediaType: "application/vnd.docker.container.image.v1+json",
        digest: `sha256:${paramsHash}`,
        size: dummyParamsContent.length,
      },
      layers: [
        {
          mediaType: "application/vnd.ollama.image.model",
          digest: `sha256:${modelHash}`,
          size: dummyBlobContent.length,
        },
        {
          mediaType: "application/vnd.ollama.image.params",
          digest: `sha256:${paramsHash}`,
          size: dummyParamsContent.length,
        },
        {
          mediaType: "application/vnd.ollama.image.template",
          digest: `sha256:${templateHash}`,
          size: dummyTemplateContent.length,
        },
      ],
    };

    fs.writeFileSync(path.join(manifestsDir, "latest"), JSON.stringify(manifestJson, null, 2));
  });

  afterAll(() => {
    fs.rmSync(tmpOllamaDir, { recursive: true, force: true });
    fs.rmSync(tmpLiteDir, { recursive: true, force: true });
  });

  it("detects local Ollama directory structure", () => {
    const detected = detectOllamaDirectory(tmpOllamaDir);
    expect(detected).toBe(tmpOllamaDir);
  });

  it("scans and discovers Ollama models with their metadata", async () => {
    const models = await scanLocalOllamaModels(tmpOllamaDir);
    expect(models.length).toBe(1);

    const model = models[0]!;
    expect(model.name).toBe("test-imported-model:latest");
    expect(model.modelDigest).toBe(`sha256:${modelHash}`);
    expect(model.size).toBe(dummyBlobContent.length);
    expect(model.parameters?.context_size).toBe(4096);
    expect(model.parameters?.stop).toEqual(["<|endoftext|>", "<|im_end|>"]);
    expect(model.template).toBe(dummyTemplateContent);
  });

  it("imports model using symlink mode without copying full blob", async () => {
    const models = await scanLocalOllamaModels(tmpOllamaDir);
    const model = models[0]!;

    const manifest = await importLocalOllamaModel(model, {
      mode: "symlink",
      config: testConfig,
    });

    expect(manifest.name).toBe("test-imported-model:latest");
    expect(manifest.source).toBe("ollama-local");
    expect(manifest.parameters?.context_size).toBe(4096);
    expect(manifest.template).toBe(dummyTemplateContent);

    // Verify blob exists in target and is a symlink
    const stat = fs.lstatSync(manifest.blob_path);
    expect(stat.isSymbolicLink()).toBe(true);

    // Verify readable by storage
    const exists = await hasModel("test-imported-model:latest", testConfig);
    expect(exists).toBe(true);

    const retrieved = await getManifest("test-imported-model:latest", testConfig);
    expect(retrieved?.digest).toBe(`sha256:${modelHash}`);
  });

  it("imports all models and reports skipped for already imported ones", async () => {
    const summary = await importAllLocalOllamaModels({
      ollamaDir: tmpOllamaDir,
      config: testConfig,
      overwrite: false,
    });

    expect(summary.discoveredCount).toBe(1);
    expect(summary.skipped).toContain("test-imported-model:latest");
    expect(summary.imported.length).toBe(0);
  });
});
