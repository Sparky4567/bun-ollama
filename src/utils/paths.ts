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
