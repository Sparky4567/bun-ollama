import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "../config.ts";
import { saveConfig } from "../config.ts";
import { expandPath, getDefaultBaseDir } from "../utils/paths.ts";
import { saveManifest, listManifests } from "../models/storage.ts";
import { createManifest } from "../models/manifest.ts";
import { logger } from "../utils/logging.ts";

/**
 * Returns the public key string from standard locations (~/.ollama-lite/id_ed25519.pub or ~/.ollama/id_ed25519.pub).
 */
export function getPublicKey(configDir?: string): string | null {
  const baseDir = configDir ? expandPath(configDir) : getDefaultBaseDir();
  const liteKeyPath = path.join(baseDir, "id_ed25519.pub");
  if (fs.existsSync(liteKeyPath)) {
    try {
      return fs.readFileSync(liteKeyPath, "utf-8").trim();
    } catch {
      // ignore
    }
  }

  const ollamaKeyPath = expandPath("~/.ollama/id_ed25519.pub");
  if (fs.existsSync(ollamaKeyPath)) {
    try {
      return fs.readFileSync(ollamaKeyPath, "utf-8").trim();
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Ensures an ed25519 SSH keypair exists in ~/.ollama-lite or returns existing key.
 */
export function getOrCreateKeypair(configDir?: string): {
  publicKey: string;
  publicKeyPath: string;
  privateKeyPath: string;
} {
  const baseDir = configDir ? expandPath(configDir) : getDefaultBaseDir();
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const privateKeyPath = path.join(baseDir, "id_ed25519");
  const publicKeyPath = path.join(baseDir, "id_ed25519.pub");

  // Check if existing key in .ollama can be linked or used
  const existingPub = getPublicKey(configDir);
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    return {
      publicKey: fs.readFileSync(publicKeyPath, "utf-8").trim(),
      publicKeyPath,
      privateKeyPath,
    };
  }

  // Check if ~/.ollama/id_ed25519 exists, and copy/reuse it
  const ollamaPriv = expandPath("~/.ollama/id_ed25519");
  const ollamaPub = expandPath("~/.ollama/id_ed25519.pub");
  if (fs.existsSync(ollamaPriv) && fs.existsSync(ollamaPub)) {
    try {
      const privContent = fs.readFileSync(ollamaPriv, "utf-8");
      const pubContent = fs.readFileSync(ollamaPub, "utf-8");
      fs.writeFileSync(privateKeyPath, privContent, { mode: 0o600 });
      fs.writeFileSync(publicKeyPath, pubContent, { mode: 0o644 });
      return {
        publicKey: pubContent.trim(),
        publicKeyPath,
        privateKeyPath,
      };
    } catch {
      // proceed to generate
    }
  }

  // Generate new ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Convert raw public key to OpenSSH format
  const rawPub = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
  // ed25519 spki prefix is 12 bytes, raw key is last 32 bytes
  const rawKeyBytes = rawPub.subarray(rawPub.length - 32);
  const typeStr = "ssh-ed25519";
  const typeBuf = Buffer.from(typeStr);
  const keyBuf = Buffer.concat([
    Buffer.from([0, 0, 0, typeBuf.length]),
    typeBuf,
    Buffer.from([0, 0, 0, rawKeyBytes.length]),
    rawKeyBytes,
  ]);
  const sshPublicKey = `ssh-ed25519 ${keyBuf.toString("base64")} ollama-lite@localhost`;

  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, sshPublicKey, { mode: 0o644 });

  return {
    publicKey: sshPublicKey,
    publicKeyPath,
    privateKeyPath,
  };
}

/**
 * Verifies authentication token against Ollama Cloud (https://ollama.com).
 */
export async function verifyOllamaCloudAuth(
  apiKey: string,
  remoteHost = "https://ollama.com",
  signal?: AbortSignal
): Promise<{ success: boolean; error?: string; models?: string[] }> {
  const cleanHost = remoteHost.replace(/\/+$/, "");
  const targetUrl = `${cleanHost}/v1/models`;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": "bun-ollama-lite/1.0",
      },
      signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        error: "Authentication failed: Invalid API key or unauthorized (401).",
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      return {
        success: false,
        error: `Ollama Cloud returned HTTP ${res.status}: ${errText}`,
      };
    }

    const data: any = await res.json();
    const models: string[] = Array.isArray(data.data)
      ? data.data.map((m: any) => m.id).filter(Boolean)
      : [];

    return {
      success: true,
      models,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Network connection error: ${err.message}`,
    };
  }
}

/**
 * Synchronizes cloud models from Ollama Cloud and registers their manifests locally.
 */
export async function syncCloudModels(
  apiKey: string,
  config: Config
): Promise<{ synced: string[]; count: number }> {
  const remoteHost = (config.ollamaCloudHost || "https://ollama.com").replace(/\/+$/, "");
  const authResult = await verifyOllamaCloudAuth(apiKey, remoteHost);

  if (!authResult.success || !authResult.models) {
    return { synced: [], count: 0 };
  }

  const synced: string[] = [];

  for (const modelId of authResult.models) {
    const cloudName = modelId.endsWith("-cloud") || modelId.includes(":cloud")
      ? modelId
      : `${modelId}-cloud`;

    const manifest = createManifest({
      name: cloudName,
      digest: `sha256:${crypto.createHash("sha256").update(modelId).digest("hex")}`,
      size: 0,
      quantization: "cloud",
      repository: "ollama.com",
      filename: "(cloud)",
      blobPath: "",
      format: "cloud",
      parameters: {
        context_size: 131072,
      },
      source: "ollama-cloud",
      isCloud: true,
      remoteHost,
      remoteModel: modelId,
      capabilities: ["completion", "tools", "thinking"],
    });

    await saveManifest(manifest, config);
    synced.push(cloudName);
  }

  logger.info(`Synchronized ${synced.length} cloud models from Ollama Cloud.`);
  return { synced, count: synced.length };
}

/**
 * Signs in using an Ollama API key and saves configuration.
 */
export async function signIn(
  apiKey: string,
  config: Config
): Promise<{ success: boolean; message: string; models?: string[] }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    return { success: false, message: "API key cannot be empty." };
  }

  const remoteHost = config.ollamaCloudHost || "https://ollama.com";
  logger.info(`Authenticating with Ollama Cloud (${remoteHost})...`);

  const verifyResult = await verifyOllamaCloudAuth(cleanKey, remoteHost);
  if (!verifyResult.success) {
    return {
      success: false,
      message: verifyResult.error || "Authentication failed.",
    };
  }

  // Save key to persistent configuration
  saveConfig({ apiKey: cleanKey });

  // Sync cloud models
  const { synced } = await syncCloudModels(cleanKey, config);

  return {
    success: true,
    message: `Successfully authenticated with Ollama Cloud (${remoteHost})!`,
    models: synced,
  };
}

/**
 * Signs out and clears stored API key from configuration.
 */
export async function signOut(
  config: Config
): Promise<{ success: boolean; message: string }> {
  saveConfig({ apiKey: "" });
  return {
    success: true,
    message: "Successfully signed out from Ollama Cloud.",
  };
}

/**
 * Returns current authentication status and accessible cloud models.
 */
export async function getAuthStatus(config: Config): Promise<{
  authenticated: boolean;
  apiKeyConfigured: boolean;
  publicKey: string | null;
  remoteHost: string;
  models?: string[];
  error?: string;
}> {
  const apiKey = config.apiKey || process.env.OLLAMA_API_KEY || process.env.OLLAMA_KEY;
  const remoteHost = config.ollamaCloudHost || "https://ollama.com";
  const publicKey = getPublicKey();

  if (!apiKey) {
    return {
      authenticated: false,
      apiKeyConfigured: false,
      publicKey,
      remoteHost,
    };
  }

  const result = await verifyOllamaCloudAuth(apiKey, remoteHost);

  return {
    authenticated: result.success,
    apiKeyConfigured: true,
    publicKey,
    remoteHost,
    models: result.models,
    error: result.error,
  };
}
