# Build "Ollama Lite" with Bun.js + llama.cpp

## Objective

Build a lightweight local LLM manager written in TypeScript and running on the Bun runtime.

The project should provide an Ollama-like CLI and HTTP API, but use `llama.cpp` as the native inference backend.

The primary goal is experimentation and performance comparison against Ollama, especially on low-end ARM64 hardware.

Do **not** implement neural-network inference in TypeScript.

Bun is responsible for:

- model discovery
- model downloading
- model storage
- model metadata
- model lifecycle
- starting/stopping inference processes
- HTTP API
- streaming
- request routing
- basic model configuration
- benchmarking

`llama-server` is responsible for:

- loading GGUF models
- CPU/GPU inference
- token generation
- KV cache
- sampling
- streaming generated tokens

llama.cpp already provides an OpenAI-compatible HTTP server and supports GGUF models, quantization, CPU/GPU backends, streaming, and model retrieval from Hugging Face. Use those capabilities instead of duplicating them.

---

# 1. Architecture

Implement this architecture:

```text
                    Client
                      |
                      | HTTP
                      v
              +---------------+
              |   Bun Server  |
              |               |
              | REST API      |
              | Router        |
              | Model Manager |
              | Process Mgr   |
              +-------+-------+
                      |
                      | localhost HTTP
                      v
              +---------------+
              | llama-server  |
              |               |
              | llama.cpp     |
              +-------+-------+
                      |
                      v
                   GGUF
                      |
                      v
                 CPU / GPU
```

The Bun process must not perform inference itself.

For each loaded model, Bun may launch a separate `llama-server` process.

Example:

```text
Bun
 |
 +-- llama-server :41001
 |       |
 |       +-- llama3.2:1b
 |
 +-- llama-server :41002
         |
         +-- another-model
```

Only start a model process when that model is actually requested.

---

# 2. Technology

Use:

- Bun
- TypeScript
- native `llama-server`
- GGUF models
- Hugging Face-compatible model repositories
- JSON or SQLite for metadata

Avoid unnecessary dependencies.

Prefer Bun built-ins wherever possible:

- `Bun.serve()`
- `Bun.spawn()`
- `fetch()`
- `Bun.file()`
- `Bun.write()`
- Bun's built-in SQLite support if persistence becomes necessary

Do not introduce Express, Fastify, Axios, or another framework unless there is a demonstrated technical reason.

---

# 3. Project structure

Create:

```text
ollama-lite/
├── src/
│   ├── index.ts
│   ├── cli.ts
│   ├── config.ts
│   │
│   ├── api/
│   │   ├── server.ts
│   │   ├── router.ts
│   │   ├── chat.ts
│   │   ├── generate.ts
│   │   ├── models.ts
│   │   └── health.ts
│   │
│   ├── models/
│   │   ├── registry.ts
│   │   ├── manifest.ts
│   │   ├── resolver.ts
│   │   ├── downloader.ts
│   │   └── storage.ts
│   │
│   ├── runtime/
│   │   ├── process-manager.ts
│   │   ├── llama-server.ts
│   │   ├── health-check.ts
│   │   └── port-manager.ts
│   │
│   └── utils/
│       ├── paths.ts
│       ├── logging.ts
│       └── hashing.ts
│
├── models/
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

Keep inference-specific functionality isolated inside `runtime/`.

---

# 4. Configuration

Create a configuration system with sensible defaults.

Example:

```json
{
  "host": "127.0.0.1",
  "port": 11434,
  "modelsDir": "~/.ollama-lite/models",
  "runtimeDir": "~/.ollama-lite/runtime",
  "defaultContext": 2048,
  "defaultQuantization": "Q4_K_M",
  "idleTimeout": 300000,
  "llamaServer": "llama-server"
}
```

Allow environment variables to override configuration.

Example:

```text
OLLAMA_LITE_HOST
OLLAMA_LITE_PORT
OLLAMA_LITE_MODELS
OLLAMA_LITE_RUNTIME
OLLAMA_LITE_LLAMA_SERVER
OLLAMA_LITE_CONTEXT
OLLAMA_LITE_IDLE_TIMEOUT
```

---

# 5. Model naming

Support model names such as:

```text
llama3.2:1b
gemma3:270m
qwen3:0.6b
```

Internally resolve them to a model descriptor.

Example:

```ts
interface ModelDescriptor {
  name: string;
  repository: string;
  quantization: string;
  filename?: string;
  context?: number;
}
```

Example:

```json
{
  "name": "llama3.2:1b",
  "repository": "some-compatible-gguf-repository",
  "quantization": "Q4_K_M"
}
```

Do not hard-code a single model into the runtime.

---

# 6. Automatic model retrieval

This is one of the most important features.

When the user executes:

```bash
ollama-lite run llama3.2:1b
```

or sends:

```http
POST /api/chat
```

with:

```json
{
  "model": "llama3.2:1b"
}
```

the system must:

1. Parse the model name.
2. Check the local registry.
3. Check whether the GGUF file exists.
4. If it exists, use it.
5. If it does not exist, resolve the remote model.
6. Download the required GGUF file.
7. Verify the downloaded file.
8. Store the model.
9. Register it locally.
10. Start `llama-server`.
11. Wait until `/health` reports ready.
12. Forward the original request.

The first request should therefore automatically bootstrap the model.

Conceptually:

```text
request
   |
   v
