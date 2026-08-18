import type { ModelDescriptor } from "./registry.ts";
import type { ModelParameters } from "./manifest.ts";
import { normalizeModelName } from "../utils/paths.ts";
import { extractHexHash } from "../utils/hashing.ts";
import { logger } from "../utils/logging.ts";

export interface OllamaParsedRef {
  namespace: string;
  model: string;
  tag: string;
  originalInput: string;
}

export interface OllamaManifestLayer {
  mediaType: string;
  digest: string;
  size: number;
}

export interface OllamaManifestConfig {
  mediaType: string;
  digest: string;
  size: number;
}

export interface OllamaRegistryManifest {
  schemaVersion: number;
  mediaType: string;
  config: OllamaManifestConfig;
  layers: OllamaManifestLayer[];
}

/**
 * Parses an Ollama model reference string into namespace, model name, and tag.
 * Examples:
 * - "smollm:135m" -> { namespace: "library", model: "smollm", tag: "135m" }
 * - "ollama://deepseek-r1:8b" -> { namespace: "library", model: "deepseek-r1", tag: "8b" }
 * - "ollama:llama3.2:1b" -> { namespace: "library", model: "llama3.2", tag: "1b" }
 * - "registry.ollama.ai/library/llama3.2:1b" -> { namespace: "library", model: "llama3.2", tag: "1b" }
 * - "ollama.com/library/llama3.2:1b" -> { namespace: "library", model: "llama3.2", tag: "1b" }
 * - "username/custom:v1" -> { namespace: "username", model: "custom", tag: "v1" }
 * - "llama3.2" -> { namespace: "library", model: "llama3.2", tag: "latest" }
 */
