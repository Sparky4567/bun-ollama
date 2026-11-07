import type { ProcessManager } from "../runtime/process-manager.ts";
import { type Config } from "../config.ts";
import { getManifest } from "../models/storage.ts";
import { proxyCloudGenerate, proxyCloudOpenAICompletions } from "../runtime/cloud-client.ts";
import { handleOllamaChat } from "./chat.ts";
import { logger } from "../utils/logging.ts";

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  images?: string[];
  system?: string;
  template?: string;
  context?: number[];
  stream?: boolean;
  raw?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    max_tokens?: number;
    repeat_penalty?: number;
    stop?: string[];
  };
}

/**
 * Handles POST /api/generate (Ollama compatible generate/completion endpoint).
 */
export async function handleOllamaGenerate(
  req: Request,
  processManager: ProcessManager,
  config: Config
): Promise<Response> {
  let body: OllamaGenerateRequest;
  try {
    body = (await req.json()) as OllamaGenerateRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const modelName = body.model;
  if (!modelName) {
    return Response.json({ error: "Missing required 'model' field" }, { status: 400 });
  }

  if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > 0)) {
    if (!Array.isArray(body.images)) return Response.json({ error: "Images must be an array." }, { status: 400 });
    if (body.raw || body.template || body.context?.length) return Response.json({ error: "Image generation requests do not support raw, template or token context. Use /api/chat for multimodal history." }, { status: 400 });
    const chatBody = { ...body, messages: [
      ...(body.system ? [{ role: 'system', content: body.system }] : []),
      { role: 'user', content: body.prompt || '', images: body.images },
    ] };
    const response = await handleOllamaChat(new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(chatBody), signal: req.signal }), processManager, config);
    if (!response.ok) return response;
    const envelope = (chunk: any) => {
      const { message, ...rest } = chunk;
      return { ...rest, response: message?.content || '', ...(chunk.done ? { context: [] } : {}) };
    };
    if (body.stream === false) return Response.json(envelope(await response.json()));
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) controller.enqueue(encoder.encode(JSON.stringify(envelope(JSON.parse(line))) + '\n'));
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) controller.enqueue(encoder.encode(JSON.stringify(envelope(JSON.parse(buffer))) + '\n'));
      },
    });
    return new Response(response.body!.pipeThrough(transform), { headers: { 'Content-Type': 'application/x-ndjson' } });
  }

  const prompt = body.prompt || "";
  const stream = body.stream !== false; // Ollama defaults to stream: true

  const startTime = Date.now();
  logger.info(`Generate request for model: ${modelName} (stream: ${stream})`);

  let modelProc;
  try {
    modelProc = await processManager.ensureModelReady(modelName);
  } catch (err: any) {
    logger.error(`Failed to ready model ${modelName}: ${err.message}`);
    return Response.json({ error: err.message }, { status: 500 });
  }

  processManager.touch(modelName);

  // If this is an Ollama Cloud model, proxy to Ollama Cloud
  if (modelProc.isCloud) {
    const manifest = await getManifest(modelName, config);
    return await proxyCloudGenerate({
      req,
      body,
      manifest: manifest || ({
        name: modelName,
        digest: modelProc.digest,
        size: modelProc.size,
        format: "cloud",
        quantization: "cloud",
        repository: "registry.ollama.ai",
        filename: "(cloud)",
        blob_path: "",
        modified_at: new Date().toISOString(),
        is_cloud: true,
        remote_host: modelProc.remoteHost,
        remote_model: modelProc.remoteModel,
      } as any),
      config,
    });
  }

  // Combine system prompt if provided
  let fullPrompt = prompt;
  if (body.system) {
    fullPrompt = `${body.system}\n\n${prompt}`;
  }

  const llamaPayload = {
    prompt: fullPrompt,
    stream,
    n_predict: body.options?.num_predict || body.options?.max_tokens || 512,
    temperature: body.options?.temperature,
    top_p: body.options?.top_p,
    top_k: body.options?.top_k,
    repeat_penalty: body.options?.repeat_penalty,
    stop: body.options?.stop,
  };

  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(llamaPayload),
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      const errorText = await upstreamRes.text().catch(() => "");
      logger.error(`Upstream llama-server returned HTTP ${upstreamRes.status}: ${errorText}`);
      return Response.json(
        { error: `Inference server error: ${errorText || upstreamRes.statusText}` },
        { status: upstreamRes.status }
      );
    }

    if (!stream) {
      // Non-streaming response
      const llamaJson: any = await upstreamRes.json();
      const responseText = llamaJson.content || "";
      const totalDurationNs = (Date.now() - startTime) * 1_000_000;
      const promptTokens = llamaJson.timings?.prompt_n || 0;
      const evalTokens = llamaJson.timings?.predicted_n || 0;

      return Response.json({
        model: modelName,
        created_at: new Date().toISOString(),
        response: responseText,
        done: true,
        done_reason: llamaJson.stop ? "stop" : "length",
        context: [],
        total_duration: totalDurationNs,
        load_duration: 0,
        prompt_eval_count: promptTokens,
        prompt_eval_duration: (llamaJson.timings?.prompt_ms || 0) * 1_000_000,
        eval_count: evalTokens,
        eval_duration: (llamaJson.timings?.predicted_ms || 0) * 1_000_000,
      });
    }

    // Streaming NDJSON response
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const upstreamReader = upstreamRes.body.getReader();

    let evalCount = 0;
    let buffer = "";
    let doneSent = false;

    const streamBody = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await upstreamReader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              // llama-server /completion streams plain NDJSON (no "data:" prefix).
              // Strip an optional SSE "data: " prefix if present (for forward compatibility).
              const dataStr = trimmed.startsWith("data:") ? trimmed.replace(/^data:\s*/, "") : trimmed;
              if (dataStr === "[DONE]") {
                continue;
              }

              try {
                const parsed = JSON.parse(dataStr);
                const token = parsed.content || "";
                const isStop = parsed.stop === true;

                if (token) {
                  evalCount++;
                  const chunkObj = {
                    model: modelName,
                    created_at: new Date().toISOString(),
                    response: token,
                    done: false,
                  };
                  controller.enqueue(encoder.encode(JSON.stringify(chunkObj) + "\n"));
                }

                if (isStop) {
                  doneSent = true;
                  const totalDurationNs = (Date.now() - startTime) * 1_000_000;
                  const finalChunk = {
                    model: modelName,
                    created_at: new Date().toISOString(),
                    response: "",
                    done: true,
                    done_reason: "stop",
                    context: [],
                    total_duration: totalDurationNs,
                    load_duration: 0,
                    prompt_eval_count: parsed.timings?.prompt_n || 0,
                    prompt_eval_duration: (parsed.timings?.prompt_ms || 0) * 1_000_000,
                    eval_count: parsed.timings?.predicted_n || evalCount,
                    eval_duration: (parsed.timings?.predicted_ms || 0) * 1_000_000,
                  };
                  controller.enqueue(encoder.encode(JSON.stringify(finalChunk) + "\n"));
                }
              } catch {
                // Ignore json parse error on partial chunks
              }
            }
          }

          // Send fallback done packet only when the upstream ended without a stop chunk.
          // When doneSent=true the client already received done:true and may have cancelled
          // the stream, closing the controller — enqueueing again would throw an error.
          if (!doneSent) {
            const totalDurationNs = (Date.now() - startTime) * 1_000_000;
            const finalFallback = {
              model: modelName,
              created_at: new Date().toISOString(),
              response: "",
              done: true,
              done_reason: "stop",
              context: [],
              total_duration: totalDurationNs,
              load_duration: 0,
              prompt_eval_count: 0,
              prompt_eval_duration: 0,
              eval_count: evalCount,
              eval_duration: totalDurationNs,
            };
            controller.enqueue(encoder.encode(JSON.stringify(finalFallback) + "\n"));
          }

          try {
            controller.close();
          } catch {
            // Client may have already cancelled the stream — safe to ignore.
          }
        } catch (err: any) {
          // Ignore "Controller is already closed" which happens when the client
          // cancels the stream after receiving the done:true packet.
          if (!String(err?.message).includes("Controller is already closed")) {
            logger.error(`Streaming error during generate: ${err.message}`);
          }
          try {
            controller.error(err);
          } catch {
            // Controller may already be closed/errored — safe to ignore.
          }
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
    logger.error(`Failed to forward generate request: ${err.message}`);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Handles POST /v1/completions (OpenAI compatible completions).
 */
export async function handleOpenAICompletions(
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
  if (!modelName) {
    return Response.json({ error: "Missing required 'model' field" }, { status: 400 });
  }

  const modelProc = await processManager.ensureModelReady(modelName);
  processManager.touch(modelName);

  if (modelProc.isCloud) {
    const manifest = await getManifest(modelName, config);
    return await proxyCloudOpenAICompletions({
      req,
      body,
      manifest: manifest || ({
        name: modelName,
        digest: modelProc.digest,
        size: modelProc.size,
        format: "cloud",
        quantization: "cloud",
        repository: "registry.ollama.ai",
        filename: "(cloud)",
        blob_path: "",
        modified_at: new Date().toISOString(),
        is_cloud: true,
        remote_host: modelProc.remoteHost,
        remote_model: modelProc.remoteModel,
      } as any),
      config,
    });
  }

  const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: upstreamRes.headers,
  });
}