model exists?
   |
   +---- yes ---> start/load ---> inference
   |
   no
   |
   v
resolve remote model
   |
   v
download
   |
   v
verify
   |
   v
register
   |
   v
start llama-server
   |
   v
health check
   |
   v
inference
```

llama.cpp itself supports Hugging Face model retrieval, including repository and quantization selection. Use the upstream mechanisms where practical rather than implementing a fragile custom Hugging Face protocol.

---

# 7. Model storage

Use content-addressed storage where practical.

Suggested structure:

```text
~/.ollama-lite/
├── models/
│   ├── manifests/
│   │   └── llama3.2-1b.json
│   │
│   └── blobs/
│       ├── sha256-abc123...
│       └── sha256-def456...
│
├── runtime/
│   ├── llama3.2-1b/
│   │   ├── config.json
│   │   └── stdout.log
│   │
│   └── gemma3-270m/
│
└── config.json
```

The manifest should point to the actual blob.

This allows multiple model aliases to potentially reference the same underlying file.

---

# 8. Safe downloads

Implement downloads using streaming rather than loading the entire model into RAM.

Never do:

```ts
const data = await response.arrayBuffer();
```

for a multi-hundred-megabyte model.

Instead:

```text
HTTP response
      |
      v
stream
      |
      +--> file
      |
      +--> SHA-256
```

Track:

- total bytes
- downloaded bytes
- percentage
- download speed
- elapsed time

Expose progress through the CLI.

Example:

```text
Downloading llama3.2:1b
████████████████░░░░ 78%
412 MB / 528 MB
18.4 MB/s
```

Use temporary files:

```text
model.gguf.part
```

and rename to the final filename only after successful verification.

If the process is interrupted, clean up or safely resume the partial download.

---

# 9. Model verification

Calculate SHA-256 while downloading.

Store:

```json
{
  "sha256": "...",
  "size": 123456789,
  "filename": "model.Q4_K_M.gguf"
}
```

Never treat an incomplete download as a valid model.

If the checksum does not match:

1. Delete the invalid file.
2. Report the failure.
3. Do not start `llama-server`.

---

# 10. Runtime process manager

Implement a `ProcessManager`.

Example interface:

```ts
interface ModelProcess {
  model: string;
  port: number;
  process: Subprocess;
  startedAt: number;
  lastUsedAt: number;
}
```

Required operations:

```ts
start(model)
stop(model)
restart(model)
get(model)
list()
touch(model)
```

When starting a model:

```ts
const process = Bun.spawn([
  llamaServerPath,
  "-m",
  modelPath,
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "-c",
  String(contextSize)
]);
```

Bun's `Bun.spawn()` is specifically designed for launching child processes and provides access to their streams and lifecycle.

Do not shell-concatenate commands.

Use argument arrays.

---

# 11. Dynamic ports

Never assume every model uses port 8080.

Maintain a small port allocator:

```text
41000
41001
41002
41003
...
```

Example:

```text
llama3.2:1b -> 41000
gemma3:270m -> 41001
qwen3:0.6b  -> 41002
```

Release ports when processes terminate.

---

# 12. Health checking

After starting `llama-server`, poll:

```text
GET http://127.0.0.1:<port>/health
```

The server exposes a health endpoint that reports an unavailable state while loading and a successful state when the model is ready.

Implement:

```ts
await waitForHealthy(port, {
  timeout: 120_000,
  interval: 250
});
```

If the process exits before becoming healthy:

- capture stderr
- capture exit code
- mark the model as failed
- return a useful error

Do not blindly wait forever.

---

# 13. Automatic unloading

Implement an idle timeout.

Example:

```text
idleTimeout = 5 minutes
```

Every request updates:

```ts
process.lastUsedAt = Date.now();
```

A periodic cleanup task checks:

```text
Date.now() - lastUsedAt > idleTimeout
```

If true:

```text
stop llama-server
release port
release memory
```

This is particularly important on low-RAM hardware.

---

# 14. API compatibility

Implement a small Ollama-compatible API subset.

Required:

```text
GET  /api/tags
GET  /api/ps
POST /api/show
POST /api/pull
POST /api/delete
POST /api/generate
POST /api/chat
```

Also provide OpenAI compatibility:

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/completions
```