export function parseOllamaModelRef(input: string): OllamaParsedRef {
  const originalInput = input.trim();
  let clean = originalInput;

  // Strip known URL / protocol prefixes
  clean = clean.replace(/^ollama:\/\//i, "");
  clean = clean.replace(/^ollama:/i, "");
  clean = clean.replace(/^https?:\/\//i, "");
  clean = clean.replace(/^(registry\.ollama\.ai|ollama\.com|ollama\.ai)\//i, "");

  let namespace = "library";
  let modelWithTag = clean;

  if (clean.includes("/")) {
    const slashIdx = clean.indexOf("/");
    namespace = clean.slice(0, slashIdx);
    modelWithTag = clean.slice(slashIdx + 1);
  }

  let model = modelWithTag;
  let tag = "latest";

  if (modelWithTag.includes(":")) {
    const colonIdx = modelWithTag.indexOf(":");
    model = modelWithTag.slice(0, colonIdx);
    tag = modelWithTag.slice(colonIdx + 1);
  }

  if (!model) {
    throw new Error(`Invalid Ollama model name: "${input}"`);
  }

  return {
    namespace: namespace || "library",
    model,
    tag: tag || "latest",
    originalInput,
  };
}

/**
 * Fetches an anonymous bearer token for Ollama registry if required.
 */
export async function getOllamaAuthToken(
  namespace: string,
  model: string,
  signal?: AbortSignal
): Promise<string | null> {
  const authUrl = `https://registry.ollama.ai/v2/auth/token?service=registry.ollama.ai&scope=repository:${namespace}/${model}:pull`;
  try {
    const res = await fetch(authUrl, {
      headers: { "User-Agent": "bun-ollama-lite/1.0" },
      signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.token || data.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Fetches the OCI manifest from registry.ollama.ai for a given namespace/model/tag.
 */
export async function fetchOllamaRegistryManifest(
  namespace: string,
  model: string,
  tag: string,
  options?: { signal?: AbortSignal; token?: string }
): Promise<{ manifest: OllamaRegistryManifest; token: string | null }> {
  let token = options?.token ?? null;
  const manifestUrl = `https://registry.ollama.ai/v2/${namespace}/${model}/manifests/${tag}`;

  const headers: Record<string, string> = {
    "User-Agent": "bun-ollama-lite/1.0",
    "Accept": "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res = await fetch(manifestUrl, { headers, signal: options?.signal });

  if (res.status === 401 && !token) {
    logger.debug(`Fetching authentication token for ${namespace}/${model}...`);
    token = await getOllamaAuthToken(namespace, model, options?.signal);
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      res = await fetch(manifestUrl, { headers, signal: options?.signal });
    }
  }

  if (!res.ok) {
    throw new Error(
      `Ollama registry returned HTTP ${res.status} (${res.statusText}) for model "${namespace}/${model}:${tag}"`
    );
  }

  const manifest: OllamaRegistryManifest = (await res.json()) as OllamaRegistryManifest;
  return { manifest, token };
}

/**
 * Fetches text content of a small metadata blob (e.g. template, system, license) from Ollama registry.
 */
export async function fetchOllamaBlobText(
  namespace: string,
  model: string,
  digest: string,
  token?: string | null,
  signal?: AbortSignal
): Promise<string> {
  const blobUrl = `https://registry.ollama.ai/v2/${namespace}/${model}/blobs/${digest}`;
  const headers: Record<string, string> = {
    "User-Agent": "bun-ollama-lite/1.0",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(blobUrl, { headers, signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch blob ${digest}: HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * Fetches and parses a JSON metadata blob from Ollama registry.
 */
export async function fetchOllamaBlobJson<T = any>(
  namespace: string,
  model: string,
  digest: string,
  token?: string | null,
  signal?: AbortSignal
): Promise<T> {
  const text = await fetchOllamaBlobText(namespace, model, digest, token, signal);
  return JSON.parse(text) as T;
}

/**
 * Resolves a model name against registry.ollama.ai.
 * Downloads metadata layers (params, template, config) and prepares the model descriptor.
 */
export async function resolveOllamaRegistryModel(
  modelInput: string,
  options?: { signal?: AbortSignal }
): Promise<ModelDescriptor> {
  const ref = parseOllamaModelRef(modelInput);
  logger.info(`Querying Ollama registry for ${ref.namespace}/${ref.model}:${ref.tag}...`);

  const { manifest, token } = await fetchOllamaRegistryManifest(
    ref.namespace,
    ref.model,
    ref.tag,
    { signal: options?.signal }
  );

  // Find model layer (raw GGUF weights)
  const modelLayer = manifest.layers.find(
    (l) => l.mediaType === "application/vnd.ollama.image.model"
  );

  if (!modelLayer) {
    throw new Error(
      `No model layer (GGUF) found in Ollama registry manifest for "${ref.namespace}/${ref.model}:${ref.tag}"`
    );
  }

  // Find metadata layers
  const paramsLayer = manifest.layers.find(
    (l) => l.mediaType === "application/vnd.ollama.image.params"
  );
  const templateLayer = manifest.layers.find(
    (l) => l.mediaType === "application/vnd.ollama.image.template"
  );
  const systemLayer = manifest.layers.find(
    (l) => l.mediaType === "application/vnd.ollama.image.system"
  );
  const licenseLayer = manifest.layers.find(
    (l) => l.mediaType === "application/vnd.ollama.image.license"
  );

  let paramsData: Record<string, any> | undefined;
  let templateText: string | undefined;
  let systemText: string | undefined;
  let licenseText: string | undefined;
  let configData: Record<string, any> | undefined;

  // Fetch metadata layers in parallel
  const metadataTasks: Promise<void>[] = [];

  if (paramsLayer) {
    metadataTasks.push(
      fetchOllamaBlobJson(ref.namespace, ref.model, paramsLayer.digest, token, options?.signal)
        .then((data) => {
          paramsData = data;
        })
        .catch((err) => {
          logger.debug(`Could not fetch params layer: ${err.message}`);
        })
    );
  }

  if (templateLayer) {
    metadataTasks.push(
      fetchOllamaBlobText(ref.namespace, ref.model, templateLayer.digest, token, options?.signal)
        .then((text) => {
          templateText = text;
        })
        .catch((err) => {
          logger.debug(`Could not fetch template layer: ${err.message}`);
        })
    );
  }

  if (systemLayer) {
    metadataTasks.push(
      fetchOllamaBlobText(ref.namespace, ref.model, systemLayer.digest, token, options?.signal)
        .then((text) => {
          systemText = text;
        })
        .catch((err) => {
          logger.debug(`Could not fetch system layer: ${err.message}`);
        })
    );
  }

  if (licenseLayer) {
    metadataTasks.push(
      fetchOllamaBlobText(ref.namespace, ref.model, licenseLayer.digest, token, options?.signal)
        .then((text) => {
          licenseText = text;
        })
        .catch((err) => {
          logger.debug(`Could not fetch license layer: ${err.message}`);
        })
    );
  }

  if (manifest.config?.digest) {
    metadataTasks.push(
      fetchOllamaBlobJson(ref.namespace, ref.model, manifest.config.digest, token, options?.signal)
        .then((data) => {
          configData = data;
        })
        .catch((err) => {
          logger.debug(`Could not fetch config layer: ${err.message}`);
        })
    );
  }

  await Promise.all(metadataTasks);

  const modelHexHash = extractHexHash(modelLayer.digest);
  const downloadUrl = `https://registry.ollama.ai/v2/${ref.namespace}/${ref.model}/blobs/${modelLayer.digest}`;

  const displayName =
    ref.namespace === "library"
      ? `${ref.model}:${ref.tag}`
      : `${ref.namespace}/${ref.model}:${ref.tag}`;

  const contextSize =
    paramsData?.num_ctx ||
    paramsData?.context_size ||
    2048;

  const quantization = configData?.file_type || "Q4_0";

  const modelParams: ModelParameters = {
    context_size: contextSize,
    ...(paramsData || {}),
  };

  if (systemText) {
    modelParams.system_prompt = systemText;
  }

  return {
    name: displayName,
    normalizedName: normalizeModelName(displayName),
    repository: `registry.ollama.ai/${ref.namespace}/${ref.model}`,
    quantization,
    filename: `${ref.model}-${ref.tag}.gguf`,
    downloadUrl,
    expectedSha256: modelHexHash,
    sizeBytes: modelLayer.size,
    context: contextSize,
    source: "ollama-registry",
    template: templateText,
    system: systemText,
    license: licenseText,
    parameters: modelParams,
  };
}
