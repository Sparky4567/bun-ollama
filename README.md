# Ollama Lite

A lightweight local LLM manager written in TypeScript and running on the [Bun](https://bun.sh) runtime with `llama.cpp` (`llama-server`) as the native inference backend.

## Overview

Ollama Lite provides an Ollama-compatible CLI and HTTP REST API, delegating heavy neural network inference, KV cache management, and token generation to native `llama-server`.

Bun acts as fast, lightweight glue responsible for:
- Model discovery & resolution (Hugging Face + official `registry.ollama.ai`)
- Local `~/.ollama` model importing with zero-copy symlinks
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

### Global Flags

| Flag | Description |
|---|---|
| `-q`, `--quiet` | Disable info logs (sets log level to `warn`) |
| `-s`, `--silent` | Disable all logs (sets log level to `none`) |
| `-d`, `--debug` | Enable verbose debug logging (sets log level to `debug`) |
| `--log-level <level>` | Set explicit log level (`debug`, `info`, `warn`, `error`, `none`) |
| `-h`, `--help` | Show CLI help text |
| `-v`, `--version` | Show CLI version |

### Commands

| Command | Description | Example |
|---|---|---|
| `run <model> [prompt]` | Interactive chat or single-shot generation | `bun run src/index.ts run llama3.2:1b` |
| `pull <model>` | Download model from Ollama Registry or Hugging Face | `bun run src/index.ts pull ollama:deepseek-r1:8b` |
| `import-ollama [opts]` | Import models from local `~/.ollama` (zero-copy symlink) | `bun run src/index.ts import-ollama` |
| `list`, `ls` | List all locally stored models | `bun run src/index.ts list` |
| `ps` | List running model processes | `bun run src/index.ts ps` |
| `show <model>` | Show model metadata and manifest | `bun run src/index.ts show llama3.2:1b` |
| `rm <model>` | Remove model and unreferenced blobs | `bun run src/index.ts rm llama3.2:1b` |
| `stop <model>` | Stop active inference process | `bun run src/index.ts stop llama3.2:1b` |
| `serve` | Start Ollama Lite HTTP API daemon | `bun run src/index.ts serve --quiet` |
| `serve end` | Stop running Ollama Lite HTTP API daemon | `bun run src/index.ts serve end` |
| `benchmark <model>` | Run inference benchmark & tok/s metrics | `bun run src/index.ts benchmark llama3.2:1b` |
| `config [get/set/list]` | View or update persistent configuration | `bun run src/index.ts config set logLevel none` |

## Model Sources & Catalog

### 1. Pure Ollama Models (Official `registry.ollama.ai`)
Pull and run any model directly from the official Ollama registry with full OCI layer support (GGUF weights, Modelfile parameters, chat templates, stop tokens):
```bash
# Explicit ollama: prefix
bun run src/index.ts pull ollama:deepseek-r1:8b
bun run src/index.ts run ollama:mistral:7b

# Short name with automatic fallback
bun run src/index.ts pull smollm:135m
```

### 2. Import Existing Local Ollama Models (`~/.ollama`)
If you already have models downloaded by the official Ollama daemon on your system, import them into Ollama Lite without re-downloading gigabytes of data. Ollama Lite creates zero-copy symlinks to your existing blobs:
```bash
# Auto-detects ~/.ollama/models and imports all models
bun run src/index.ts import-ollama

# Or specify a custom path or copy mode
bun run src/index.ts import-ollama --path /var/lib/ollama/models --copy
```

### 3. Built-in Hugging Face Aliases
- `llama3.2:1b` / `llama3.2:3b` (Llama 3.2 Instruct)
- `qwen2.5:0.5b` / `qwen2.5:1.5b` / `qwen2.5-coder:0.5b`
- `smollm2:135m` / `smollm2:360m`
- `gemma2:2b`

### 4. Custom Hugging Face Repositories
You can pull and run any Hugging Face GGUF repository directly:
```bash
bun run src/index.ts run bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M
```

## API Endpoints

### Ollama-Compatible API
- `GET  /` - Service health status
- `GET  /health` - JSON health check
- `GET  /api/tags` - List installed models
- `GET  /api/ps` - List running model processes
- `POST /api/show` - Show model manifest
- `POST /api/pull` - Pull model with streaming NDJSON progress
- `POST /api/delete` - Delete model
- `POST /api/chat` - Chat completions (streaming NDJSON & non-streaming)
- `POST /api/generate` - Text completions (streaming NDJSON & non-streaming)
- `POST /api/shutdown` - Gracefully stop Ollama Lite daemon and all inference processes

### OpenAI-Compatible API
- `GET  /v1/models` - List models
- `POST /v1/chat/completions` - Chat completions (SSE streaming & JSON)
- `POST /v1/completions` - Text completions

## Python API Examples

Ensure the Ollama Lite daemon is running (`bun run src/index.ts serve` or `ollama-lite serve`) on `http://localhost:11434`.

### 1. Chat Completions (`POST /api/chat`)

#### Streaming (NDJSON)
Streams real-time token chunks as newline-delimited JSON objects.

```python
import json
import requests

url = "http://localhost:11434/api/chat"
payload = {
    "model": "llama3.2:1b",
    "messages": [
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user", "content": "Write a short poem about coding."}
    ],
    "stream": True,
}

response = requests.post(url, json=payload, stream=True)

for line in response.iter_lines():
    if line:
        chunk = json.loads(line.decode("utf-8"))
        delta = chunk.get("message", {}).get("content", "")
        print(delta, end="", flush=True)
print()
```

#### Non-Streaming
Waits for full generation and returns the complete assistant message.

```python
import requests

url = "http://localhost:11434/api/chat"
payload = {
    "model": "llama3.2:1b",
    "messages": [
        {"role": "user", "content": "Explain quantum computing in one sentence."}
    ],
    "stream": False,
}

response = requests.post(url, json=payload)
data = response.json()

print(data["message"]["content"])
```

---

### 2. Text Generation (`POST /api/generate`)

#### Streaming (NDJSON)
Streams raw completion tokens incrementally as they are generated.

```python
import json
import requests

url = "http://localhost:11434/api/generate"
payload = {
    "model": "llama3.2:1b",
    "prompt": "List 3 advantages of using TypeScript:",
    "stream": True,
}

response = requests.post(url, json=payload, stream=True)

for line in response.iter_lines():
    if line:
        chunk = json.loads(line.decode("utf-8"))
        token = chunk.get("response", "")
        print(token, end="", flush=True)
print()
```

#### Non-Streaming
Returns the entire completed text response in a single JSON payload.

```python
import requests

url = "http://localhost:11434/api/generate"
payload = {
    "model": "llama3.2:1b",
    "prompt": "What is the capital of France?",
    "stream": False,
}

response = requests.post(url, json=payload)
data = response.json()

print(data["response"])
```

---

### 3. Model Management (`GET /api/tags` & `GET /api/ps`)

Inspect installed models and active inference processes:

```python
import requests

# List installed models
tags_res = requests.get("http://localhost:11434/api/tags").json()
print("Installed models:", [m["name"] for m in tags_res.get("models", [])])

# List active / running model processes
ps_res = requests.get("http://localhost:11434/api/ps").json()
print("Running models:", [m["name"] for m in ps_res.get("models", [])])
```

---

### 4. Zero-Dependency Python Example (`urllib.request`)

Interact with Ollama Lite endpoints using only Python's standard library (no `pip` dependencies required):

```python
import json
import urllib.request

req = urllib.request.Request(
    "http://localhost:11434/api/chat",
    data=json.dumps({
        "model": "llama3.2:1b",
        "messages": [{"role": "user", "content": "Hello!"}],
        "stream": True,
    }).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)

with urllib.request.urlopen(req) as resp:
    for line in resp:
        if line.strip():
            chunk = json.loads(line.decode("utf-8"))
            print(chunk.get("message", {}).get("content", ""), end="", flush=True)
print()
```

---

### 5. SDK Compatibility (`ollama` & `openai` packages)

Ollama Lite endpoints are fully drop-in compatible with official client SDKs:

<details>
<summary><b>Using the official <code>ollama</code> Python package</b></summary>

```python
import ollama

# Streaming
stream = ollama.chat(
    model="llama3.2:1b",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk["message"]["content"], end="", flush=True)
print()

# Non-streaming
res = ollama.chat(
    model="llama3.2:1b",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=False,
)
print(res["message"]["content"])
```
</details>

<details>
<summary><b>Using the official <code>openai</code> Python SDK</b></summary>

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

# Streaming (SSE)
stream = client.chat.completions.create(
    model="llama3.2:1b",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content or ""
    print(delta, end="", flush=True)
print()

# Non-streaming
res = client.chat.completions.create(
    model="llama3.2:1b",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=False,
)
print(res.choices[0].message.content)
```
</details>

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
| `logLevel` | `OLLAMA_LITE_LOG_LEVEL` | `info` | Logging verbosity (`debug`/`info`/`warn`/`error`/`none`) |

### Managing Logging Verbosity

You can adjust or disable logging through CLI flags, persistent configuration, or environment variables:

- **CLI Flags**: Pass `-q` / `--quiet` (warnings and errors only), `-s` / `--silent` (no output), or `--log-level <level>`:
  ```bash
  bun run src/index.ts serve --quiet
  bun run src/index.ts run llama3.2:1b "Hello" -q
  bun run src/index.ts serve --silent
  ```

- **Persistent Configuration**: Save your preferred log level to `~/.ollama-lite/config.json`:
  ```bash
  bun run src/index.ts config set logLevel warn
  bun run src/index.ts config set logLevel none
  ```

- **Environment Variable**:
  ```bash
  export OLLAMA_LITE_LOG_LEVEL=warn   # or 'none'
  ```

## Running Tests

```bash
bun test
bun run typecheck
```

## License

This project is licensed under the [MIT License](LICENSE).

