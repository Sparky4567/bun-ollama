import { describe, it, expect } from "bun:test";
import { resolveModel } from "../src/models/resolver.ts";

describe("Model Resolver", () => {
  it("resolves catalog aliases like llama3.2:1b", async () => {
    const desc = await resolveModel("llama3.2:1b");
    expect(desc.name).toBe("llama3.2:1b");
    expect(desc.repository).toBe("bartowski/Llama-3.2-1B-Instruct-GGUF");
    expect(desc.quantization).toBe("Q4_K_M");
    expect(desc.filename).toBe("Llama-3.2-1B-Instruct-Q4_K_M.gguf");
    expect(desc.downloadUrl).toBe("https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf");
  });

  it("resolves custom quantization tags on catalog aliases", async () => {
    const desc = await resolveModel("llama3.2:1b:Q8_0");
    expect(desc.quantization).toBe("Q8_0");
    expect(desc.filename).toBe("Llama-3.2-1B-Instruct-Q8_0.gguf");
  });

  it("resolves direct HTTP URLs", async () => {
    const url = "https://example.com/models/custom-model.gguf";
    const desc = await resolveModel(url);
    expect(desc.name).toBe(url);
    expect(desc.filename).toBe("custom-model.gguf");
    expect(desc.downloadUrl).toBe(url);
  });
});
