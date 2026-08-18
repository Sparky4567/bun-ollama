export interface ModelParameters {
  context_size?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  system_prompt?: string;
  template?: string;
  stop?: string[];
  [key: string]: any;
}

export interface ModelManifest {
  name: string;
  digest: string; // e.g. "sha256:abc123..."
  size: number;
  format: "gguf";
  quantization: string;
  repository: string;
  filename: string;
  blob_path: string;
  modified_at: string;
  parameters?: ModelParameters;
  template?: string;
  system?: string;
  license?: string;
  source?: "huggingface" | "ollama-registry" | "ollama-local" | "direct-url";
}

export function createManifest(params: {
  name: string;
  digest: string;
  size: number;
  quantization: string;
  repository: string;
  filename: string;
  blobPath: string;
  parameters?: ModelParameters;
  template?: string;
  system?: string;
  license?: string;
  source?: "huggingface" | "ollama-registry" | "ollama-local" | "direct-url";
}): ModelManifest {
  return {
    name: params.name,
    digest: params.digest,
    size: params.size,
    format: "gguf",
    quantization: params.quantization,
    repository: params.repository,
    filename: params.filename,
    blob_path: params.blobPath,
    modified_at: new Date().toISOString(),
    parameters: params.parameters || { context_size: 2048 },
    template: params.template,
    system: params.system,
    license: params.license,
    source: params.source,
  };
}
