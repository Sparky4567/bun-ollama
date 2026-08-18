import type { ModelParameters } from "./manifest.ts";

export interface ModelDescriptor {
  name: string;
  normalizedName: string;
  repository: string;
  quantization: string;
  filename: string;
  downloadUrl?: string;
  context?: number;
  expectedSha256?: string;
  sizeBytes?: number;
  source?: "huggingface" | "ollama-registry" | "ollama-local" | "direct-url" | "ollama-cloud";
  template?: string;
  system?: string;
  license?: string;
  parameters?: ModelParameters;
  isCloud?: boolean;
  remoteHost?: string;
  remoteModel?: string;
  capabilities?: string[];
}

export interface ModelAlias {
  repo: string;
  defaultQuant: string;
  context: number;
  files: Record<string, string>; // quant -> filename
}

/**
 * Built-in registry of well-known models and default quantization mappings.
 */
export const MODEL_CATALOG: Record<string, ModelAlias> = {
  "llama3.2:1b": {
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
      "Q8_0": "Llama-3.2-1B-Instruct-Q8_0.gguf",
      "Q5_K_M": "Llama-3.2-1B-Instruct-Q5_K_M.gguf",
      "F16": "Llama-3.2-1B-Instruct-f16.gguf",
    },
  },
  "llama3.2": {
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
      "Q8_0": "Llama-3.2-1B-Instruct-Q8_0.gguf",
      "Q5_K_M": "Llama-3.2-1B-Instruct-Q5_K_M.gguf",
    },
  },
  "llama3.2:latest": {
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    },
  },
  "llama3.2:3b": {
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
      "Q8_0": "Llama-3.2-3B-Instruct-Q8_0.gguf",
      "Q5_K_M": "Llama-3.2-3B-Instruct-Q5_K_M.gguf",
    },
  },
  "qwen2.5:0.5b": {
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
      "Q8_0": "qwen2.5-0.5b-instruct-q8_0.gguf",
    },
  },
  "qwen3:0.6b": {
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
      "Q8_0": "qwen2.5-0.5b-instruct-q8_0.gguf",
    },
  },
  "qwen2.5:1.5b": {
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Q8_0": "qwen2.5-1.5b-instruct-q8_0.gguf",
    },
  },
  "qwen2.5-coder:0.5b": {
    repo: "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
      "Q8_0": "qwen2.5-coder-0.5b-instruct-q8_0.gguf",
    },
  },
  "smollm2:135m": {
    repo: "unsloth/SmolLM2-135M-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "SmolLM2-135M-Instruct-Q4_K_M.gguf",
      "Q8_0": "SmolLM2-135M-Instruct-Q8_0.gguf",
    },
  },
  "smollm2:360m": {
    repo: "unsloth/SmolLM2-360M-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "SmolLM2-360M-Instruct-Q4_K_M.gguf",
      "Q8_0": "SmolLM2-360M-Instruct-Q8_0.gguf",
    },
  },
  "smollm:135m": {
    repo: "unsloth/SmolLM2-135M-Instruct-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "SmolLM2-135M-Instruct-Q4_K_M.gguf",
    },
  },
  "gemma2:2b": {
    repo: "bartowski/gemma-2-2b-it-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "gemma-2-2b-it-Q4_K_M.gguf",
      "Q8_0": "gemma-2-2b-it-Q8_0.gguf",
    },
  },
  "gemma3:270m": {
    repo: "bartowski/gemma-2-2b-it-GGUF",
    defaultQuant: "Q4_K_M",
    context: 2048,
    files: {
      "Q4_K_M": "gemma-2-2b-it-Q4_K_M.gguf",
    },
  },
};