Do not attempt to implement every Ollama feature in the first version.

The purpose is to create a lightweight experimental runtime.

---

# 15. Chat endpoint

Implement:

```http
POST /api/chat
```

Input:

```json
{
  "model": "llama3.2:1b",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ],
  "stream": true
}
```

The request flow must be:

```text
/api/chat
   |
   v
resolve model
   |
   v
ensure model available
   |
   v
ensure llama-server running
   |
   v
POST /v1/chat/completions
   |
   v
stream response
   |
   v
client
```

---

# 16. Streaming

Streaming is mandatory.

Do not buffer the entire response before returning it.

Use Web Streams / `ReadableStream`.

The desired behavior is:

```text
llama-server
     |
     | token
     v
Bun
     |
     | token
     v
client
```

The client should begin receiving output immediately after generation begins.

Avoid unnecessary parsing and serialization in the hot path.

---

# 17. Model lifecycle states

Implement explicit states:

```ts
type ModelState =
  | "unknown"
  | "downloading"
  | "available"
  | "starting"
  | "ready"
  | "busy"
  | "stopping"
  | "stopped"
  | "error";
```

This will prevent race conditions.

For example, if five clients simultaneously request:

```text
llama3.2:1b
```

do NOT launch five copies.

Instead:

```text
request A ─┐
request B ─┼──> same model startup promise
request C ─┤
request D ─┘
```

All requests wait for the same startup operation.

---

# 18. Concurrency

Implement a per-model startup lock.

Conceptually:

```ts
Map<string, Promise<ModelProcess>>
```

If a model is already starting:

```ts
return existingPromise;
```

rather than starting another process.

Initially allow one inference server per model.

Do not optimize multi-user batching until the basic implementation works.

`llama-server` itself supports parallel decoding and continuous batching, so those capabilities can be exposed later rather than recreated in Bun.

---

# 19. CLI

Implement:

```bash
ollama-lite run llama3.2:1b
ollama-lite pull llama3.2:1b
ollama-lite list
ollama-lite ps
ollama-lite show llama3.2:1b
ollama-lite rm llama3.2:1b
ollama-lite stop llama3.2:1b
ollama-lite serve
```

`run` should provide an interactive terminal chat.

Example:

```text
$ ollama-lite run llama3.2:1b

Model: llama3.2:1b
Quantization: Q4_K_M
Context: 2048

> Hello

Hello! ...

> exit
```

---

# 20. Interactive CLI streaming

The CLI must display tokens as they arrive.

Do not wait for the complete response.

Use:

```text
user input
    ↓
HTTP request
    ↓
stream
    ↓
stdout
```

---

# 21. Benchmark mode

This is important because the purpose of the project is comparison.

Implement:

```bash
ollama-lite benchmark llama3.2:1b
```

Measure separately:

```text
download time
model load time
prompt processing speed
generation speed
total latency
RAM usage
```

At minimum report:

```text
Model:              llama3.2:1b
Quantization:       Q4_K_M

Load time:          1.83 s
Prompt tokens:      32
Prompt processing:  245 tok/s
Generation:         18.7 tok/s
Generated tokens:   128
Total generation:   6.84 s
```

Do not mix model-download time with inference speed.

Benchmark at least three runs after the model is already downloaded.

Report:

```text
run 1
run 2
run 3
average
median
```

Also report whether the model process was already warm.

---

# 22. Ollama comparison

Create:

```bash
ollama-lite benchmark llama3.2:1b
```

and separately run equivalent tests against Ollama.

Use:

- identical model
- identical GGUF quantization where possible
- identical context size
- identical prompt
- identical output token limit
- identical hardware
- no other heavy workloads

Compare:

```text
cold startup
warm startup
prompt processing
generation tok/s
RAM
CPU utilization
```

Do not claim Bun itself is faster simply because the wrapper is smaller.

The inference backend is doing almost all computationally expensive work.

The experiment is primarily testing:

```text
Ollama orchestration
vs
Bun orchestration
```

while keeping the inference backend as equivalent as possible.

---

# 23. First model target

Start with one model only:

```text
Llama 3.2 1B
```

Use a GGUF quantization appropriate for the target hardware, initially:

```text
Q4_K_M
```

Do not implement a giant model catalog initially.

Once the pipeline works, add:

```text
Gemma 3 270M
Qwen 0.6B
other small GGUF models
```

---

# 24. Error handling

Every subsystem must return useful errors.

