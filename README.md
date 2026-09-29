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
- Models stay loaded until explicitly stopped (optional idle-timeout auto-unload)
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

### 4. Model Lifecycle

- `pull <model>` downloads and registers the model; `run <model>` reuses the local copy and never re-downloads a model that is already pulled.
- Registry-prefixed references are aliases of the bare name: `ollama:gemma3:270m`, `ollama://gemma3:270m`, and `gemma3:270m` all resolve to the same stored model (`list` shows the canonical bare name).
- A started model keeps running until you stop it (`stop <model>`, `/api/delete`, exiting `run`, or `serve end`). There is no idle auto-unload by default; set `idleTimeout` to a positive millisecond value to opt back into automatic unloading (see Configuration).

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
| `run <model> [prompt]` | Interactive chat or single-shot generation | `bun run src/index.ts run gpt-oss:120b-cloud` |
| `pull <model>` | Download/register model from Ollama Registry or Cloud | `bun run src/index.ts pull gpt-oss:120b-cloud` |
| `signin, login [key]` | Authenticate with your Ollama.com account / API key | `bun run src/index.ts signin` |
| `signout, logout` | Sign out from Ollama Cloud | `bun run src/index.ts signout` |
| `auth, whoami` | Check authentication status & accessible cloud models | `bun run src/index.ts auth` |
| `import-ollama [opts]` | Import models from local `~/.ollama` (zero-copy symlink) | `bun run src/index.ts import-ollama` |
| `list`, `ls` | List all locally stored / registered models | `bun run src/index.ts list` |
| `ps` | List running model processes | `bun run src/index.ts ps` |
| `show <model>` | Show model metadata and manifest | `bun run src/index.ts show gpt-oss:120b-cloud` |
| `rm <model>` | Remove model and unreferenced blobs | `bun run src/index.ts rm llama3.2:1b` |
| `stop <model>` | Stop active inference process | `bun run src/index.ts stop llama3.2:1b` |
| `serve` | Start Ollama Lite HTTP API daemon | `bun run src/index.ts serve --quiet` |
| `serve end` | Stop running Ollama Lite HTTP API daemon | `bun run src/index.ts serve end` |
| `daemon [start\|stop\|restart\|status\|logs]` | Manage `serve --quiet` as a detached background daemon (returns immediately, logs to `<runtimeDir>/daemon.log`) | `bun run src/index.ts daemon` |
| `benchmark <model>` | Run inference benchmark & tok/s metrics | `bun run src/index.ts benchmark llama3.2:1b` |
| `config [get/set/list]` | View or update persistent configuration | `bun run src/index.ts config set apiKey <key>` |

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

### 2. Ollama Cloud Models (Managed Remote Inference & Account Sign In)
Access massive datacenter models (e.g. `gpt-oss:120b-cloud`, `deepseek-v4-pro:preview`, `nemotron-3-ultra:cloud`) seamlessly through Ollama Lite. Cloud models require zero local disk downloads for model weights and proxy streaming inference directly to Ollama Cloud.

```bash
# Interactive Sign In (shows public key and prompts for API key)
bun run src/index.ts signin

# Or sign in with key directly:
bun run src/index.ts signin <your-ollama-api-key>

# Check authentication status and discover accessible models:
bun run src/index.ts auth

# Pull/register a cloud model
bun run src/index.ts pull gpt-oss:120b-cloud

# Run interactive REPL or single-shot generation
bun run src/index.ts run gpt-oss:120b-cloud
bun run src/index.ts run gpt-oss:120b-cloud "Explain the theory of relativity"
```

### 3. Import Existing Local Ollama Models (`~/.ollama`)
If you already have models downloaded by the official Ollama daemon on your system, import them into Ollama Lite without re-downloading gigabytes of data. Ollama Lite creates zero-copy symlinks to your existing blobs:
```bash
# Auto-detects ~/.ollama/models and imports all models
bun run src/index.ts import-ollama

# Or specify a custom path or copy mode
bun run src/index.ts import-ollama --path /var/lib/ollama/models --copy
```

### 4. Built-in Hugging Face Aliases
- `llama3.2:1b` / `llama3.2:3b` (Llama 3.2 Instruct)
- `qwen2.5:0.5b` / `qwen2.5:1.5b` / `qwen2.5-coder:0.5b`
- `smollm2:135m` / `smollm2:360m`
- `gemma2:2b`

