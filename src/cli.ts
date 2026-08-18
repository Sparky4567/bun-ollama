import readline from "node:readline";
import fs from "node:fs";
import { type Config, loadConfig, saveConfig, ensureDirectories } from "./config.ts";
import { listManifests, getManifest, deleteModel } from "./models/storage.ts";
import { downloadModel, type DownloadProgress } from "./models/downloader.ts";
import { detectOllamaDirectory, importAllLocalOllamaModels } from "./models/ollama-local.ts";
import { ProcessManager } from "./runtime/process-manager.ts";
import { startServer, stopRunningServer } from "./api/server.ts";
import { type LogLevel, logger } from "./utils/logging.ts";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderProgressBar(progress: DownloadProgress): void {
  const width = 25;
  const percent = progress.percent;
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  const downloadedStr = formatBytes(progress.downloadedBytes);
  const totalStr = progress.totalBytes > 0 ? formatBytes(progress.totalBytes) : "unknown";
  const speedStr = `${formatBytes(progress.speedBytesPerSec)}/s`;

  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[KDownloading ${progress.model}: [${bar}] ${percent}% ${downloadedStr} / ${totalStr} (${speedStr})`);
  }
}

/**
 * CLI Pull Command
 */
export async function cliPull(modelName: string, config: Config): Promise<void> {
  if (!modelName) {
    console.error("Error: Please provide a model name (e.g. ollama-lite pull llama3.2:1b)");
    process.exit(1);
  }

  ensureDirectories(config);
  console.log(`Pulling model "${modelName}"...`);

  try {
    const manifest = await downloadModel(modelName, {
      config,
      onProgress(p) {
        if (p.status === "downloading") {
          renderProgressBar(p);
        } else if (p.status === "verifying") {
          if (process.stdout.isTTY) process.stdout.write("\n");
          console.log("Verifying SHA-256 checksum...");
        }
      },
    });

    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`Successfully pulled ${manifest.name} (${formatBytes(manifest.size)}) [${manifest.quantization}]`);
  } catch (err: any) {
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.error(`\nFailed to pull model: ${err.message}`);
    process.exit(1);
  }
}

/**
 * CLI List Command
 */
export async function cliList(config: Config): Promise<void> {
  ensureDirectories(config);
  const manifests = await listManifests(config);

  if (manifests.length === 0) {
    console.log("No models found locally. Run `ollama-lite pull <model>` or `ollama-lite run <model>` to download one.");
    return;
  }

  console.log(
    `${"NAME".padEnd(28)} ${"ID".padEnd(16)} ${"SIZE".padEnd(12)} ${"QUANT".padEnd(10)} ${"MODIFIED"}`
  );
  console.log("-".repeat(80));

  for (const m of manifests) {
    const id = m.digest.slice(7, 19);
    const size = formatBytes(m.size);
    const modified = new Date(m.modified_at).toLocaleString();
    console.log(
      `${m.name.padEnd(28)} ${id.padEnd(16)} ${size.padEnd(12)} ${m.quantization.padEnd(10)} ${modified}`
    );
  }
}

/**
 * CLI PS Command (Active processes)
 */
export async function cliPs(config: Config): Promise<void> {
  // If server is running on default port, query it
  try {
    const res = await fetch(`http://${config.host}:${config.port}/api/ps`);
    if (res.ok) {
      const data: any = await res.json();
      const models = data.models || [];

      if (models.length === 0) {
        console.log("No models currently loaded in memory.");
        return;
      }

      console.log(
        `${"NAME".padEnd(28)} ${"PORT".padEnd(8)} ${"SIZE".padEnd(12)} ${"EXPIRES IN"}`
      );
      console.log("-".repeat(60));

      for (const m of models) {
        const expiresInMs = new Date(m.expires_at).getTime() - Date.now();
        const expiresStr = expiresInMs > 0 ? `${Math.round(expiresInMs / 1000)}s` : "now";
        console.log(
          `${m.name.padEnd(28)} ${String(m.port).padEnd(8)} ${formatBytes(m.size).padEnd(12)} ${expiresStr}`
        );
      }
      return;
    }
  } catch {
    // API server not running
  }

  console.log("Ollama Lite API server is not currently running. Use `ollama-lite serve` to start the daemon.");
}

