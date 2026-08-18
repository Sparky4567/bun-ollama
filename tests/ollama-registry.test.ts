import { describe, expect, it } from "bun:test";
import {
  parseOllamaModelRef,
  fetchOllamaRegistryManifest,
  resolveOllamaRegistryModel,
} from "../src/models/ollama-registry.ts";

describe("Ollama Registry Protocol", () => {
  it("parses short model references into namespace, model, and tag", () => {
    const ref = parseOllamaModelRef("smollm:135m");
    expect(ref.namespace).toBe("library");
    expect(ref.model).toBe("smollm");
    expect(ref.tag).toBe("135m");
  });

  it("parses references with ollama:// protocol prefix", () => {
    const ref = parseOllamaModelRef("ollama://deepseek-r1:8b");
    expect(ref.namespace).toBe("library");
    expect(ref.model).toBe("deepseek-r1");
    expect(ref.tag).toBe("8b");
  });

  it("parses references with ollama: prefix", () => {
    const ref = parseOllamaModelRef("ollama:llama3.2:1b");
    expect(ref.namespace).toBe("library");
    expect(ref.model).toBe("llama3.2");
    expect(ref.tag).toBe("1b");
  });

  it("parses references with registry.ollama.ai domain", () => {
    const ref = parseOllamaModelRef("registry.ollama.ai/library/llama3.2:1b");
    expect(ref.namespace).toBe("library");
    expect(ref.model).toBe("llama3.2");
    expect(ref.tag).toBe("1b");
  });

  it("parses references with ollama.com domain", () => {
    const ref = parseOllamaModelRef("ollama.com/library/llama3.2:1b");
    expect(ref.namespace).toBe("library");
    expect(ref.model).toBe("llama3.2");
    expect(ref.tag).toBe("1b");
  });

  it("parses custom user namespaces", () => {
    const ref = parseOllamaModelRef("myuser/custom-model:v2.0");
    expect(ref.namespace).toBe("myuser");
    expect(ref.model).toBe("custom-model");
    expect(ref.tag).toBe("v2.0");
  });

  it("defaults missing tags to 'latest'", () => {
    const ref = parseOllamaModelRef("llama3.2");
    expect(ref.namespace).toBe("library");
    expect(ref.model).toBe("llama3.2");
    expect(ref.tag).toBe("latest");
  });

  it("resolves a live Ollama registry model and extracts metadata", async () => {
    // smollm:135m is a fast, small model on registry.ollama.ai
    const descriptor = await resolveOllamaRegistryModel("smollm:135m");

    expect(descriptor.name).toBe("smollm:135m");
    expect(descriptor.source).toBe("ollama-registry");
    expect(descriptor.repository).toBe("registry.ollama.ai/library/smollm");
    expect(descriptor.downloadUrl).toContain("https://registry.ollama.ai/v2/library/smollm/blobs/");
    expect(descriptor.expectedSha256).toBeDefined();
    expect(descriptor.expectedSha256?.length).toBe(64);
    expect(descriptor.sizeBytes).toBeGreaterThan(50_000_000); // ~91MB
    expect(descriptor.template).toBeDefined();
    expect(descriptor.parameters).toBeDefined();
    expect(descriptor.parameters?.stop).toBeDefined();
  });
});
