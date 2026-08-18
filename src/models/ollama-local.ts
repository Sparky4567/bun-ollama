import fs from "node:fs";
import path from "node:path";
import { type Config, loadConfig } from "../config.ts";
import { type ModelManifest, createManifest, type ModelParameters } from "./manifest.ts";
import { getBlobPath, saveManifest, getManifest } from "./storage.ts";
import { expandPath, normalizeModelName } from "../utils/paths.ts";
import { extractHexHash, formatDigest } from "../utils/hashing.ts";
import { logger } from "../utils/logging.ts";

export interface DiscoveredOllamaModel {
  name: string;
  normalizedName: string;
  registry: string;
  namespace: string;
  model: string;
  tag: string;
  manifestPath: string;
  modelDigest: string;
  modelBlobPath: string;
  size: number;
  quantization: string;
  parameters?: ModelParameters;
  template?: string;
  system?: string;
  license?: string;
}

export interface ImportOllamaOptions {
  mode?: "symlink" | "copy";
  config?: Config;
  targetName?: string;
}

export interface ImportAllSummary {
  discoveredCount: number;
  imported: ModelManifest[];
  skipped: string[];
  errors: Array<{ model: string; error: string }>;
}

/**
 * Searches standard system paths for an active Ollama models directory.
 */
export function detectOllamaDirectory(customPath?: string): string | null {
  const candidates: string[] = [];

  if (customPath) {
    candidates.push(expandPath(customPath));
  }

  if (process.env.OLLAMA_MODELS) {
    candidates.push(expandPath(process.env.OLLAMA_MODELS));
  }

  candidates.push(
    expandPath("~/.ollama/models"),
    expandPath("~/.ollama"),
    "/usr/share/ollama/.ollama/models",
    "/var/lib/ollama/.ollama/models",
    "/usr/share/ollama/models"
  );

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const manifestsDir = path.join(candidate, "manifests");
        const blobsDir = path.join(candidate, "blobs");

        if (fs.existsSync(manifestsDir) || fs.existsSync(blobsDir)) {
          return candidate;
        }

        // If candidate itself is a models dir inside .ollama
        const subModels = path.join(candidate, "models");
        if (fs.existsSync(path.join(subModels, "manifests")) || fs.existsSync(path.join(subModels, "blobs"))) {
          return subModels;
        }
      }
    } catch {
      // Continue search
    }
  }

  return null;
}

/**
 * Recursively retrieves all leaf files inside a directory.
 */
function getAllFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Safely reads string content from a local Ollama blob.
 */