/**
 * CLI Show Command
 */
export async function cliShow(modelName: string, config: Config): Promise<void> {
  if (!modelName) {
    console.error("Error: Please provide a model name (e.g. ollama-lite show llama3.2:1b)");
    process.exit(1);
  }

  ensureDirectories(config);
  const manifest = await getManifest(modelName, config);
  if (!manifest) {
    console.error(`Model "${modelName}" not found locally.`);
    process.exit(1);
  }

  console.log(`Model:         ${manifest.name}`);
  console.log(`Digest:        ${manifest.digest}`);
  console.log(`Repository:    ${manifest.repository}`);
  console.log(`Source:        ${manifest.source || "huggingface"}`);
  console.log(`Filename:      ${manifest.filename}`);
  console.log(`Quantization:  ${manifest.quantization}`);
  console.log(`Size:          ${formatBytes(manifest.size)}`);
  console.log(`Context Size:  ${manifest.parameters?.context_size || 2048}`);
  if (manifest.system || manifest.parameters?.system_prompt) {
    console.log(`System Prompt: ${manifest.system || manifest.parameters?.system_prompt}`);
  }
  if (manifest.parameters?.stop) {
    console.log(`Stop Tokens:   ${JSON.stringify(manifest.parameters.stop)}`);
  }
  console.log(`Blob Path:     ${manifest.blob_path}`);
  console.log(`Modified:      ${new Date(manifest.modified_at).toLocaleString()}`);
}

/**
 * CLI Import Ollama Command
 */
export async function cliImportOllama(args: string[], config: Config): Promise<void> {
  ensureDirectories(config);

  let customPath: string | undefined;
  let mode: "symlink" | "copy" = "symlink";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--path" || arg === "-p") {
      customPath = args[++i];
    } else if (arg === "--copy") {
      mode = "copy";
    } else if (arg === "--symlink") {
      mode = "symlink";
    } else if (!customPath && !arg?.startsWith("-")) {
      customPath = arg;
    }
  }

  const detectedDir = detectOllamaDirectory(customPath);
  if (!detectedDir) {
    console.error("No Ollama models directory found. Checked ~/.ollama/models, /usr/share/ollama, and environment.");
    console.error("You can specify a path explicitly with: ollama-lite import-ollama --path /path/to/.ollama/models");
    process.exit(1);
  }

  console.log(`Discovered Ollama models directory at: ${detectedDir}`);
  console.log(`Import mode: ${mode === "symlink" ? "symlink (zero disk duplication)" : "copy"}\n`);

  const summary = await importAllLocalOllamaModels({
    ollamaDir: detectedDir,
    mode,
    config,
  });

  if (summary.discoveredCount === 0) {
    console.log("No valid Ollama models found to import.");
    return;
  }

  console.log(`Found ${summary.discoveredCount} model(s) in local Ollama store:`);
  if (summary.imported.length > 0) {
    console.log("\nSuccessfully imported:");
    for (const m of summary.imported) {
      console.log(`  ✓ ${m.name} (${formatBytes(m.size)}) [${m.quantization}] -> ${m.blob_path}`);
    }
  }

  if (summary.skipped.length > 0) {
    console.log("\nSkipped (already registered in Ollama Lite):");
    for (const name of summary.skipped) {
      console.log(`  - ${name}`);
    }
  }

  if (summary.errors.length > 0) {
    console.log("\nFailed to import:");
    for (const err of summary.errors) {
      console.log(`  ✗ ${err.model}: ${err.error}`);
    }
  }

  console.log(`\nImport complete: ${summary.imported.length} new, ${summary.skipped.length} skipped, ${summary.errors.length} failed.`);
}

