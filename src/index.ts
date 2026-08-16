#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import {
  cliRun,
  cliPull,
  cliList,
  cliPs,
  cliShow,
  cliRm,
  cliStop,
  cliServe,
  cliBenchmark,
  printHelp,
} from "./cli.ts";

export * from "./config.ts";
export * from "./models/registry.ts";
export * from "./models/resolver.ts";
export * from "./models/manifest.ts";
export * from "./models/storage.ts";
export * from "./models/downloader.ts";
export * from "./runtime/port-manager.ts";
export * from "./runtime/health-check.ts";
export * from "./runtime/llama-server.ts";
export * from "./runtime/process-manager.ts";
export * from "./api/server.ts";
export * from "./api/router.ts";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const config = loadConfig();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log("ollama-lite v0.1.0 (Bun + llama.cpp)");
    return;
  }

  switch (command) {
    case "run":
      await cliRun(args[1] || "", args.slice(2), config);
      break;

    case "pull":
      await cliPull(args[1] || "", config);
      break;

    case "list":
    case "ls":
      await cliList(config);
      break;

    case "ps":
      await cliPs(config);
      break;

    case "show":
      await cliShow(args[1] || "", config);
      break;

    case "rm":
    case "delete":
      await cliRm(args[1] || "", config);
      break;

    case "stop":
      await cliStop(args[1] || "", config);
      break;

    case "serve":
      await cliServe(config);
      break;

    case "benchmark":
      await cliBenchmark(args[1] || "", config);
      break;

    default:
      console.error(`Unknown command: "${command}"\n`);
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