function readBlobText(blobsDir: string, digest: string): string | undefined {
  const hash = extractHexHash(digest);
  const blobPath = path.join(blobsDir, `sha256-${hash}`);
  if (!fs.existsSync(blobPath)) {
    const altPath = path.join(blobsDir, `sha256:${hash}`);
    if (fs.existsSync(altPath)) {
      try {
        return fs.readFileSync(altPath, "utf-8");
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  try {
    return fs.readFileSync(blobPath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Scans the local Ollama installation and discovers all available models.
 */
export async function scanLocalOllamaModels(customOllamaDir?: string): Promise<DiscoveredOllamaModel[]> {
  const ollamaRoot = detectOllamaDirectory(customOllamaDir);
  if (!ollamaRoot) {
    logger.debug("No local Ollama directory detected.");
    return [];
  }

  const manifestsDir = path.join(ollamaRoot, "manifests");
  const blobsDir = path.join(ollamaRoot, "blobs");

  if (!fs.existsSync(manifestsDir)) {
    logger.debug(`Manifests directory does not exist at: ${manifestsDir}`);
    return [];
  }

  const manifestFiles = getAllFilesRecursive(manifestsDir);
  const discovered: DiscoveredOllamaModel[] = [];

  for (const filePath of manifestFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const manifestJson = JSON.parse(content);

      if (!manifestJson.layers || !Array.isArray(manifestJson.layers)) {
        continue;
      }

      // Find model layer
      const modelLayer = manifestJson.layers.find(
        (l: any) => l.mediaType === "application/vnd.ollama.image.model"
      );

      if (!modelLayer || !modelLayer.digest) {
        continue;
      }

      const modelHash = extractHexHash(modelLayer.digest);
      let blobPath = path.join(blobsDir, `sha256-${modelHash}`);

      if (!fs.existsSync(blobPath)) {
        const altPath = path.join(blobsDir, `sha256:${modelHash}`);
        if (fs.existsSync(altPath)) {
          blobPath = altPath;
        } else {
          logger.warn(`Model blob missing for manifest ${filePath}: ${blobPath}`);
          continue;
        }
      }

      // Calculate relative path from manifests root to parse registry/namespace/model/tag
      const relPath = path.relative(manifestsDir, filePath);
      const parts = relPath.split(path.sep);

      let registry = "registry.ollama.ai";
      let namespace = "library";
      let model = "";
      let tag = "latest";

      if (parts.length >= 4) {
        // e.g. ["registry.ollama.ai", "library", "llama3.2", "1b"]
        registry = parts[0]!;
        namespace = parts[1]!;
        model = parts[2]!;
        tag = parts.slice(3).join("-");
      } else if (parts.length === 3) {
        // e.g. ["library", "llama3.2", "1b"]
        namespace = parts[0]!;
        model = parts[1]!;
        tag = parts[2]!;
      } else if (parts.length === 2) {
        // e.g. ["llama3.2", "1b"]
        model = parts[0]!;
        tag = parts[1]!;
      } else if (parts.length === 1) {
        model = parts[0]!;
      }

      const displayName =
        namespace === "library" ? `${model}:${tag}` : `${namespace}/${model}:${tag}`;

      // Read metadata layers if present
      const paramsLayer = manifestJson.layers.find(
        (l: any) => l.mediaType === "application/vnd.ollama.image.params"
      );
      const templateLayer = manifestJson.layers.find(
        (l: any) => l.mediaType === "application/vnd.ollama.image.template"
      );
      const systemLayer = manifestJson.layers.find(
        (l: any) => l.mediaType === "application/vnd.ollama.image.system"
      );
      const licenseLayer = manifestJson.layers.find(
        (l: any) => l.mediaType === "application/vnd.ollama.image.license"
      );

      let parameters: ModelParameters | undefined;
      let templateText: string | undefined;
      let systemText: string | undefined;
      let licenseText: string | undefined;
      let quantization = "Q4_0";

      if (paramsLayer?.digest) {
        const rawParams = readBlobText(blobsDir, paramsLayer.digest);
        if (rawParams) {
          try {
            const parsed = JSON.parse(rawParams);
            parameters = {
              context_size: parsed.num_ctx || parsed.context_size || 2048,
              ...parsed,
            };
          } catch {
            // Ignore parse error
          }
        }
      }

      if (templateLayer?.digest) {
        templateText = readBlobText(blobsDir, templateLayer.digest);
      }

      if (systemLayer?.digest) {
        systemText = readBlobText(blobsDir, systemLayer.digest);
      }

      if (licenseLayer?.digest) {
        licenseText = readBlobText(blobsDir, licenseLayer.digest);
      }

      if (manifestJson.config?.digest) {
        const rawConfig = readBlobText(blobsDir, manifestJson.config.digest);
        if (rawConfig) {
          try {
            const parsedCfg = JSON.parse(rawConfig);
            if (parsedCfg.file_type) {
              quantization = parsedCfg.file_type;
            }
          } catch {
            // Ignore parse error
          }
        }
      }

      discovered.push({
        name: displayName,
        normalizedName: normalizeModelName(displayName),
        registry,
        namespace,
        model,
        tag,
        manifestPath: filePath,
        modelDigest: formatDigest(modelHash),
        modelBlobPath: blobPath,
        size: modelLayer.size || fs.statSync(blobPath).size,
        quantization,
        parameters: parameters || { context_size: 2048 },
        template: templateText,
        system: systemText,
        license: licenseText,
      });
    } catch (err: any) {
      logger.warn(`Failed to parse local Ollama manifest ${filePath}: ${err.message}`);
    }
  }

  return discovered;
}

/**
 * Imports a single discovered local Ollama model into Ollama Lite.
 * By default creates a symlink to the model blob to avoid duplicating gigabytes of disk space.
 */
export async function importLocalOllamaModel(
  discovered: DiscoveredOllamaModel,
  options?: ImportOllamaOptions
): Promise<ModelManifest> {
  const cfg = options?.config || loadConfig();
  const mode = options?.mode || "symlink";
  const targetName = options?.targetName || discovered.name;

  if (!fs.existsSync(discovered.modelBlobPath)) {
    throw new Error(`Source Ollama blob does not exist at: ${discovered.modelBlobPath}`);
  }

  const targetBlobPath = getBlobPath(discovered.modelDigest, cfg.modelsDir);
  const targetBlobsDir = path.dirname(targetBlobPath);

  if (!fs.existsSync(targetBlobsDir)) {
    fs.mkdirSync(targetBlobsDir, { recursive: true });
  }

  // Link or copy blob if it doesn't already exist in Ollama Lite
  if (!fs.existsSync(targetBlobPath)) {
    if (mode === "copy") {
      logger.info(`Copying blob for ${targetName} (${discovered.modelDigest})...`);
      fs.copyFileSync(discovered.modelBlobPath, targetBlobPath);
    } else {
      logger.info(`Creating symlink for ${targetName} (${discovered.modelDigest})...`);
      try {
        fs.symlinkSync(discovered.modelBlobPath, targetBlobPath);
      } catch (err: any) {
        // If symlink fails (e.g. permissions or cross-device), fallback to copy
        logger.warn(`Symlink creation failed (${err.message}). Falling back to copy.`);
        fs.copyFileSync(discovered.modelBlobPath, targetBlobPath);
      }
    }
  }

  const manifest = createManifest({
    name: targetName,
    digest: discovered.modelDigest,
    size: discovered.size,
    quantization: discovered.quantization,
    repository: `${discovered.registry}/${discovered.namespace}/${discovered.model}`,
    filename: `${discovered.model}-${discovered.tag}.gguf`,
    blobPath: targetBlobPath,
    parameters: discovered.parameters,
    template: discovered.template,
    system: discovered.system,
    license: discovered.license,
    source: "ollama-local",
  });

  await saveManifest(manifest, cfg);
  logger.info(`Imported model manifest for "${manifest.name}"`);

  return manifest;
}

/**
 * Discovers and imports all local Ollama models.
 */
export async function importAllLocalOllamaModels(options?: {
  ollamaDir?: string;
  mode?: "symlink" | "copy";
  config?: Config;
  overwrite?: boolean;
}): Promise<ImportAllSummary> {
  const cfg = options?.config || loadConfig();
  const mode = options?.mode || "symlink";
  const overwrite = options?.overwrite ?? false;

  const discovered = await scanLocalOllamaModels(options?.ollamaDir);
  const imported: ModelManifest[] = [];
  const skipped: string[] = [];
  const errors: Array<{ model: string; error: string }> = [];

  for (const model of discovered) {
    try {
      const existing = await getManifest(model.name, cfg);
      if (existing && !overwrite) {
        skipped.push(model.name);
        continue;
      }

      const manifest = await importLocalOllamaModel(model, {
        mode,
        config: cfg,
      });
      imported.push(manifest);
    } catch (err: any) {
      errors.push({ model: model.name, error: err.message });
    }
  }

  return {
    discoveredCount: discovered.length,
    imported,
    skipped,
    errors,
  };
}
