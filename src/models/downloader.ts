import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
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

/** Stores a verified content-addressed artifact; cached model/projector blobs are reused. */
export async function downloadBlob(artifact: { downloadUrl: string; expectedSha256?: string; sizeBytes?: number }, cfg: Config,
  options: { signal?: AbortSignal; onProgress?: (downloaded: number, total: number) => void } = {}
): Promise<{ digest: string; blob_path: string; size: number }> {
  options.signal?.throwIfAborted();
  if (artifact.expectedSha256) {
    const cached = getBlobPath(formatDigest(artifact.expectedSha256), cfg.modelsDir);
    if (fs.existsSync(cached) && (!artifact.sizeBytes || fs.statSync(cached).size === artifact.sizeBytes)) {
      const size = fs.statSync(cached).size;
      options.onProgress?.(size, size);
      return { digest: formatDigest(artifact.expectedSha256), blob_path: cached, size };
    }
  }
  const response = await fetch(artifact.downloadUrl, { headers: { "User-Agent": "bun-ollama-lite/1.0" }, signal: options.signal });
  if (!response.ok || !response.body) throw new Error(`Failed to download ${artifact.downloadUrl}: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || artifact.sizeBytes || 0;
  const dir = path.join(cfg.modelsDir, "blobs");
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `download-${crypto.randomUUID()}.part`);
  const writer = fs.createWriteStream(temporary);
  // Track errors even between writes, so disk failures cannot become unhandled events.
  let writeError: Error | undefined;
  writer.on("error", error => { writeError = error; });
  const hasher = createIncrementalHasher();
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (writeError) throw writeError;
      hasher.update(value);
      if (!writer.write(value)) await once(writer, "drain");
      size += value.length;
      options.onProgress?.(size, total);
    }
    if (writeError) throw writeError;
    const finished = once(writer, "finish");
    writer.end();
    await finished;
    if (writeError) throw writeError;
    const hash = hasher.digest("hex");
    if (artifact.expectedSha256 && artifact.expectedSha256 !== hash) throw new Error(`Checksum verification failed! Expected ${artifact.expectedSha256}, calculated ${hash}`);
    if (artifact.sizeBytes && artifact.sizeBytes !== size) throw new Error(`Incomplete download: expected ${artifact.sizeBytes} bytes, received ${size}`);
    const digest = formatDigest(hash);
    const blob_path = getBlobPath(digest, cfg.modelsDir);
    if (fs.existsSync(blob_path) && fs.statSync(blob_path).size === size) fs.unlinkSync(temporary);
    else fs.renameSync(temporary, blob_path);
    return { digest, blob_path, size };
  } catch (error) {
    await reader.cancel().catch(() => {});
    writer.destroy();
    // Wait for the file handle to close before removing on Windows.
    if (!writer.closed) await once(writer, "close").catch(() => {});
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  } finally { reader.releaseLock(); }
}

export async function downloadModel(modelInput: string, options?: {
  config?: Config; onProgress?: ProgressCallback; abortSignal?: AbortSignal;
}): Promise<ModelManifest> {
  const cfg = options?.config || loadConfig();
  const started = Date.now();
  let lastProgress = 0;
  const emit = (status: DownloadProgress['status'], downloadedBytes = 0, totalBytes = 0, error?: string) => {
    const elapsedSeconds = Math.max(0.001, (Date.now() - started) / 1000);
    options?.onProgress?.({ model: modelInput, status, downloadedBytes, totalBytes,
      percent: status === 'completed' ? 100 : totalBytes ? Math.min(100, Math.round(downloadedBytes / totalBytes * 100)) : 0,
      elapsedSeconds, speedBytesPerSec: downloadedBytes / elapsedSeconds, error });
  };
  emit('resolving');
  try {
    logger.info(`Resolving remote model: ${modelInput}`);
    const descriptor = await resolveModel(modelInput, cfg.defaultQuantization);
    options?.abortSignal?.throwIfAborted();
    const cloud = descriptor.isCloud || descriptor.source === 'ollama-cloud';
    let modelBlob: { digest: string; blob_path: string; size: number };
    let projector: ModelManifest['projector'];
    if (cloud) {
      modelBlob = { digest: `sha256:${descriptor.expectedSha256 || crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')}`, blob_path: '', size: 0 };
    } else {
      if (!descriptor.downloadUrl) throw new Error(`Could not determine download URL for model "${modelInput}"`);
      const total = (descriptor.sizeBytes || 0) + (descriptor.projector?.sizeBytes || 0);
      let offset = 0;
      const progress = (bytes: number, artifactTotal: number) => {
        if (Date.now() - lastProgress < 100 && bytes !== artifactTotal) return;
        lastProgress = Date.now();
        emit('downloading', offset + bytes, total || artifactTotal);
      };
      modelBlob = await downloadBlob({ ...descriptor, downloadUrl: descriptor.downloadUrl }, cfg, { signal: options?.abortSignal, onProgress: progress });
      offset = modelBlob.size;
      if (descriptor.projector) {
        logger.info(`Downloading vision projector for ${descriptor.name}`);
        projector = await downloadBlob(descriptor.projector, cfg, { signal: options?.abortSignal, onProgress: progress });
      }
      emit('verifying', offset + (projector?.size || 0), total);
    }
    // Publish only after every required artifact is available and checksum verified.
    const manifest = createManifest({ name: descriptor.name, digest: modelBlob.digest,
      size: modelBlob.size + (projector?.size || 0), quantization: descriptor.quantization,
      repository: descriptor.repository, filename: descriptor.filename || '(cloud)', blobPath: modelBlob.blob_path,
      format: cloud ? 'cloud' : 'gguf', parameters: descriptor.parameters || { context_size: descriptor.context || cfg.defaultContext },
      template: descriptor.template, system: descriptor.system, license: descriptor.license,
      source: descriptor.source || 'huggingface', isCloud: Boolean(cloud), remoteHost: descriptor.remoteHost,
      remoteModel: descriptor.remoteModel, capabilities: descriptor.capabilities, projector });
    emit('storing', manifest.size, manifest.size);
    await saveManifest(manifest, cfg);
    emit('completed', manifest.size, manifest.size);
    return manifest;
  } catch (error) { emit('error', 0, 0, (error as Error).message); throw error; }
}