/**
 * CLI Remove Command
 */
export async function cliRm(modelName: string, config: Config): Promise<void> {
  if (!modelName) {
    console.error("Error: Please provide a model name (e.g. ollama-lite rm llama3.2:1b)");
    process.exit(1);
  }

  ensureDirectories(config);
  const deleted = await deleteModel(modelName, config);
  if (deleted) {
    console.log(`Deleted model "${modelName}"`);
  } else {
    console.error(`Model "${modelName}" not found.`);
    process.exit(1);
  }
}

/**
 * CLI Stop Command
 */
export async function cliStop(modelName: string, config: Config): Promise<void> {
  if (!modelName) {
    console.error("Error: Please provide a model name (e.g. ollama-lite stop llama3.2:1b)");
    process.exit(1);
  }

  try {
    const res = await fetch(`http://${config.host}:${config.port}/api/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    console.log(`Stopped model ${modelName}`);
  } catch {
    console.log(`Stopped model ${modelName} (if running)`);
  }
}

/**
 * CLI Serve End Command - stops the running server daemon
 */
export async function cliServeEnd(config: Config): Promise<void> {
  const result = await stopRunningServer(config);
  console.log(result.message);
}

/**
 * CLI Serve Command
 */
export async function cliServe(
  argsOrConfig?: string[] | Config,
  configOverride?: Config
): Promise<void> {
  let args: string[] = [];
  let config: Config;

  if (Array.isArray(argsOrConfig)) {
    args = argsOrConfig;
    config = configOverride || loadConfig();
  } else if (argsOrConfig && typeof argsOrConfig === "object") {
    config = argsOrConfig;
  } else {
    config = loadConfig();
  }

  const subCommand = args[0]?.toLowerCase();
  if (subCommand === "end" || subCommand === "stop" || subCommand === "down") {
    await cliServeEnd(config);
    return;
  }

  const instance = startServer(config);

  const shutdown = async () => {
    console.log("\nReceived termination signal. Shutting down...");
    await instance.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

/**
 * CLI Run Command (Interactive chat or single-shot prompt)
 */
export async function cliRun(
  modelName: string,
  promptArgs: string[],
  config: Config
): Promise<void> {
  if (!modelName) {
    console.error("Error: Please provide a model name (e.g. ollama-lite run llama3.2:1b)");
    process.exit(1);
  }

  ensureDirectories(config);
  const processManager = new ProcessManager(config);

  const cleanup = async () => {
    await processManager.shutdownAll();
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  let manifest = await getManifest(modelName, config);
  if (!manifest) {
    console.log(`Model "${modelName}" not found locally. Downloading automatically...`);
    try {
      manifest = await downloadModel(modelName, {
        config,
        onProgress(p) {
          if (p.status === "downloading") {
            renderProgressBar(p);
          }
        },
      });
      if (process.stdout.isTTY) process.stdout.write("\n");
    } catch (err: any) {
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.error(`\nFailed to download model: ${err.message}`);
      await cleanup();
      process.exit(1);
    }
  }

  console.log(`Loading model ${modelName}...`);
  let modelProc;
  try {
    modelProc = await processManager.ensureModelReady(modelName);
  } catch (err: any) {
    console.error(`\nFailed to start inference server: ${err.message}`);
    await cleanup();
    process.exit(1);
  }

  // If a prompt was provided on the CLI, do single-shot execution
  if (promptArgs.length > 0) {
    const prompt = promptArgs.join(" ");
    await streamChatCompletion(modelProc.port, [{ role: "user", content: prompt }]);
    await cleanup();
    return;
  }

  // Interactive REPL Mode
  console.log(`\nModel:        ${modelName}`);
  console.log(`Quantization: ${manifest.quantization}`);
  console.log(`Context:      ${manifest.parameters?.context_size || 2048}`);
  console.log(`Type "/exit" or "/bye" to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        ask();
        return;
      }

      if (trimmed === "/exit" || trimmed === "/bye" || trimmed === "exit") {
        rl.close();
        await cleanup();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        conversationHistory.length = 0;
        console.log("Conversation history cleared.\n");
        ask();
        return;
      }

      if (trimmed === "/help") {
        console.log("Commands: /exit, /bye, /clear, /help\n");
        ask();
        return;
      }

      conversationHistory.push({ role: "user", content: trimmed });

      try {
        const assistantResponse = await streamChatCompletion(
          modelProc.port,
          conversationHistory
        );
        conversationHistory.push({ role: "assistant", content: assistantResponse });
        console.log("\n");
      } catch (err: any) {
        console.error(`\nInference error: ${err.message}\n`);
      }

      processManager.touch(modelName);
      ask();
    });
  };

  ask();
}

