import type { ProcessManager } from "../runtime/process-manager.ts";
import { type Config } from "../config.ts";
import { logger } from "../utils/logging.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  format?: string;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    max_tokens?: number;
    repeat_penalty?: number;
    stop?: string[];
  };
  keep_alive?: string | number;
}

/**
 * Maps Ollama options to OpenAI / llama-server parameters.
 */
function mapChatOptions(options?: OllamaChatRequest["options"]) {
  if (!options) return {};
  return {
    temperature: options.temperature,
    top_p: options.top_p,
    top_k: options.top_k,
    max_tokens: options.num_predict || options.max_tokens,
    presence_penalty: options.repeat_penalty ? options.repeat_penalty - 1 : undefined,
    stop: options.stop,
  };
}

/**
 * Handles POST /api/chat (Ollama compatible chat endpoint).
 */
export async function handleOllamaChat(
  req: Request,
  processManager: ProcessManager,
  config: Config
): Promise<Response> {
  let body: OllamaChatRequest;
  try {
    body = (await req.json()) as OllamaChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const modelName = body.model;
  if (!modelName) {
    return Response.json({ error: "Missing required 'model' field" }, { status: 400 });
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return Response.json({ error: "Missing or invalid 'messages' array" }, { status: 400 });
  }

  const stream = body.stream !== false; // Ollama defaults to stream: true

  const startTime = Date.now();
  logger.info(`Chat request for model: ${modelName} (stream: ${stream})`);

  let modelProc;
  try {
    modelProc = await processManager.ensureModelReady(modelName);
  } catch (err: any) {
    logger.error(`Failed to ready model ${modelName}: ${err.message}`);
    return Response.json({ error: err.message }, { status: 500 });
  }

  processManager.touch(modelName);

  const llamaPayload = {
    model: modelName,
    messages: body.messages,
    stream,
    ...mapChatOptions(body.options),
  };

  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/v1/chat/completions`, {
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
      const openaiJson: any = await upstreamRes.json();
      const content = openaiJson.choices?.[0]?.message?.content || "";
      const totalDurationNs = (Date.now() - startTime) * 1_000_000;
      const promptTokens = openaiJson.usage?.prompt_tokens || 0;
      const completionTokens = openaiJson.usage?.completion_tokens || 0;

      return Response.json({
        model: modelName,
        created_at: new Date().toISOString(),
        message: {
          role: "assistant",
          content,
        },
        done: true,
        done_reason: openaiJson.choices?.[0]?.finish_reason || "stop",
        total_duration: totalDurationNs,
        load_duration: 0,
        prompt_eval_count: promptTokens,
        prompt_eval_duration: 0,
        eval_count: completionTokens,
        eval_duration: totalDurationNs,
      });
    }

    // Streaming NDJSON response
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const upstreamReader = upstreamRes.body.getReader();

    let evalCount = 0;
    let buffer = "";

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
              if (!trimmed || !trimmed.startsWith("data:")) continue;

              const dataStr = trimmed.replace(/^data:\s*/, "");
              if (dataStr === "[DONE]") {
                continue;
              }

              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta?.content;
                const finishReason = parsed.choices?.[0]?.finish_reason;

                if (delta) {
                  evalCount++;
                  const chunkObj = {
                    model: modelName,
                    created_at: new Date().toISOString(),
                    message: {
                      role: "assistant",
                      content: delta,
                    },
                    done: false,
                  };
                  controller.enqueue(encoder.encode(JSON.stringify(chunkObj) + "\n"));
                }

                if (finishReason) {
                  const totalDurationNs = (Date.now() - startTime) * 1_000_000;
                  const finalChunk = {
                    model: modelName,
                    created_at: new Date().toISOString(),
                    message: {
                      role: "assistant",
                      content: "",
                    },
                    done: true,
                    done_reason: finishReason,
                    total_duration: totalDurationNs,
                    load_duration: 0,
                    prompt_eval_count: parsed.usage?.prompt_tokens || 0,
                    prompt_eval_duration: 0,
                    eval_count: parsed.usage?.completion_tokens || evalCount,
                    eval_duration: totalDurationNs,
                  };
                  controller.enqueue(encoder.encode(JSON.stringify(finalChunk) + "\n"));
                }
              } catch {
                // Ignore parse errors on partial lines
              }
            }
          }

          // Ensure final done packet was sent
          const totalDurationNs = (Date.now() - startTime) * 1_000_000;
          const finalFallback = {
            model: modelName,
            created_at: new Date().toISOString(),
            message: {
              role: "assistant",
              content: "",
            },
            done: true,
            done_reason: "stop",
            total_duration: totalDurationNs,
            load_duration: 0,
            prompt_eval_count: 0,
            prompt_eval_duration: 0,
            eval_count: evalCount,
            eval_duration: totalDurationNs,
          };
          controller.enqueue(encoder.encode(JSON.stringify(finalFallback) + "\n"));

          controller.close();
        } catch (err: any) {
          logger.error(`Streaming error during chat: ${err.message}`);
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
    logger.error(`Failed to forward chat request: ${err.message}`);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Handles POST /v1/chat/completions (OpenAI compatible chat completions).
 */
export async function handleOpenAIChat(
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

  const upstreamRes = await fetch(`http://127.0.0.1:${modelProc.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: upstreamRes.headers,
  });
}
