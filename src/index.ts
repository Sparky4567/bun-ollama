#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import {
  cliRun,
  cliPull,
  cliImportOllama,
  cliList,
  cliPs,
  cliShow,
  cliRm,
  cliStop,
  cliServe,
  cliServeEnd,
  cliBenchmark,
  cliConfig,
  printHelp,
} from "./cli.ts";
import { type LogLevel } from "./utils/logging.ts";

export * from "./config.ts";
export * from "./models/registry.ts";
export * from "./models/resolver.ts";
export * from "./models/manifest.ts";
export * from "./models/storage.ts";
export * from "./models/downloader.ts";
export * from "./models/ollama-registry.ts";
export * from "./models/ollama-local.ts";
export * from "./runtime/port-manager.ts";
export * from "./runtime/health-check.ts";
export * from "./runtime/llama-server.ts";
export * from "./runtime/process-manager.ts";
export * from "./api/server.ts";
export * from "./api/router.ts";
export * from "./cli.ts";

export interface ParsedCliArgs {
  command?: string;
  args: string[];
  logLevel?: LogLevel;
  help?: boolean;
  version?: boolean;
}

export function parseCliArgs(rawArgs: string[]): ParsedCliArgs {
  let command: string | undefined;
  const args: string[] = [];
  let logLevel: LogLevel | undefined;
  let help = false;
  let version = false;
  let stopFlagParsing = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === undefined) continue;

    if (stopFlagParsing) {
      if (!command) {
        command = arg.toLowerCase();
      } else {
        args.push(arg);
      }
      continue;
    }

    if (arg === "--") {
      stopFlagParsing = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg === "-q" || arg === "--quiet") {
      logLevel = "warn";
    } else if (arg === "-s" || arg === "--silent") {
      logLevel = "none";
    } else if (arg === "-d" || arg === "--debug") {
      logLevel = "debug";
    } else if (arg.startsWith("--log-level=")) {
      logLevel = arg.slice("--log-level=".length).toLowerCase() as LogLevel;
    } else if (arg === "--log-level") {
      i++;
      const nextArg = rawArgs[i];
      if (nextArg) {
        logLevel = nextArg.toLowerCase() as LogLevel;
      }
    } else if (!command) {
      command = arg.toLowerCase();
    } else {
      args.push(arg);
    }
  }

  return {
    command,
    args,
    logLevel,
    help,
    version,
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const parsed = parseCliArgs(rawArgs);

  const validLogLevels: LogLevel[] = ["debug", "info", "warn", "error", "none"];
  if (parsed.logLevel && !validLogLevels.includes(parsed.logLevel)) {
    console.error(
      `Invalid log level: "${parsed.logLevel}". Valid values are: ${validLogLevels.join(", ")}`
    );
    process.exit(1);
  }

  if (
    !parsed.command ||
    parsed.command === "help" ||
    (parsed.help && !parsed.command)
  ) {
    printHelp();
    return;
  }

  if (
    parsed.command === "version" ||
    (parsed.version && !parsed.command)
  ) {
    console.log("ollama-lite v0.1.0 (Bun + llama.cpp)");
    return;
  }

  const config = loadConfig(parsed.logLevel ? { logLevel: parsed.logLevel } : undefined);

  switch (parsed.command) {
    case "run":
      await cliRun(parsed.args[0] || "", parsed.args.slice(1), config);
      break;

    case "pull":
      await cliPull(parsed.args[0] || "", config);
      break;

    case "import-ollama":
    case "import":
      await cliImportOllama(parsed.args, config);
      break;

    case "list":
    case "ls":
      await cliList(config);
      break;

    case "ps":
      await cliPs(config);
      break;

    case "show":
      await cliShow(parsed.args[0] || "", config);
      break;

    case "rm":
    case "delete":
      await cliRm(parsed.args[0] || "", config);
      break;

    case "stop":
      await cliStop(parsed.args[0] || "", config);
      break;

    case "serve":
      await cliServe(parsed.args, config);
      break;

    case "benchmark":
      await cliBenchmark(parsed.args[0] || "", config);
      break;

    case "config":
      await cliConfig(parsed.args, config);
      break;

    default:
      console.error(`Unknown command: "${parsed.command}"\n`);
      printHelp();
      process.exit(1);
  }
}

// Only execute CLI automatically if this file is the entry point
if (import.meta.main) {
  main().catch((err) => {
    console.error(`\nFatal error: ${err.message}`);
    process.exit(1);
  });
}
