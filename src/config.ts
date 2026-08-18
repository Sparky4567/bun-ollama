import fs from "node:fs";
import path from "node:path";
import {
  expandPath,
  getDefaultBaseDir,
  getDefaultConfigPath,
  getDefaultManifestsDir,
  getDefaultBlobsDir,
  getDefaultModelsDir,
  getDefaultRuntimeDir,
} from "./utils/paths.ts";
import { type LogLevel, setLogLevel, logger } from "./utils/logging.ts";

export interface Config {
  host: string;
  port: number;
  modelsDir: string;
  runtimeDir: string;
  defaultContext: number;
  defaultQuantization: string;
  idleTimeout: number; // in milliseconds
  llamaServer: string;
  logLevel: LogLevel;
  apiKey?: string;
  ollamaCloudHost?: string;
}

const DEFAULT_CONFIG: Config = {
  host: "127.0.0.1",
  port: 11434,
  modelsDir: "~/.ollama-lite/models",
  runtimeDir: "~/.ollama-lite/runtime",
  defaultContext: 2048,
  defaultQuantization: "Q4_K_M",
  idleTimeout: 300_000, // 5 minutes
  llamaServer: "llama-server",
  logLevel: "info",
  ollamaCloudHost: "https://ollama.com",
};

/**
 * Searches for a usable llama-server binary in common system locations.
 */
export function findLlamaServer(preferredPath?: string): string {
  const candidates: string[] = [];

  if (preferredPath) {
    candidates.push(expandPath(preferredPath));
  }

  if (process.env.OLLAMA_LITE_LLAMA_SERVER) {
    candidates.push(expandPath(process.env.OLLAMA_LITE_LLAMA_SERVER));
  }

  // System and standard locations
  candidates.push(
    "llama-server",
    "/usr/local/lib/ollama/llama-server",
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
    expandPath("~/.ollama-lite/bin/llama-server"),
    expandPath("~/.local/bin/llama-server"),
    "/opt/llama.cpp/llama-server",
    "/opt/homebrew/bin/llama-server"
  );

  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep)) {
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.isFile() && (stat.mode & 0o111)) {
            return candidate;
          }
        }
      } else {
        // Test if candidate binary is available on PATH using Bun.which
        const resolved = Bun.which(candidate);
        if (resolved) {
          return resolved;
        }
      }
    } catch {
      // Continue searching
    }
  }

  // Fallback to configured or default string
  return preferredPath || "llama-server";
}

/**
 * Loads configuration with precedence:
 * 1. Environment variables
 * 2. Configuration file (~/.ollama-lite/config.json)
 * 3. Defaults
 */
export function loadConfig(configOverrides?: Partial<Config>): Config {
  const configPath = getDefaultConfigPath();
  let fileConfig: Partial<Config> = {};

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(content);
    } catch (err: any) {
      logger.warn(`Failed to parse config file at ${configPath}: ${err.message}`);
    }
  }

  const envHost = process.env.OLLAMA_LITE_HOST;
  const envPort = process.env.OLLAMA_LITE_PORT ? parseInt(process.env.OLLAMA_LITE_PORT, 10) : undefined;
  const envModels = process.env.OLLAMA_LITE_MODELS;
  const envRuntime = process.env.OLLAMA_LITE_RUNTIME;
  const envLlamaServer = process.env.OLLAMA_LITE_LLAMA_SERVER;
  const envContext = process.env.OLLAMA_LITE_CONTEXT ? parseInt(process.env.OLLAMA_LITE_CONTEXT, 10) : undefined;
  const envIdleTimeout = process.env.OLLAMA_LITE_IDLE_TIMEOUT ? parseInt(process.env.OLLAMA_LITE_IDLE_TIMEOUT, 10) : undefined;
  const envLogLevel = process.env.OLLAMA_LITE_LOG_LEVEL as LogLevel | undefined;
  const envApiKey = process.env.OLLAMA_API_KEY || process.env.OLLAMA_KEY || process.env.OLLAMA_LITE_API_KEY;
  const envCloudHost = process.env.OLLAMA_CLOUD_HOST || process.env.OLLAMA_LITE_CLOUD_HOST;

  const rawConfig: Config = {
    host: configOverrides?.host ?? envHost ?? fileConfig.host ?? DEFAULT_CONFIG.host,
    port: configOverrides?.port ?? (envPort && !isNaN(envPort) ? envPort : undefined) ?? fileConfig.port ?? DEFAULT_CONFIG.port,
    modelsDir: configOverrides?.modelsDir ?? envModels ?? fileConfig.modelsDir ?? DEFAULT_CONFIG.modelsDir,
    runtimeDir: configOverrides?.runtimeDir ?? envRuntime ?? fileConfig.runtimeDir ?? DEFAULT_CONFIG.runtimeDir,
    defaultContext: configOverrides?.defaultContext ?? (envContext && !isNaN(envContext) ? envContext : undefined) ?? fileConfig.defaultContext ?? DEFAULT_CONFIG.defaultContext,
    defaultQuantization: configOverrides?.defaultQuantization ?? fileConfig.defaultQuantization ?? DEFAULT_CONFIG.defaultQuantization,
    idleTimeout: configOverrides?.idleTimeout ?? (envIdleTimeout && !isNaN(envIdleTimeout) ? envIdleTimeout : undefined) ?? fileConfig.idleTimeout ?? DEFAULT_CONFIG.idleTimeout,
    llamaServer: configOverrides?.llamaServer ?? envLlamaServer ?? fileConfig.llamaServer ?? DEFAULT_CONFIG.llamaServer,
    logLevel: configOverrides?.logLevel ?? envLogLevel ?? fileConfig.logLevel ?? DEFAULT_CONFIG.logLevel,
    apiKey: configOverrides?.apiKey ?? envApiKey ?? fileConfig.apiKey,
    ollamaCloudHost: configOverrides?.ollamaCloudHost ?? envCloudHost ?? fileConfig.ollamaCloudHost ?? DEFAULT_CONFIG.ollamaCloudHost,
  };

  // Expand paths
  rawConfig.modelsDir = expandPath(rawConfig.modelsDir);
  rawConfig.runtimeDir = expandPath(rawConfig.runtimeDir);
  rawConfig.llamaServer = findLlamaServer(rawConfig.llamaServer);

  // Set global log level
  setLogLevel(rawConfig.logLevel);

  return rawConfig;
}

/**
 * Saves or updates configuration in ~/.ollama-lite/config.json
 */
export function saveConfig(updates: Partial<Config>): Config {
  const configPath = getDefaultConfigPath();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let fileConfig: Partial<Config> = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(content);
    } catch {
      fileConfig = {};
    }
  }

  const merged = { ...fileConfig, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
  return loadConfig();
}

/**
 * Ensures required directories exist on disk.
 */
export function ensureDirectories(config: Config): void {
  const modelsDir = config.modelsDir;
  const manifestsDir = getDefaultManifestsDir(modelsDir);
  const blobsDir = getDefaultBlobsDir(modelsDir);
  const runtimeDir = config.runtimeDir;

  for (const dir of [modelsDir, manifestsDir, blobsDir, runtimeDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
