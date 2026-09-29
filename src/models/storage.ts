import fs from "node:fs";
import path from "node:path";
import type { ModelManifest } from "./manifest.ts";
import { type Config, loadConfig } from "../config.ts";
import {
  getDefaultBlobsDir,
  getDefaultManifestsDir,
  normalizeModelName,
  canonicalModelName,
} from "../utils/paths.ts";
import { extractHexHash } from "../utils/hashing.ts";
import { logger } from "../utils/logging.ts";

/**
 * Returns the filepath for a model's JSON manifest.
 * The model reference is canonicalized first so `ollama:gemma3:270m` and
 * `gemma3:270m` resolve to the same file.
 */
export function getManifestPath(modelName: string, modelsDir?: string): string {
  const manifestsDir = getDefaultManifestsDir(modelsDir);
  const normalized = normalizeModelName(canonicalModelName(modelName));
  return path.join(manifestsDir, `${normalized}.json`);
}

/**
 * Returns the filepath for a content-addressed blob.
 */
export function getBlobPath(digest: string, modelsDir?: string): string {
  const blobsDir = getDefaultBlobsDir(modelsDir);
  const hash = extractHexHash(digest);
  return path.join(blobsDir, `sha256-${hash}`);
}

/**
 * Reads the manifest for a model, if it exists.
 * Tries the canonical path first, then falls back to the raw normalized
 * path for backwards compatibility with any legacy prefixed files.
 */
export async function getManifest(
  modelName: string,
  config?: Config
): Promise<ModelManifest | null> {
  const cfg = config || loadConfig();
  const canonicalPath = getManifestPath(modelName, cfg.modelsDir);

  let legacyPath: string | null = null;
  try {
    const rawNormalized = normalizeModelName(modelName);
    const canonicalNormalized = normalizeModelName(canonicalModelName(modelName));
    if (rawNormalized !== canonicalNormalized) {
      legacyPath = path.join(
        getDefaultManifestsDir(cfg.modelsDir),
        `${rawNormalized}.json`
      );
    }
  } catch {
    legacyPath = null;
  }

  const candidates = legacyPath ? [canonicalPath, legacyPath] : [canonicalPath];

  for (const manifestPath of candidates) {
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    try {
      const content = await Bun.file(manifestPath).text();
      const manifest: ModelManifest = JSON.parse(content);

      // Verify blob exists for local GGUF models (cloud models do not have local blobs)
      const isCloud = Boolean(manifest.is_cloud || manifest.source === "ollama-cloud" || manifest.format === "cloud");
      if (!isCloud && !fs.existsSync(manifest.blob_path)) {
        logger.warn(`Manifest exists for ${modelName} but blob file ${manifest.blob_path} is missing.`);
        return null;
      }

      return manifest;
    } catch (err: any) {
      logger.warn(`Error reading manifest at ${manifestPath}: ${err.message}`);
      return null;
    }
  }

  return null;
}

/**
 * Checks if a model exists locally with a valid blob.
 */
export async function hasModel(modelName: string, config?: Config): Promise<boolean> {
  const manifest = await getManifest(modelName, config);
  return manifest !== null;
}

/**
 * Writes or updates a model manifest.
 * The manifest name is canonicalized so prefixed and bare references share
 * one entry (e.g. `ollama:gemma3:270m` -> `gemma3:270m`).
 */
export async function saveManifest(
  manifest: ModelManifest,
  config?: Config
): Promise<void> {
  const cfg = config || loadConfig();
  const canonicalName = canonicalModelName(manifest.name);
  const toSave: ModelManifest =
    canonicalName !== manifest.name ? { ...manifest, name: canonicalName } : manifest;
  const manifestPath = getManifestPath(toSave.name, cfg.modelsDir);
  const dir = path.dirname(manifestPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await Bun.write(manifestPath, JSON.stringify(toSave, null, 2));
}

/**
 * Lists all stored model manifests.
 */
export async function listManifests(config?: Config): Promise<ModelManifest[]> {
  const cfg = config || loadConfig();
  const manifestsDir = getDefaultManifestsDir(cfg.modelsDir);

  if (!fs.existsSync(manifestsDir)) {
    return [];
  }

  const files = fs.readdirSync(manifestsDir);
  const manifests: ModelManifest[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fullPath = path.join(manifestsDir, file);
    try {
      const content = await Bun.file(fullPath).text();
      const manifest: ModelManifest = JSON.parse(content);
      const isCloud = Boolean(manifest.is_cloud || manifest.source === "ollama-cloud" || manifest.format === "cloud");
      if (isCloud || (manifest.blob_path && fs.existsSync(manifest.blob_path))) {
        manifests.push(manifest);
      }
    } catch {
      // Ignore corrupted entries
    }
  }

  return manifests;
}

/**
 * Deletes a model manifest. If no other model references the blob, deletes the blob too.
 * Handles both canonical and legacy prefixed paths.
 */
export async function deleteModel(
  modelName: string,
  config?: Config
): Promise<boolean> {
  const cfg = config || loadConfig();
  const manifestPath = getManifestPath(modelName, cfg.modelsDir);

  let legacyPath: string | null = null;
  try {
    const rawNormalized = normalizeModelName(modelName);
    const canonicalNormalized = normalizeModelName(canonicalModelName(modelName));
    if (rawNormalized !== canonicalNormalized) {
      legacyPath = path.join(
        getDefaultManifestsDir(cfg.modelsDir),
        `${rawNormalized}.json`
      );
    }
  } catch {
    legacyPath = null;
  }

  const targetPath = fs.existsSync(manifestPath)
    ? manifestPath
    : legacyPath && fs.existsSync(legacyPath)
      ? legacyPath
      : null;

  if (!targetPath) {
    return false;
  }

  let blobPathToDelete: string | null = null;
  let isCloud = false;
  try {
    const content = await Bun.file(targetPath).text();
    const manifest: ModelManifest = JSON.parse(content);
    blobPathToDelete = manifest.blob_path;
    isCloud = Boolean(manifest.is_cloud || manifest.source === "ollama-cloud" || manifest.format === "cloud");
  } catch {
    // proceed to remove manifest
  }

  // Remove manifest file
  fs.unlinkSync(targetPath);
  // Also clean up the alternate spelling if both exist (canonical + legacy)
  if (legacyPath && legacyPath !== targetPath && fs.existsSync(legacyPath)) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // ignore
    }
  }
  logger.info(`Removed manifest for ${modelName}`);

  // Check if blob is still referenced by any other manifest
  if (!isCloud && blobPathToDelete && fs.existsSync(blobPathToDelete)) {
    const allManifests = await listManifests(cfg);
    const isReferenced = allManifests.some((m) => m.blob_path === blobPathToDelete);

    if (!isReferenced) {
      try {
        fs.unlinkSync(blobPathToDelete);
        logger.info(`Removed unreferenced blob ${blobPathToDelete}`);
      } catch (err: any) {
        logger.warn(`Could not delete blob ${blobPathToDelete}: ${err.message}`);
      }
    }
  }

  return true;
}
