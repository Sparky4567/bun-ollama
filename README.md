# Ollama Lite

A lightweight local LLM manager written in TypeScript and running on the [Bun](https://bun.sh) runtime with `llama.cpp` (`llama-server`) as the native inference backend.

## Overview

Ollama Lite provides an Ollama-compatible CLI and HTTP REST API, delegating heavy neural network inference, KV cache management, and token generation to native `llama-server`.

Bun acts as fast, lightweight glue responsible for:
- Model discovery & Hugging Face resolution
- Streaming model downloads with on-the-fly SHA-256 verification
- Content-addressed blob storage & JSON manifests
- Lifecycle management (lazy start, health checks, dynamic port allocation)
- Automatic idle unloading to conserve RAM
- Full streaming HTTP API (Ollama + OpenAI compatibility)
- Interactive CLI with live streaming tokens
- Built-in benchmarking suite

## Architecture

```
                    Client (CLI / Web / API)
                               |
                               | HTTP (11434)
                               v
                       +---------------+
                       |   Bun Server  |
                       |               |
                       | REST API      |
                       | Router        |
                       | Model Storage |
                       | Process Mgr   |
                       +-------+-------+
                               |
                               | localhost HTTP
                               v
                       +---------------+
                       | llama-server  |
                       | (port 41000+) |
                       | llama.cpp     |
                       +-------+-------+
                               |
                               v
                            GGUF
                               |
                               v
                           CPU / GPU
```

## Quick Start

### 1. Requirements
- [Bun](https://bun.sh) (v1.1+)
- `llama-server` (from `llama.cpp` or Ollama installation)

### 2. Installation
Run the automated installer:
```bash
./installer.sh
```

Or manually with Bun:
```bash
bun install
chmod +x bin/ollama-lite
```

### 3. Run a Model
Download, start inference, and chat interactively:
```bash
bun run src/index.ts run llama3.2:1b
```

Or pass a single prompt:
```bash
bun run src/index.ts run llama3.2:1b "Why is the sky blue?"
```

## CLI Reference

| Command | Description | Example |
|---|---|---|
| `run <model> [prompt]` | Interactive chat or single-shot generation | `bun run src/index.ts run llama3.2:1b` |
| `pull <model>` | Download model from Hugging Face | `bun run src/index.ts pull qwen2.5:0.5b` |
| `list`, `ls` | List all locally stored models | `bun run src/index.ts list` |
| `ps` | List running model processes | `bun run src/index.ts ps` |
| `show <model>` | Show model metadata and manifest | `bun run src/index.ts show llama3.2:1b` |
| `rm <model>` | Remove model and unreferenced blobs | `bun run src/index.ts rm llama3.2:1b` |
| `stop <model>` | Stop active inference process | `bun run src/index.ts stop llama3.2:1b` |
| `serve` | Start Ollama Lite HTTP API daemon | `bun run src/index.ts serve` |
| `benchmark <model>` | Run inference benchmark & tok/s metrics | `bun run src/index.ts benchmark llama3.2:1b` |

## Model Catalog & Custom Models

### Built-in Aliases
- `llama3.2:1b` / `llama3.2:3b` (Llama 3.2 Instruct)
- `qwen2.5:0.5b` / `qwen2.5:1.5b` / `qwen2.5-coder:0.5b`
- `smollm2:135m` / `smollm2:360m`
- `gemma2:2b`

### Custom Hugging Face Models
You can pull and run any Hugging Face GGUF repository directly:
```bash
bun run src/index.ts run bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M
```

## API Endpoints

### Ollama-Compatible API
- `GET  /` - Service health status
- `GET  /api/tags` - List installed models
- `GET  /api/ps` - List running model processes
- `POST /api/show` - Show model manifest
- `POST /api/pull` - Pull model with streaming NDJSON progress
- `POST /api/delete` - Delete model
- `POST /api/chat` - Chat completions (streaming NDJSON & non-streaming)
- `POST /api/generate` - Text completions (streaming NDJSON & non-streaming)

### OpenAI-Compatible API
- `GET  /v1/models` - List models
- `POST /v1/chat/completions` - Chat completions (SSE streaming & JSON)
- `POST /v1/completions` - Text completions

## Configuration

Configuration is loaded from `~/.ollama-lite/config.json` with environment variable overrides:

| Option | Env Var | Default | Description |
|---|---|---|---|
| `host` | `OLLAMA_LITE_HOST` | `127.0.0.1` | Bind host address |
| `port` | `OLLAMA_LITE_PORT` | `11434` | API port |
| `modelsDir` | `OLLAMA_LITE_MODELS` | `~/.ollama-lite/models` | Model manifests & blobs directory |
| `runtimeDir` | `OLLAMA_LITE_RUNTIME` | `~/.ollama-lite/runtime` | Per-process logs and configs |
| `llamaServer` | `OLLAMA_LITE_LLAMA_SERVER` | auto-detected | Path to `llama-server` binary |
| `defaultContext`| `OLLAMA_LITE_CONTEXT` | `2048` | Context window size |
| `idleTimeout` | `OLLAMA_LITE_IDLE_TIMEOUT` | `300000` (5m) | Idle duration before unloading |
| `logLevel` | `OLLAMA_LITE_LOG_LEVEL` | `info` | Logging verbosity (`debug`/`info`/`warn`/`error`) |

## Running Tests

```bash
bun test
bun run typecheck
```

## License

This project is licensed under the [MIT License](LICENSE).