### 5. Custom Hugging Face Repositories
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
- `POST /api/auth/signin` - Authenticate with Ollama Cloud API key
- `POST /api/auth/signout` - Clear Ollama Cloud authentication
- `GET  /api/auth/status` - Check authentication status & accessible cloud models
- `GET  /api/auth/key` - Retrieve local ed25519 SSH public key
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
| `idleTimeout` | `OLLAMA_LITE_IDLE_TIMEOUT` | `0` (disabled) | Idle ms before auto-unloading; `0` = never unload, models run until stopped (`stop <model>`, `serve end`) |
| `logLevel` | `OLLAMA_LITE_LOG_LEVEL` | `info` | Logging verbosity (`debug`/`info`/`warn`/`error`/`none`) |
| `apiKey` | `OLLAMA_API_KEY` (`OLLAMA_KEY`, `OLLAMA_LITE_API_KEY` also accepted) | _(unset)_ | Ollama Cloud API key from `https://ollama.com/settings/keys`. Never commit this value. |
| `ollamaCloudHost` | `OLLAMA_CLOUD_HOST` (`OLLAMA_LITE_CLOUD_HOST`) | `https://ollama.com` | Ollama Cloud endpoint (override for testing/mocks) |

### Ollama Cloud Authentication

Prefer verified sign-in over raw config writes:

```bash
bun run src/index.ts signin <your-api-key>  # verifies via GET /v1/models, then saves
bun run src/index.ts auth                   # verify status + list accessible cloud models
```

Notes:

- `config set apiKey <key>` saves without verifying. Keys are trimmed, surrounding quotes and an optional `Bearer ` prefix are stripped. An `ssh-ed25519 ...` public key is rejected — paste the API key from `https://ollama.com/settings/keys`, not your SSH public key.
- Precedence: `Authorization` request header > `OLLAMA_API_KEY` / `OLLAMA_KEY` / `OLLAMA_LITE_API_KEY` env > `~/.ollama-lite/config.json`.
- The `serve` daemon refreshes `apiKey`/`ollamaCloudHost` from disk + env on every request, but restart after key rotation (`serve end` + `serve`) for a clean state.
- Never commit `~/.ollama-lite/config.json`, `.env` files, or `id_ed25519*` keys. Test fixtures in this repo use dummy values (`test-cloud-api-key`, `valid-secret-key`) only.

#### Troubleshooting `401 Unauthorized`

The proxy distinguishes two cases (both keep the `Ollama Cloud authentication failed (401 Unauthorized)` prefix):

- `No API key was sent` — nothing resolved from header/env/file. Set `OLLAMA_API_KEY` or run `signin` / `config set apiKey`.
- `rejected the configured API key (invalid, expired, or revoked)` — a key was sent but Ollama Cloud refused it. Run `auth` to verify, then `signin <new-key>` to replace it.

### Running as a Background Daemon

`serve` blocks the terminal. `daemon` runs the equivalent of `serve --quiet` detached and returns immediately:

```bash
bun run src/index.ts daemon          # start detached (equiv. serve --quiet)
bun run src/index.ts daemon status   # PID, endpoint, log path
bun run src/index.ts daemon logs -n 100
bun run src/index.ts daemon stop     # same PID/shutdown path as `serve end`
bun run src/index.ts daemon restart
```

Details: PID is shared with `serve` (`<runtimeDir>/server.pid`, so `serve end` also stops it), child output goes to `<runtimeDir>/daemon.log`, and the effective host/port/dirs are forwarded to the child. `bun run daemon` is also available as an npm-style shortcut.

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

## Recent Fixes

### Pull-then-run no longer re-downloads `ollama:`-prefixed models

Previously, `pull ollama:gemma3:270m` saved the manifest under the canonical name `gemma3:270m`, but `run ollama:gemma3:270m` looked the manifest up under the raw input and missed it — triggering a full re-download on every run. Storage paths, manifest names, and process-manager keys are now canonicalized (`canonicalModelName` in `src/utils/paths.ts`), so prefixed and bare references share one manifest, one blob, and one inference process.

### Models no longer terminate after an idle timeout

The process manager previously unloaded models after 5 minutes of inactivity (`idleTimeout: 300000`). Auto-unload is now disabled by default (`idleTimeout: 0`): a loaded model stays running until explicitly stopped. To restore the old behavior, run `ollama-lite config set idleTimeout 300000` and restart `serve`/`daemon`. `ps` and `GET /api/ps` report `never` in the expiry column while auto-unload is disabled.

## Running Tests

```bash
bun test
bun run typecheck
```

## License

This project is licensed under the [MIT License](LICENSE).