/**
 * Streams chat completion tokens directly from llama-server to stdout.
 */
async function streamChatCompletion(
  port: number,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`llama-server returned HTTP ${res.status}: ${errText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const dataStr = trimmed.replace(/^data:\s*/, "");
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          process.stdout.write(delta);
          fullResponse += delta;
        }
      } catch {
        // ignore parse error
      }
    }
  }

  if (fullResponse) {
    process.stdout.write("\n");
  }

  return fullResponse;
}

/**
 * CLI Benchmark Command
 */
export async function cliBenchmark(modelName: string, config: Config): Promise<void> {
  if (!modelName) {
    console.error("Error: Please provide a model name (e.g. ollama-lite benchmark llama3.2:1b)");
    process.exit(1);
  }

  ensureDirectories(config);
  const processManager = new ProcessManager(config);

  const cleanup = async () => {
    await processManager.shutdownAll();
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  console.log(`\n======================================================`);
  console.log(`         OLLAMA LITE BENCHMARK SUITE                  `);
  console.log(`======================================================\n`);

  // Step 1: Check or download model
  let manifest = await getManifest(modelName, config);
  let downloadDurationSec = 0;

  if (!manifest) {
    console.log(`Model "${modelName}" not found locally. Downloading...`);
    const dlStart = Date.now();
    manifest = await downloadModel(modelName, {
      config,
      onProgress(p) {
        if (p.status === "downloading") {
          renderProgressBar(p);
        }
      },
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    downloadDurationSec = (Date.now() - dlStart) / 1000;
    console.log(`Model downloaded in ${downloadDurationSec.toFixed(2)}s\n`);
  } else {
    console.log(`Model already downloaded and cached locally.`);
  }

  // Step 2: Measure model load time
  console.log(`Starting llama-server for cold load measurement...`);
  const loadStart = Date.now();
  const modelProc = await processManager.ensureModelReady(modelName);
  const loadTimeSec = (Date.now() - loadStart) / 1000;

  console.log(`Model loaded successfully in ${loadTimeSec.toFixed(2)}s\n`);
  console.log(`Model:         ${manifest.name}`);
  console.log(`Quantization:  ${manifest.quantization}`);
  console.log(`Size:          ${formatBytes(manifest.size)}`);
  console.log(`Port:          ${modelProc.port}`);
  console.log(`Backend:       llama.cpp (llama-server)\n`);

  // Step 3: Run benchmark iterations
  const benchmarkPrompt = "Explain the difference between a process and a thread in operating systems in three paragraphs.";
  const maxTokens = 128;
  const runsCount = 3;

  interface BenchmarkRunResult {
    run: number;
    promptTokens: number;
    promptDurationMs: number;
    promptTokPerSec: number;
    genTokens: number;
    genDurationMs: number;
    genTokPerSec: number;
    totalDurationSec: number;
  }

  const results: BenchmarkRunResult[] = [];

  console.log(`Running ${runsCount} inference benchmark passes (Prompt tokens ~20-40, Max generation = ${maxTokens} tokens)...\n`);

  for (let i = 1; i <= runsCount; i++) {
    process.stdout.write(`Pass ${i}/${runsCount}... `);
    const runStart = Date.now();

    const res = await fetch(`http://127.0.0.1:${modelProc.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: benchmarkPrompt }],
        max_tokens: maxTokens,
        stream: false,
        temperature: 0.7,
      }),
    });

    const runEnd = Date.now();
    const data: any = await res.json();
    const timings = data.timings || {};

    const promptTokens = timings.prompt_n || data.usage?.prompt_tokens || 0;
    const promptDurationMs = timings.prompt_ms || Math.max(1, runEnd - runStart);
    const promptTokPerSec =
      typeof timings.prompt_per_second === "number" && isFinite(timings.prompt_per_second)
        ? timings.prompt_per_second
        : promptTokens / Math.max(0.001, promptDurationMs / 1000);

    const genTokens = timings.predicted_n || data.usage?.completion_tokens || 0;
    const genDurationMs = timings.predicted_ms || Math.max(1, runEnd - runStart);
    const genTokPerSec =
      typeof timings.predicted_per_second === "number" && isFinite(timings.predicted_per_second)
        ? timings.predicted_per_second
        : genTokens / Math.max(0.001, genDurationMs / 1000);
    const totalDurationSec = (runEnd - runStart) / 1000;

    results.push({
      run: i,
      promptTokens,
      promptDurationMs,
      promptTokPerSec,
      genTokens,
      genDurationMs,
      genTokPerSec,
      totalDurationSec,
    });

    console.log(`Done! (${genTokPerSec.toFixed(1)} tok/s, ${genTokens} tokens in ${(genDurationMs / 1000).toFixed(2)}s)`);
  }

  // Calculate stats
  const genSpeeds = results.map((r) => r.genTokPerSec);
  const avgGenSpeed = genSpeeds.reduce((a, b) => a + b, 0) / genSpeeds.length;
  const sortedSpeeds = [...genSpeeds].sort((a, b) => a - b);
  const medianGenSpeed = sortedSpeeds[Math.floor(sortedSpeeds.length / 2)] || 0;

  const promptSpeeds = results.map((r) => r.promptTokPerSec);
  const avgPromptSpeed = promptSpeeds.reduce((a, b) => a + b, 0) / promptSpeeds.length;

  console.log(`\n======================================================`);
  console.log(`                 BENCHMARK RESULTS                    `);
  console.log(`======================================================\n`);
  console.log(`Model:              ${manifest.name}`);
  console.log(`Quantization:       ${manifest.quantization}`);
  console.log(`Load time:          ${loadTimeSec.toFixed(2)} s\n`);

  for (const r of results) {
    console.log(`Run ${r.run}:             ${r.genTokPerSec.toFixed(1)} tok/s (Prompt: ${r.promptTokPerSec.toFixed(1)} tok/s, Gen: ${r.genTokens} tokens in ${(r.genDurationMs / 1000).toFixed(2)}s)`);
  }

  console.log(`------------------------------------------------------`);
  console.log(`Prompt processing:  ${avgPromptSpeed.toFixed(1)} tok/s (average)`);
  console.log(`Generation average: ${avgGenSpeed.toFixed(1)} tok/s`);
  console.log(`Generation median:  ${medianGenSpeed.toFixed(1)} tok/s`);
  console.log(`======================================================\n`);

  await cleanup();
}

