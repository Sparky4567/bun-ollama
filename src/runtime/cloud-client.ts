import type { Config } from "../config.ts";
import type { ModelManifest } from "../models/manifest.ts";
import type { OllamaChatRequest } from "../api/chat.ts";
import type { OllamaGenerateRequest } from "../api/generate.ts";
import { logger } from "../utils/logging.ts";

/**
 * Resolves the effective API key for Ollama Cloud requests.
 */
export function getEffectiveApiKey(
  config?: Config,
  requestAuthHeader?: string | null
): string | undefined {
  if (requestAuthHeader) {
    const cleaned = requestAuthHeader.trim();
    if (cleaned.toLowerCase().startsWith("bearer ")) {
      return cleaned.slice(7).trim();
    }
    if (cleaned) {
      return cleaned;
    }
  }

  return (
    config?.apiKey ||
    process.env.OLLAMA_API_KEY ||
    process.env.OLLAMA_KEY ||
    process.env.OLLAMA_LITE_API_KEY ||
    undefined
  );
}

/**
 * Returns remote host URL from manifest or config.
 */
export function getRemoteHost(manifest?: ModelManifest | null, config?: Config): string {
  let host = manifest?.remote_host || config?.ollamaCloudHost || "https://ollama.com";
  // Remove trailing slashes
  return host.replace(/\/+$/, "");
}

/**
 * Returns remote model name (e.g. "gpt-oss:120b" for "gpt-oss:120b-cloud").
 */
export function getRemoteModelName(modelName: string, manifest?: ModelManifest | null): string {
  if (manifest?.remote_model) {
    return manifest.remote_model;
  }
  return modelName;
}

/**
 * Proxies POST /api/chat to Ollama Cloud.
 */
export async function proxyCloudChat(params: {
  req: Request;
  body: OllamaChatRequest;
  manifest: ModelManifest;
  config: Config;
}): Promise<Response> {
  const { req, body, manifest, config } = params;
  const remoteHost = getRemoteHost(manifest, config);
  const remoteModel = getRemoteModelName(body.model, manifest);
  const apiKey = getEffectiveApiKey(config, req.headers.get("authorization"));

  const targetUrl = `${remoteHost}/api/chat`;
  logger.info(`Proxying chat request for "${body.model}" to Ollama Cloud (${targetUrl})...`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "bun-ollama-lite/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const payload = {
    ...body,
    model: remoteModel,
  };

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (upstreamRes.status === 401) {
      const errDetail =
        "Ollama Cloud authentication failed (401 Unauthorized). Please configure an API key via OLLAMA_API_KEY environment variable, incoming Authorization header, or run `ollama-lite config set apiKey <your-key>`. Get a key at https://ollama.com/settings/keys";
      logger.error(errDetail);
      return Response.json({ error: errDetail }, { status: 401 });
    }

    if (!upstreamRes.ok || !upstreamRes.body) {
      const errorText = await upstreamRes.text().catch(() => upstreamRes.statusText);
      logger.error(`Ollama Cloud chat error (${upstreamRes.status}): ${errorText}`);
      return Response.json(
        { error: `Ollama Cloud error: ${errorText || upstreamRes.statusText}` },
        { status: upstreamRes.status }
      );
    }

    const stream = body.stream !== false;
    if (!stream) {
      const data: any = await upstreamRes.json();
      if (data && typeof data === "object") {
        data.model = body.model;
      }
      return Response.json(data);
    }

    // Stream NDJSON
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstreamRes.body.getReader();
    let buffer = "";

    const streamBody = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const parsed = JSON.parse(trimmed);
                parsed.model = body.model;
                controller.enqueue(encoder.encode(JSON.stringify(parsed) + "\n"));
              } catch {
                controller.enqueue(encoder.encode(trimmed + "\n"));
              }
            }
          }

          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              parsed.model = body.model;
              controller.enqueue(encoder.encode(JSON.stringify(parsed) + "\n"));
            } catch {
              controller.enqueue(encoder.encode(buffer.trim() + "\n"));
            }
          }

          controller.close();
        } catch (err: any) {
          logger.error(`Error streaming from Ollama Cloud chat: ${err.message}`);
          controller.error(err);
        }
      },
    });

    return new Response(streamBody, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err: any) {
    logger.error(`Failed to connect to Ollama Cloud chat: ${err.message}`);
    return Response.json({ error: `Cloud connection error: ${err.message}` }, { status: 502 });
  }
}

/**
 * Proxies POST /api/generate to Ollama Cloud.
 */
