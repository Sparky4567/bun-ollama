import os from "node:os";
import path from "node:path";

/**
 * Expands leading `~` in a file path to the user's home directory.
 */
export function expandPath(filepath: string): string {
  if (!filepath) return "";
  if (filepath === "~") return os.homedir();
  if (filepath.startsWith("~" + path.sep) || filepath.startsWith("~/")) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return path.resolve(filepath);
}

/**
 * Normalizes a model name for safe filesystem usage.
 * Replaces characters like ':' or '/' with '-' while preventing directory traversal.
 * Example: "llama3.2:1b" -> "llama3.2-1b"
 * Example: "bartowski/Llama-3.2-1B-Instruct-GGUF" -> "bartowski-llama-3.2-1b-instruct-gguf"
 */
export function normalizeModelName(modelName: string): string {
  if (!modelName) throw new Error("Model name cannot be empty");
  
  // Strip dangerous traversal characters
  let normalized = modelName.trim().toLowerCase();
  normalized = normalized.replace(/\.\./g, "");
  normalized = normalized.replace(/[:\\/]/g, "-");
  normalized = normalized.replace(/[^a-z0-9._-]/g, "-");
  normalized = normalized.replace(/-+/g, "-");
  normalized = normalized.replace(/^-|-$/g, "");
  
  if (!normalized) {
    throw new Error(`Invalid model name: "${modelName}"`);
  }
  
  return normalized;
}

/**
 * Canonicalizes a user-supplied model reference for storage/lookup.
 *
 * The Ollama registry resolver strips transport prefixes (`ollama:`,
 * `ollama://`, `registry.ollama.ai/`, `ollama.com/`, ...) and the default
 * `library/` namespace when building `descriptor.name` (e.g.
 * `ollama:gemma3:270m` resolves to `gemma3:270m`). If storage keys used the
 * raw input, `pull ollama:gemma3:270m` would save `gemma3-270m.json` while
 * `run ollama:gemma3:270m` would look for `ollama-gemma3-270m.json` and
 * re-download every time. Canonicalizing both sides to the display form
 * keeps pull/run/show/rm in sync.
 *
 * Non-Ollama inputs (catalog aliases, HF repos, direct URLs) are returned
 * trimmed and unchanged.
 */
export function canonicalModelName(input: string): string {
  if (!input) return input;
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  const isOllamaStyle =
    lower.startsWith("ollama://") ||
    lower.startsWith("ollama:") ||
    lower.startsWith("registry.ollama.ai/") ||
    lower.startsWith("ollama.com/") ||
    lower.startsWith("ollama.ai/") ||
    /^https?:\/\/(registry\.ollama\.ai|ollama\.com|ollama\.ai)\//i.test(trimmed);
  if (!isOllamaStyle) return trimmed;

  try {
    let clean = trimmed
      .replace(/^ollama:\/\//i, "")
      .replace(/^ollama:/i, "")
      .replace(/^https?:\/\//i, "")
      .replace(/^(registry\.ollama\.ai|ollama\.com|ollama\.ai)\//i, "");

    let namespace = "library";
    let modelWithTag = clean;
    if (clean.includes("/")) {
      const idx = clean.indexOf("/");
      const maybeNs = clean.slice(0, idx);
      if (maybeNs) {
        namespace = maybeNs;
        modelWithTag = clean.slice(idx + 1);
      }
    }
    if (!modelWithTag) return trimmed;

    let model = modelWithTag;
    let tag = "latest";
    if (modelWithTag.includes(":")) {
      const cIdx = modelWithTag.indexOf(":");
      const m = modelWithTag.slice(0, cIdx);
      const t = modelWithTag.slice(cIdx + 1);
      if (m) model = m;
      if (t) tag = t;
    }
    if (!model) return trimmed;

    // Mirror resolveOllamaRegistryModel displayName logic (exact "library" match).
    if (namespace === "library") {
      return `${model}:${tag}`;
    }
    return `${namespace}/${model}:${tag}`;
  } catch {
    return trimmed;
  }
}

/**
 * Validates that a target path is safely contained within an expected base directory.
 * Throws an error if path traversal is detected.
 */
export function validateSafePath(baseDir: string, targetPath: string): string {
  const resolvedBase = path.resolve(expandPath(baseDir));
  const resolvedTarget = path.resolve(expandPath(targetPath));

  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error(`Security error: path traversal detected for path "${targetPath}"`);
  }

  return resolvedTarget;
}

/**
 * Standard default paths for Ollama Lite.
 */
export function getDefaultBaseDir(): string {
  return expandPath(process.env.OLLAMA_LITE_HOME || "~/.ollama-lite");
}

export function getDefaultModelsDir(): string {
  return process.env.OLLAMA_LITE_MODELS
    ? expandPath(process.env.OLLAMA_LITE_MODELS)
    : path.join(getDefaultBaseDir(), "models");
}

export function getDefaultManifestsDir(modelsDir?: string): string {
  return path.join(modelsDir ? expandPath(modelsDir) : getDefaultModelsDir(), "manifests");
}

export function getDefaultBlobsDir(modelsDir?: string): string {
  return path.join(modelsDir ? expandPath(modelsDir) : getDefaultModelsDir(), "blobs");
}

export function getDefaultRuntimeDir(): string {
  return process.env.OLLAMA_LITE_RUNTIME
    ? expandPath(process.env.OLLAMA_LITE_RUNTIME)
    : path.join(getDefaultBaseDir(), "runtime");
}

export function getDefaultConfigPath(): string {
  return path.join(getDefaultBaseDir(), "config.json");
}
