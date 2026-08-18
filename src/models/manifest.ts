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
  format: "gguf" | "cloud";
  quantization: string;
  repository: string;
  filename: string;
  blob_path: string;
  modified_at: string;
  parameters?: ModelParameters;
  template?: string;
  system?: string;
  license?: string;
  source?: "huggingface" | "ollama-registry" | "ollama-local" | "direct-url" | "ollama-cloud";
  is_cloud?: boolean;
  remote_host?: string;
  remote_model?: string;
  capabilities?: string[];
}

export function createManifest(params: {
  name: string;
  digest: string;
  size: number;
  quantization: string;
  repository: string;
  filename: string;
  blobPath: string;
  format?: "gguf" | "cloud";
  parameters?: ModelParameters;
  template?: string;
  system?: string;
  license?: string;
  source?: "huggingface" | "ollama-registry" | "ollama-local" | "direct-url" | "ollama-cloud";
  isCloud?: boolean;
  remoteHost?: string;
  remoteModel?: string;
  capabilities?: string[];
}): ModelManifest {
  const isCloud = Boolean(params.isCloud || params.source === "ollama-cloud" || params.format === "cloud");
  return {
    name: params.name,
    digest: params.digest,
    size: params.size,
    format: params.format || (isCloud ? "cloud" : "gguf"),
    quantization: params.quantization,
    repository: params.repository,
    filename: params.filename,
    blob_path: params.blobPath,
    modified_at: new Date().toISOString(),
    parameters: params.parameters || { context_size: isCloud ? 131072 : 2048 },
    template: params.template,
    system: params.system,
    license: params.license,
    source: params.source,
    is_cloud: isCloud,
    remote_host: params.remoteHost,
    remote_model: params.remoteModel,
    capabilities: params.capabilities,
  };
}