Examples:

```text
Model not found
Download failed
Checksum mismatch
llama-server executable not found
Port unavailable
Model failed to load
Model process exited unexpectedly
Request timed out
Invalid model manifest
Unsupported model
```

Do not expose raw stack traces to API clients unless running in development mode.

Log detailed errors to the server log.

---

# 25. Logging

Provide levels:

```text
error
warn
info
debug
```

Example:

```text
[INFO] Model requested: llama3.2:1b
[INFO] Model not found locally
[INFO] Resolving remote model
[INFO] Downloading 524 MB
[INFO] Download complete
[INFO] SHA-256 verified
[INFO] Starting llama-server on port 41000
[INFO] Model ready
[INFO] Request started
[INFO] Request completed: 18.7 tok/s
```

Do not log prompt contents by default.

---

# 26. Security

Bind the server to:

```text
127.0.0.1
```

by default.

Do not expose it to the LAN unless explicitly configured.

If remote access is enabled, require explicit configuration:

```text
OLLAMA_LITE_HOST=0.0.0.0
```

Never execute model names, paths, or user input through a shell.

Always use `Bun.spawn([...])`.

Validate filesystem paths.

Prevent path traversal.

---

# 27. Performance principles

The implementation should prioritize:

1. Minimal dependencies.
2. Streaming.
3. Low memory overhead.
4. Native inference.
5. No unnecessary data copies.
6. Lazy model loading.
7. Automatic unloading.
8. Efficient process management.
9. Simple HTTP routing.
10. Correctness before optimization.

Do not prematurely optimize TypeScript code that is insignificant compared with model inference.

---

# 28. Important implementation constraint

Do not implement these in the first version:

- transformer inference
- tokenizer implementation
- quantization
- GPU kernels
- tensor operations
- custom KV cache
- custom sampling engine
- model conversion
- custom model format

Those belong to the native inference backend.

The entire point of this project is to create a lightweight manager around an existing high-performance backend.

---

# 29. Development milestones

## Milestone 1

Create:

```text
Bun HTTP server
+
Bun CLI
+
Bun.spawn()
+
llama-server
```

Prove that:

```text
Bun → llama-server → model → response
```

works.

---

## Milestone 2

Add model registry.

Implement:

```bash
ollama-lite list
ollama-lite show
ollama-lite ps
```

---

## Milestone 3

Add automatic model resolution and downloading.

Test:

```bash
ollama-lite run llama3.2:1b
```

on a completely clean machine.

The expected behavior is:

```text
model missing
↓
download automatically
↓
verify
↓
start
↓
chat
```

---

## Milestone 4

Add streaming.

Verify that generated tokens appear incrementally.

---

## Milestone 5

Add automatic model unloading.

Test:

```text
start
↓
use
↓
wait idle timeout
↓
process terminates
↓
RAM decreases
```

---

## Milestone 6

Add benchmark mode.

Produce reproducible measurements.

---

## Milestone 7

Add Ollama-compatible endpoints.

Test existing clients against:

```text
http://localhost:11434
```

where practical.

---

# 30. Definition of done

The project is considered successful when this works on a clean machine:

```bash
bun install
bun run src/index.ts run llama3.2:1b
```

with no manual model download.

The application should:

```text
1. Detect missing model
2. Resolve model
3. Download GGUF
4. Verify checksum
5. Store model
6. Start llama-server
7. Wait for health
8. Accept chat request
9. Stream generated tokens
10. Stop idle model
11. Start it again on the next request
```

And:

```bash
bun run src/index.ts benchmark llama3.2:1b
```

must produce reproducible inference metrics.

---

# 31. Final engineering principle

Keep the boundary extremely clean:

```text
                    Bun
       ┌──────────────────────────┐
       │ model management         │
       │ downloading              │
       │ manifests                │
       │ lifecycle                │
       │ HTTP API                 │
       │ streaming                │
       │ CLI                      │
       │ benchmarking             │
       └────────────┬─────────────┘
                    │
                    │ HTTP
                    ▼
             llama-server
       ┌──────────────────────────┐
       │ llama.cpp                │
       │ GGUF                     │
       │ quantization             │
       │ tokenization             │
       │ KV cache                 │
       │ CPU/GPU inference        │
       └──────────────────────────┘
```

Bun should be fast, boring glue.

llama.cpp should be the computational wizard.

If a feature can already be delegated to `llama-server`, delegate it rather than rebuilding it.

The eventual goal is a tiny executable that behaves approximately like:

```bash
ollama-lite run llama3.2:1b
```

but underneath is simply:

```text
Bun
+
model manager
+
llama-server
+
GGUF
```

with enough control to make meaningful performance comparisons against Ollama.