export async function proxyCloudGenerate(params: {
  req: Request;
  body: OllamaGenerateRequest;
  manifest: ModelManifest;
  config: Config;
}): Promise<Response> {
  const { req, body, manifest, config } = params;
  const remoteHost = getRemoteHost(manifest, config);
  const remoteModel = getRemoteModelName(body.model, manifest);
  const apiKey = getEffectiveApiKey(config, req.headers.get("authorization"));

  const targetUrl = `${remoteHost}/api/generate`;
  logger.info(`Proxying generate request for "${body.model}" to Ollama Cloud (${targetUrl})...`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "bun-ollama-lite/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const payload = {
    ...body,
    model: remoteModel,
  };

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (upstreamRes.status === 401) {
      const errDetail =
        "Ollama Cloud authentication failed (401 Unauthorized). Please configure an API key via OLLAMA_API_KEY environment variable, incoming Authorization header, or run `ollama-lite config set apiKey <your-key>`. Get a key at https://ollama.com/settings/keys";
      logger.error(errDetail);
      return Response.json({ error: errDetail }, { status: 401 });
    }

    if (!upstreamRes.ok || !upstreamRes.body) {
      const errorText = await upstreamRes.text().catch(() => upstreamRes.statusText);
      logger.error(`Ollama Cloud generate error (${upstreamRes.status}): ${errorText}`);
      return Response.json(
        { error: `Ollama Cloud error: ${errorText || upstreamRes.statusText}` },
        { status: upstreamRes.status }
      );
    }

    const stream = body.stream !== false;
    if (!stream) {
      const data: any = await upstreamRes.json();
      if (data && typeof data === "object") {
        data.model = body.model;
      }
      return Response.json(data);
    }

    // Stream NDJSON
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstreamRes.body.getReader();
    let buffer = "";

    const streamBody = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const parsed = JSON.parse(trimmed);
                parsed.model = body.model;
                controller.enqueue(encoder.encode(JSON.stringify(parsed) + "\n"));
              } catch {
                controller.enqueue(encoder.encode(trimmed + "\n"));
              }
            }
          }

          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              parsed.model = body.model;
              controller.enqueue(encoder.encode(JSON.stringify(parsed) + "\n"));
            } catch {
              controller.enqueue(encoder.encode(buffer.trim() + "\n"));
            }
          }

          controller.close();
        } catch (err: any) {
          logger.error(`Error streaming from Ollama Cloud generate: ${err.message}`);
          controller.error(err);
        }
      },
    });

    return new Response(streamBody, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err: any) {
    logger.error(`Failed to connect to Ollama Cloud generate: ${err.message}`);
    return Response.json({ error: `Cloud connection error: ${err.message}` }, { status: 502 });
  }
}

/**
 * Proxies POST /v1/chat/completions to Ollama Cloud.
 */
export async function proxyCloudOpenAIChat(params: {
  req: Request;
  body: any;
  manifest: ModelManifest;
  config: Config;
}): Promise<Response> {
  const { req, body, manifest, config } = params;
  const remoteHost = getRemoteHost(manifest, config);
  const remoteModel = getRemoteModelName(body.model, manifest);
  const apiKey = getEffectiveApiKey(config, req.headers.get("authorization"));

  const targetUrl = `${remoteHost}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "bun-ollama-lite/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const payload = {
    ...body,
    model: remoteModel,
  };

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: upstreamRes.headers,
    });
  } catch (err: any) {
    return Response.json({ error: { message: `Cloud connection error: ${err.message}` } }, { status: 502 });
  }
}

/**
 * Proxies POST /v1/completions to Ollama Cloud.
 */
export async function proxyCloudOpenAICompletions(params: {
  req: Request;
  body: any;
  manifest: ModelManifest;
  config: Config;
}): Promise<Response> {
  const { req, body, manifest, config } = params;
  const remoteHost = getRemoteHost(manifest, config);
  const remoteModel = getRemoteModelName(body.model, manifest);
  const apiKey = getEffectiveApiKey(config, req.headers.get("authorization"));

  const targetUrl = `${remoteHost}/v1/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "bun-ollama-lite/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const payload = {
    ...body,
    model: remoteModel,
  };

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: upstreamRes.headers,
    });
  } catch (err: any) {
    return Response.json({ error: { message: `Cloud connection error: ${err.message}` } }, { status: 502 });
  }
}

/**
 * Streams chat responses from Ollama Cloud for CLI interactive or single-shot run.
 */
export async function streamCloudChatCli(params: {
  modelName: string;
  messages: Array<{ role: string; content: string }>;
  manifest: ModelManifest;
  config: Config;
  onToken?: (delta: string) => void;
}): Promise<string> {
  const { modelName, messages, manifest, config, onToken } = params;
  const remoteHost = getRemoteHost(manifest, config);
  const remoteModel = getRemoteModelName(modelName, manifest);
  const apiKey = getEffectiveApiKey(config);

  const targetUrl = `${remoteHost}/api/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "bun-ollama-lite/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const payload = {
    model: remoteModel,
    messages,
    stream: true,
  };

  const res = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (res.status === 401) {
    throw new Error(
      "Ollama Cloud authentication failed (401 Unauthorized).\nPlease configure an API key using `ollama-lite config set apiKey <your-key>` or set OLLAMA_API_KEY environment variable.\nGet your API key at: https://ollama.com/settings/keys"
    );
  }

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama Cloud returned HTTP ${res.status}: ${errText}`);
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
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const delta = parsed.message?.content || "";
        if (delta) {
          if (onToken) {
            onToken(delta);
          } else {
            process.stdout.write(delta);
          }
          fullResponse += delta;
        }
      } catch {
        // ignore partial json
      }
    }
  }

  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim());
      const delta = parsed.message?.content || "";
      if (delta) {
        if (onToken) {
          onToken(delta);
        } else {
          process.stdout.write(delta);
        }
        fullResponse += delta;
      }
    } catch {
      // ignore
    }
  }

  return fullResponse;
}
