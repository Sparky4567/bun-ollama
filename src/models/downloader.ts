import fs from "node:fs";
import path from "node:path";
import { resolveModel } from "./resolver.ts";
import { type ModelManifest, createManifest } from "./manifest.ts";
import { getBlobPath, saveManifest } from "./storage.ts";
import { type Config, loadConfig } from "../config.ts";
import { createIncrementalHasher, formatDigest } from "../utils/hashing.ts";
import { logger } from "../utils/logging.ts";

export interface DownloadProgress {
  model: string;
  totalBytes: number;
  downloadedBytes: number;
  percent: number;
  speedBytesPerSec: number;
  elapsedSeconds: number;
  status: "resolving" | "downloading" | "verifying" | "storing" | "completed" | "error";
  error?: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Downloads a model GGUF file from Hugging Face or direct URL with streaming SHA-256 calculation.
 */
export async function downloadModel(
  modelInput: string,
  options?: {
    config?: Config;
    onProgress?: ProgressCallback;
    abortSignal?: AbortSignal;
  }
): Promise<ModelManifest> {
  const cfg = options?.config || loadConfig();
  const onProgress = options?.onProgress;

  onProgress?.({
    model: modelInput,
    totalBytes: 0,
    downloadedBytes: 0,
    percent: 0,
    speedBytesPerSec: 0,
    elapsedSeconds: 0,
    status: "resolving",
  });

  logger.info(`Resolving remote model: ${modelInput}`);
  const descriptor = await resolveModel(modelInput, cfg.defaultQuantization);

  // If this is an Ollama Cloud model, register manifest directly
  if (descriptor.isCloud || descriptor.source === "ollama-cloud") {
    const manifest = createManifest({
      name: descriptor.name,
      digest: descriptor.expectedSha256 ? `sha256:${descriptor.expectedSha256}` : `sha256:${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
      size: descriptor.sizeBytes || 0,
      quantization: descriptor.quantization,
      repository: descriptor.repository,
      filename: descriptor.filename || "(cloud)",
      blobPath: "",
      format: "cloud",
      parameters: descriptor.parameters || {
        context_size: descriptor.context || 131072,
      },
      template: descriptor.template,
      system: descriptor.system,
      license: descriptor.license,
      source: "ollama-cloud",
      isCloud: true,
      remoteHost: descriptor.remoteHost || "https://ollama.com",
      remoteModel: descriptor.remoteModel || descriptor.name,
      capabilities: descriptor.capabilities,
    });

    await saveManifest(manifest, cfg);
    logger.info(`Ollama Cloud model manifest saved for ${manifest.name}`);

    onProgress?.({
      model: descriptor.name,
      totalBytes: 0,
      downloadedBytes: 0,
      percent: 100,
      speedBytesPerSec: 0,
      elapsedSeconds: 0,
      status: "completed",
    });

    return manifest;
  }

  if (!descriptor.downloadUrl) {
    throw new Error(`Could not determine download URL for model "${modelInput}"`);
  }

  logger.info(`Fetching model from ${descriptor.downloadUrl}`);

  const response = await fetch(descriptor.downloadUrl, {
    headers: {
      "User-Agent": "bun-ollama-lite/1.0",
    },
    signal: options?.abortSignal,
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download model from ${descriptor.downloadUrl}: HTTP ${response.status} (${response.statusText})`
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : (descriptor.sizeBytes || 0);

  // Temporary path while downloading
  const blobsDir = path.join(cfg.modelsDir, "blobs");
  if (!fs.existsSync(blobsDir)) {
    fs.mkdirSync(blobsDir, { recursive: true });
  }

  const tempFilename = `download-${Date.now()}-${Math.random().toString(36).slice(2)}.part`;
  const tempFilePath = path.join(blobsDir, tempFilename);
  const fileWriter = fs.createWriteStream(tempFilePath);

  const hasher = createIncrementalHasher();
  let downloadedBytes = 0;
  const startTime = Date.now();
  let lastProgressUpdate = 0;

  try {
    const reader = response.body.getReader();

    while (true) {
      if (options?.abortSignal?.aborted) {
        throw new Error("Download aborted");
      }

      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        // Stream chunk to hasher and disk
        hasher.update(value);
        fileWriter.write(Buffer.from(value));
        downloadedBytes += value.length;

        const now = Date.now();
        // Throttle progress callbacks to every 100ms
        if (now - lastProgressUpdate > 100 || downloadedBytes === totalBytes) {
          lastProgressUpdate = now;
          const elapsedSeconds = Math.max(0.001, (now - startTime) / 1000);
          const speedBytesPerSec = downloadedBytes / elapsedSeconds;
          const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

          onProgress?.({
            model: descriptor.name,
            totalBytes,
            downloadedBytes,
            percent,
            speedBytesPerSec,
            elapsedSeconds,
            status: "downloading",
          });
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileWriter.end((err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    onProgress?.({
      model: descriptor.name,
      totalBytes,
      downloadedBytes,
      percent: 100,
      speedBytesPerSec: downloadedBytes / Math.max(0.001, (Date.now() - startTime) / 1000),
      elapsedSeconds: (Date.now() - startTime) / 1000,
      status: "verifying",
    });

    const calculatedHash = hasher.digest("hex");
    const digest = formatDigest(calculatedHash);
    logger.info(`Download complete. SHA-256: ${calculatedHash}`);

    // If an expected SHA-256 was provided, verify it
    if (descriptor.expectedSha256 && descriptor.expectedSha256 !== calculatedHash) {
      throw new Error(
        `Checksum verification failed for ${descriptor.name}! Expected ${descriptor.expectedSha256}, calculated ${calculatedHash}`
      );
    }

    // Move to final content-addressed blob location
    const finalBlobPath = getBlobPath(digest, cfg.modelsDir);

    if (fs.existsSync(finalBlobPath)) {
      // Blob already exists (same content downloaded before), delete temp
      fs.unlinkSync(tempFilePath);
    } else {
      fs.renameSync(tempFilePath, finalBlobPath);
    }

    // Create and save manifest
    const manifest = createManifest({
      name: descriptor.name,
      digest,
      size: downloadedBytes,
      quantization: descriptor.quantization,
      repository: descriptor.repository,
      filename: descriptor.filename,
      blobPath: finalBlobPath,
      parameters: descriptor.parameters || {
        context_size: descriptor.context || cfg.defaultContext,
      },
      template: descriptor.template,
      system: descriptor.system,
      license: descriptor.license,
      source: descriptor.source || "huggingface",
    });

    await saveManifest(manifest, cfg);
    logger.info(`Model manifest saved for ${manifest.name}`);

    onProgress?.({
      model: descriptor.name,
      totalBytes,
      downloadedBytes,
      percent: 100,
      speedBytesPerSec: downloadedBytes / Math.max(0.001, (Date.now() - startTime) / 1000),
      elapsedSeconds: (Date.now() - startTime) / 1000,
      status: "completed",
    });

    return manifest;
  } catch (err: any) {
    try {
      fileWriter.close();
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {
      // Ignore cleanup error
    }

    onProgress?.({
      model: descriptor.name,
      totalBytes,
      downloadedBytes,
      percent: 0,
      speedBytesPerSec: 0,
      elapsedSeconds: (Date.now() - startTime) / 1000,
      status: "error",
      error: err.message,
    });

    throw err;
  }
}