/**
 * CLI Config Command
 */
export async function cliConfig(args: string[], config: Config): Promise<void> {
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === "list" || sub === "ls" || sub === "show") {
    console.log("Current configuration (~/.ollama-lite/config.json / defaults):");
    console.log(`  host:                ${config.host}`);
    console.log(`  port:                ${config.port}`);
    console.log(`  logLevel:            ${config.logLevel}`);
    console.log(`  modelsDir:           ${config.modelsDir}`);
    console.log(`  runtimeDir:          ${config.runtimeDir}`);
    console.log(`  defaultContext:      ${config.defaultContext}`);
    console.log(`  defaultQuantization: ${config.defaultQuantization}`);
    console.log(`  idleTimeout:         ${config.idleTimeout}ms`);
    console.log(`  llamaServer:         ${config.llamaServer}`);
    return;
  }

  if (sub === "get") {
    const key = args[1];
    if (!key) {
      console.error("Usage: ollama-lite config get <key>");
      process.exit(1);
    }
    const normalizedKey = key === "log-level" ? "logLevel" : key;
    if (normalizedKey in config) {
      console.log((config as any)[normalizedKey]);
    } else {
      console.error(`Unknown config key: "${key}"`);
      process.exit(1);
    }
    return;
  }

  if (sub === "set") {
    const key = args[1];
    let value: any = args[2];
    if (!key || value === undefined) {
      console.error("Usage: ollama-lite config set <key> <value>");
      console.error("Example: ollama-lite config set logLevel warn");
      console.error("Example: ollama-lite config set logLevel none");
      process.exit(1);
    }

    const normalizedKey = key === "log-level" ? "logLevel" : key;
    if (normalizedKey === "logLevel") {
      const validLevels: LogLevel[] = ["debug", "info", "warn", "error", "none"];
      if (!validLevels.includes(value as LogLevel)) {
        console.error(`Invalid log level: "${value}". Valid values are: ${validLevels.join(", ")}`);
        process.exit(1);
      }
    } else if (normalizedKey === "port" || normalizedKey === "defaultContext" || normalizedKey === "idleTimeout") {
      const num = parseInt(value, 10);
      if (isNaN(num)) {
        console.error(`Invalid number for ${key}: "${value}"`);
        process.exit(1);
      }
      value = num;
    }

    saveConfig({ [normalizedKey]: value });
    console.log(`Updated config: ${normalizedKey} = ${value}`);
    return;
  }

  console.error(`Unknown config command: "${sub}". Use "list", "get", or "set".`);
  process.exit(1);
}

