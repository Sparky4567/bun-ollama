import { type Config } from "../config.ts";
import {
  listManifests,
  getManifest,
  deleteModel,
} from "../models/storage.ts";
import { downloadModel } from "../models/downloader.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import { logger } from "../utils/logging.ts";

/**
 * GET /api/tags - Lists all installed models in Ollama format.
 */
export async function handleListTags(config: Config): Promise<Response> {
  const manifests = await listManifests(config);

  const models = manifests.map((m) => ({
    name: m.name,
    model: m.name,
    modified_at: m.modified_at,
    size: m.size,
    digest: m.digest,
    details: {
      parent_model: "",
      format: m.format,
      family: m.name.split(":")[0] || "llama",
      families: [m.name.split(":")[0] || "llama"],
      parameter_size: m.name.includes(":") ? m.name.split(":")[1]?.toUpperCase() : "unknown",
      quantization_level: m.quantization,
    },
  }));

  return Response.json({ models });
}

/**
 * GET /api/ps - Lists all actively running models.
 */
export async function handleListRunning(
  processManager: ProcessManager,
  config: Config
): Promise<Response> {
  const running = processManager.list();
  const now = Date.now();

  const models = running.map((p) => {
    const expiresAt = new Date(p.lastUsedAt + config.idleTimeout).toISOString();
    return {
      name: p.model,
      model: p.model,
      size: p.size,
      digest: p.digest,
      details: {
        parent_model: "",
        format: "gguf",
        family: p.model.split(":")[0] || "llama",
        families: [p.model.split(":")[0] || "llama"],
        parameter_size: p.model.includes(":") ? p.model.split(":")[1]?.toUpperCase() : "unknown",
        quantization_level: "Q4_K_M",
      },
      expires_at: expiresAt,
      size_vram: 0,
      port: p.port,
      state: p.state,
    };
  });

  return Response.json({ models });
}

/**
 * POST /api/show - Gets detailed information about a specific model.
 */
export async function handleShowModel(
  req: Request,
  config: Config
): Promise<Response> {
  let modelName = "";
  try {
    const body: any = await req.json();
    modelName = body.name || body.model || "";
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!modelName) {
    return Response.json({ error: "Missing required 'name' field" }, { status: 400 });
  }

  const manifest = await getManifest(modelName, config);
  if (!manifest) {
    return Response.json({ error: `Model "${modelName}" not found` }, { status: 404 });
  }

  const parametersStr = Object.entries(manifest.parameters || {})
    .filter(([k]) => k !== "system_prompt" && k !== "template")
    .map(([k, v]) => `${k} ${Array.isArray(v) ? JSON.stringify(v) : v}`)
    .join("\n") || `num_ctx ${manifest.parameters?.context_size || 2048}`;

  const modelfileLines = [
    `# Model manifest for ${manifest.name}`,
    `FROM ${manifest.filename}`,
  ];
  if (manifest.system || manifest.parameters?.system_prompt) {
    modelfileLines.push(`SYSTEM """${manifest.system || manifest.parameters?.system_prompt}"""`);
  }
  if (manifest.template) {
    modelfileLines.push(`TEMPLATE """${manifest.template}"""`);
  }
  if (manifest.parameters) {
    for (const [k, v] of Object.entries(manifest.parameters)) {
      if (k !== "system_prompt" && k !== "template") {
        modelfileLines.push(`PARAMETER ${k} ${Array.isArray(v) ? JSON.stringify(v) : v}`);
      }
    }
  }

  return Response.json({
    license: manifest.license || "Unknown",
    modelfile: modelfileLines.join("\n"),
    parameters: parametersStr,
    template: manifest.template || "{{ .System }}\n{{ .Prompt }}",
    system: manifest.system || manifest.parameters?.system_prompt || "",
    details: {
      parent_model: "",
      format: manifest.format,
      family: manifest.name.split(":")[0] || "llama",
      families: [manifest.name.split(":")[0] || "llama"],
      parameter_size: manifest.name.includes(":") ? manifest.name.split(":")[1]?.toUpperCase() : "unknown",
      quantization_level: manifest.quantization,
    },
    model_info: {
      "general.architecture": manifest.name.split(":")[0] || "llama",
      "general.file_type": manifest.quantization,
      "general.parameter_count": manifest.size,
    },
    modified_at: manifest.modified_at,
  });
}

/**
 * POST /api/pull - Pulls/downloads a model with optional streaming progress.
 */
export async function handlePullModel(
  req: Request,
  config: Config
): Promise<Response> {
  let modelName = "";
  let stream = true;

  try {
    const body: any = await req.json();
    modelName = body.name || body.model || "";
    if (body.stream !== undefined) {
      stream = Boolean(body.stream);
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!modelName) {
    return Response.json({ error: "Missing required 'name' field" }, { status: 400 });
  }

  if (!stream) {
    try {
      await downloadModel(modelName, { config });
      return Response.json({ status: "success" });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Streaming NDJSON response
  const encoder = new TextEncoder();
  const streamBody = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: any) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        sendEvent({ status: "pulling manifest" });

        await downloadModel(modelName, {
          config,
          onProgress(p) {
            if (p.status === "resolving") {
              sendEvent({ status: "resolving model repository" });
            } else if (p.status === "downloading") {
              sendEvent({
                status: "downloading",
                digest: p.model,
                total: p.totalBytes,
                completed: p.downloadedBytes,
              });
            } else if (p.status === "verifying") {
              sendEvent({ status: "verifying sha256 digest" });
            } else if (p.status === "completed") {
              sendEvent({ status: "success" });
            }
          },
        });

        controller.close();
      } catch (err: any) {
        sendEvent({ error: err.message });
        controller.close();
      }
    },
  });

  return new Response(streamBody, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    },
  });
}

/**
 * DELETE /api/delete or POST /api/delete - Deletes a local model.
 */
export async function handleDeleteModel(
  req: Request,
  config: Config,
  processManager: ProcessManager
): Promise<Response> {
  let modelName = "";

  const url = new URL(req.url);
  modelName = url.searchParams.get("name") || "";

  if (!modelName && req.method !== "GET") {
    try {
      const body: any = await req.json();
      modelName = body.name || body.model || "";
    } catch {
      // ignore
    }
  }

  if (!modelName) {
    return Response.json({ error: "Missing required 'name' parameter" }, { status: 400 });
  }

  // Stop process if running
  await processManager.stop(modelName);

  const deleted = await deleteModel(modelName, config);
  if (!deleted) {
    return Response.json({ error: `Model "${modelName}" not found` }, { status: 404 });
  }

  return Response.json({ status: "success" });
}

/**
 * GET /v1/models - OpenAI compatible model list.
 */
export async function handleOpenAIListModels(config: Config): Promise<Response> {
  const manifests = await listManifests(config);

  const data = manifests.map((m) => ({
    id: m.name,
    object: "model",
    created: Math.floor(new Date(m.modified_at).getTime() / 1000),
    owned_by: "ollama-lite",
  }));

  return Response.json({
    object: "list",
    data,
  });
}
