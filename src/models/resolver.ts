import { MODEL_CATALOG, type ModelDescriptor } from "./registry.ts";
import { resolveOllamaRegistryModel } from "./ollama-registry.ts";
import { normalizeModelName } from "../utils/paths.ts";
import { logger } from "../utils/logging.ts";

/**
 * Resolves a model name string to a full ModelDescriptor containing download URL and metadata.
 * Supports:
 * - Direct HTTP(S) URLs
 * - Built-in catalog aliases (e.g. "llama3.2:1b", "qwen2.5:0.5b")
 * - Hugging Face repositories (e.g. "bartowski/Llama-3.2-1B-Instruct-GGUF")
 * - Official Ollama registry models (e.g. "ollama:llama3.2:1b", "deepseek-r1:8b", "smollm:135m")
 */
export async function resolveModel(
  modelInput: string,
  preferredQuantization = "Q4_K_M"
): Promise<ModelDescriptor> {
  const trimmed = modelInput.trim();

  // 1. Direct HTTP(S) URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    // If it's a direct registry.ollama.ai or ollama.com URL, delegate to Ollama resolver
    if (/^https?:\/\/(registry\.ollama\.ai|ollama\.com|ollama\.ai)/i.test(trimmed)) {
      return await resolveOllamaRegistryModel(trimmed);
    }

    const url = new URL(trimmed);
    const filename = url.pathname.split("/").pop() || "model.gguf";
    const name = filename.replace(/\.gguf$/i, "");
    return {
      name: trimmed,
      normalizedName: normalizeModelName(name),
      repository: url.hostname,
      quantization: preferredQuantization,
      filename,
      downloadUrl: trimmed,
      context: 2048,
      source: "direct-url",
    };
  }

  // 2. Explicit Ollama protocol or prefix ("ollama://...", "ollama:...", "registry.ollama.ai/...")
  if (
    trimmed.startsWith("ollama://") ||
    trimmed.startsWith("ollama:") ||
    /^registry\.ollama\.ai\//i.test(trimmed) ||
    /^ollama\.com\//i.test(trimmed) ||
    /^ollama\.ai\//i.test(trimmed)
  ) {
    return await resolveOllamaRegistryModel(trimmed);
  }

  // 3. Parse model name and optional quantization tag for Hugging Face / catalog
  // Formats: "llama3.2:1b", "llama3.2:1b-q4_k_m", "llama3.2:1b:q8_0", "repo/name:Q4_K_M", "hf.co/repo/name"
  let cleanInput = trimmed.replace(/^hf\.co\//i, "").replace(/^huggingface\.co\//i, "").replace(/^hf:\/\//i, "");
  let requestedQuant: string | undefined;

  const parts = cleanInput.split(":");
  let baseName = parts[0] || "";
  let tag = parts[1] || "";

  if (parts.length === 3) {
    // e.g. "llama3.2:1b:q4_k_m"
    baseName = `${parts[0]}:${parts[1]}`;
    requestedQuant = parts[2]?.toUpperCase();
  } else if (parts.length === 2) {
    if (MODEL_CATALOG[cleanInput.toLowerCase()]) {
      baseName = cleanInput.toLowerCase();
      tag = "";
    } else if (MODEL_CATALOG[baseName.toLowerCase()]) {
      requestedQuant = tag.toUpperCase();
    } else if (cleanInput.includes("/")) {
      // e.g. "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"
      baseName = parts[0]!;
      requestedQuant = parts[1]?.toUpperCase();
    } else {
      // e.g. "llama3.2:1b"
      baseName = cleanInput.toLowerCase();
    }
  }

  // Check for hyphenated quant tag like "llama3.2:1b-q4_k_m"
  if (!requestedQuant && baseName.includes("-q")) {
    const hyphenIdx = baseName.lastIndexOf("-q");
    const potentialQuant = baseName.slice(hyphenIdx + 1).toUpperCase();
    const potentialBase = baseName.slice(0, hyphenIdx);
    if (MODEL_CATALOG[potentialBase]) {
      baseName = potentialBase;
      requestedQuant = potentialQuant;
    }
  }

  const quant = (requestedQuant || preferredQuantization).toUpperCase();

  // 4. Check built-in catalog
  const catalogEntry = MODEL_CATALOG[baseName.toLowerCase()] || MODEL_CATALOG[cleanInput.toLowerCase()];
  if (catalogEntry) {
    const targetQuant = catalogEntry.files[quant] ? quant : catalogEntry.defaultQuant;
    const filename = catalogEntry.files[targetQuant] || catalogEntry.files[catalogEntry.defaultQuant]!;
    const downloadUrl = `https://huggingface.co/${catalogEntry.repo}/resolve/main/${filename}`;

    return {
      name: trimmed,
      normalizedName: normalizeModelName(trimmed),
      repository: catalogEntry.repo,
      quantization: targetQuant,
      filename,
      downloadUrl,
      context: catalogEntry.context,
      source: "huggingface",
    };
  }

  // 5. If it looks like a Hugging Face repository ("user/repo")
  if (baseName.includes("/")) {
    logger.info(`Resolving Hugging Face repository: ${baseName}`);
    try {
      const apiUrl = `https://huggingface.co/api/models/${baseName}`;
      const res = await fetch(apiUrl, {
        headers: { "User-Agent": "bun-ollama-lite/1.0" },
      });

      if (res.ok) {
        const info: any = await res.json();
        const siblings: Array<{ rfilename: string }> = info.siblings || [];
        const ggufFiles = siblings
          .map((s) => s.rfilename)
          .filter((name) => name.toLowerCase().endsWith(".gguf"));

        if (ggufFiles.length > 0) {
          // Find file matching quantization or best match
          let matchedFile = ggufFiles.find((f) =>
            f.toUpperCase().includes(quant.toUpperCase())
          );

          if (!matchedFile) {
            // Fallback to Q4_K_M or first GGUF
            matchedFile =
              ggufFiles.find((f) => f.toUpperCase().includes("Q4_K_M")) ||
              ggufFiles.find((f) => f.toUpperCase().includes("Q4_0")) ||
              ggufFiles[0]!;
          }

          const downloadUrl = `https://huggingface.co/${baseName}/resolve/main/${matchedFile}`;

          return {
            name: trimmed,
            normalizedName: normalizeModelName(trimmed),
            repository: baseName,
            quantization: quant,
            filename: matchedFile,
            downloadUrl,
            context: 2048,
            source: "huggingface",
          };
        }
      }
    } catch {
      // If Hugging Face fails, fall through to Ollama registry check below
    }
  }

  // 6. Try resolving against official Ollama registry (registry.ollama.ai)
  try {
    logger.debug(`Attempting to resolve "${trimmed}" from Ollama registry...`);
    const ollamaDescriptor = await resolveOllamaRegistryModel(trimmed);
    return ollamaDescriptor;
  } catch (ollamaErr: any) {
    logger.debug(`Ollama registry resolution failed: ${ollamaErr.message}`);
  }

  throw new Error(
    `Unsupported model "${trimmed}". Please specify a known model alias (e.g. "llama3.2:1b", "smollm:135m"), an Ollama model ("ollama:model:tag"), or a Hugging Face repo (e.g. "bartowski/Llama-3.2-1B-Instruct-GGUF").`
  );
}
