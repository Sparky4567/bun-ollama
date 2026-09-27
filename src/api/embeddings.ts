import type { ProcessManager } from "../runtime/process-manager.ts";
import { type Config } from "../config.ts";
import { getManifest } from "../models/storage.ts";
import { getEffectiveApiKey, getRemoteHost, getRemoteModelName, buildCloudAuthError } from "../runtime/cloud-client.ts";
import { logger } from "../utils/logging.ts";

export const LITE_VERSION = "0.1.0";

/**
 * GET /api/version - Returns the server version (Ollama compatible).
 */
export function handleVersion(): Response {
  return Response.json({ version: LITE_VERSION });
}

interface EmbedProxyParams {
  req: Request;
  remotePath: string;
  body: any;
  modelName: string;
  manifest: any;
  config: Config;
}

/**
 * Proxies an embeddings request body to Ollama Cloud, rewriting the
 * local `-cloud` suffixed name to the remote model name.
 */
async function proxyCloudEmbed({ req, remotePath, body, modelName, manifest, config }: EmbedProxyParams): Promise<Response> {
  const remoteHost = getRemoteHost(manifest, config);
  const remoteModel = getRemoteModelName(modelName, manifest);
  const apiKey = getEffectiveApiKey(config, req.headers.get("authorization"));
  const targetUrl = `${remoteHost}${remotePath}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "bun-ollama-lite/1.0",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: remoteModel }),
    });
    if (upstreamRes.status === 401) {
      return Response.json({ error: buildCloudAuthError(Boolean(apiKey)) }, { status: 401 });
    }
    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text().catch(() => upstreamRes.statusText);
      return Response.json(
        { error: `Ollama Cloud error: ${errorText || upstreamRes.statusText}` },
        { status: upstreamRes.status }
      );
    }
    const data: any = await upstreamRes.json();
    if (data && typeof data === "object" && body.model) data.model = body.model;
    return Response.json(data);
  } catch (err: any) {
    logger.error(`Failed to connect to Ollama Cloud ${remotePath}: ${err.message}`);
    return Response.json({ error: `Cloud connection error: ${err.message}` }, { status: 502 });
  }
}

/**
 * POST /api/embed - Ollama embeddings endpoint.
 * Request: { model, input: string | string[], truncate?, options?, keep_alive? }
 * Response: { model, embeddings: number[][] }
 */
export async function handleOllamaEmbed(
  req: Request,
  processManager: ProcessManager,
  config: Config
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const modelName = body.model;
  if (!modelName) return Response.json({ error: "Missing required 'model' field" }, { status: 400 });
  if (body.input === undefined) return Response.json({ error: "Missing required 'input' field" }, { status: 400 });

  let modelProc;
  try {
    modelProc = await processManager.ensureModelReady(modelName);
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
  processManager.touch(modelName);

  if (modelProc.isCloud) {
    const manifest = await getManifest(modelName, config);
    return proxyCloudEmbed({
      req,
      remotePath: "/api/embed",
      body,
      modelName,
      manifest: manifest || ({ name: modelName, remote_model: modelProc.remoteModel, remote_host: modelProc.remoteHost } as any),
      config,
    });
  }

  // Local: forward to llama-server OpenAI-compatible embeddings endpoint.
  const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, input: inputs }),
    });
    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text().catch(() => upstreamRes.statusText);
      return Response.json({ error: `Embedding backend error: ${errorText}` }, { status: upstreamRes.status });
    }
    const openaiJson: any = await upstreamRes.json();
    const embeddings: number[][] = (openaiJson.data || [])
      .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      .map((d: any) => d.embedding || []);
    return Response.json({ model: modelName, embeddings });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/embeddings - Legacy Ollama embeddings endpoint.
 * Request: { model, prompt: string }
 * Response: { embedding: number[] }
 */
export async function handleOllamaEmbeddingsLegacy(
  req: Request,
  processManager: ProcessManager,
  config: Config
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const modelName = body.model;
  if (!modelName) return Response.json({ error: "Missing required 'model' field" }, { status: 400 });
  if (typeof body.prompt !== "string") return Response.json({ error: "Missing required 'prompt' field" }, { status: 400 });

  let modelProc;
  try {
    modelProc = await processManager.ensureModelReady(modelName);
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
  processManager.touch(modelName);

  if (modelProc.isCloud) {
    const manifest = await getManifest(modelName, config);
    const proxied = await proxyCloudEmbed({
      req,
      remotePath: "/api/embed",
      body: { model: body.model, input: body.prompt },
      modelName,
      manifest: manifest || ({ name: modelName, remote_model: modelProc.remoteModel, remote_host: modelProc.remoteHost } as any),
      config,
    });
    // Translate new-style { embeddings: [[...]] } back to legacy { embedding: [...] }
    try {
      const data: any = await proxied.json();
      if (proxied.ok && Array.isArray(data.embeddings)) {
        return Response.json({ embedding: data.embeddings[0] || [] });
      }
      return Response.json(data, { status: proxied.status });
    } catch {
      return proxied;
    }
  }

  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, input: body.prompt }),
    });
    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text().catch(() => upstreamRes.statusText);
      return Response.json({ error: `Embedding backend error: ${errorText}` }, { status: upstreamRes.status });
    }
    const openaiJson: any = await upstreamRes.json();
    return Response.json({ embedding: openaiJson.data?.[0]?.embedding || [] });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint.
 */
export async function handleOpenAIEmbeddings(
  req: Request,
  processManager: ProcessManager,
  config: Config
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const modelName = body.model;
  if (!modelName) return Response.json({ error: "Missing required 'model' field" }, { status: 400 });

  let modelProc;
  try {
    modelProc = await processManager.ensureModelReady(modelName);
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
  processManager.touch(modelName);

  if (modelProc.isCloud) {
    const manifest = await getManifest(modelName, config);
    const remoteHost = getRemoteHost(manifest, config);
    const remoteModel = getRemoteModelName(modelName, manifest);
    const apiKey = getEffectiveApiKey(config, req.headers.get("authorization"));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    try {
      const upstreamRes = await fetch(`${remoteHost}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, model: remoteModel }),
      });
      return new Response(upstreamRes.body, { status: upstreamRes.status, headers: upstreamRes.headers });
    } catch (err: any) {
      return Response.json({ error: `Cloud connection error: ${err.message}` }, { status: 502 });
    }
  }

  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: upstreamRes.headers });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