/**
 * Prints help text
 */
export function printHelp(): void {
  console.log(`
Ollama Lite - Lightweight Bun.js & llama.cpp Local LLM Manager

Usage:
  ollama-lite [flags] <command> [arguments]

Flags:
  -q, --quiet             Disable info logs (sets log level to 'warn')
  -s, --silent            Disable all logs (sets log level to 'none')
  -d, --debug             Enable verbose debug logs (sets log level to 'debug')
      --log-level <level> Set log level explicitly ('debug'|'info'|'warn'|'error'|'none')
  -h, --help              Show this help message
  -v, --version           Show Ollama Lite version

Commands:
  run <model> [prompt]    Run a model (starts interactive chat if prompt is omitted)
  pull <model>            Download a model from Ollama Registry or Hugging Face
  import-ollama [opts]    Import existing models from local ~/.ollama store (--path, --copy)
  list, ls                List all downloaded models
  ps                      List all currently running model processes
  show <model>            Show detailed metadata for a model
  rm <model>              Remove a model and unused storage blobs
  stop <model>            Stop an active inference server
  serve [end|stop]        Start or stop the HTTP API daemon (default port: 11434)
  benchmark <model>       Run inference benchmark passes and compute tok/s metrics
  config [get|set|list]   View or update persistent configuration (e.g. config set logLevel none)
  help                    Show this help message
  version                 Show Ollama Lite version

Examples:
  ollama-lite run llama3.2:1b
  ollama-lite run ollama:deepseek-r1:8b
  ollama-lite pull smollm:135m
  ollama-lite import-ollama
  ollama-lite import-ollama --path ~/.ollama/models --copy
  ollama-lite run llama3.2:1b "Explain quantum computing in one sentence" --quiet
  ollama-lite pull qwen2.5:0.5b --silent
  ollama-lite serve
  ollama-lite serve end
  ollama-lite serve --quiet
  ollama-lite serve --log-level none
  ollama-lite config set logLevel warn
`);
}
