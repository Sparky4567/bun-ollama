import fs from "node:fs";

export interface IncrementalHasher {
  update(chunk: Uint8Array | ArrayBuffer | string): void;
  digest(encoding?: "hex"): string;
}

/**
 * Creates an incremental SHA-256 hasher using Bun's native CryptoHasher.
 */
export function createIncrementalHasher(): IncrementalHasher {
  const hasher = new Bun.CryptoHasher("sha256");
  return {
    update(chunk: Uint8Array | ArrayBuffer | string) {
      if (typeof chunk === "string") {
        hasher.update(Buffer.from(chunk));
      } else if (chunk instanceof ArrayBuffer) {
        hasher.update(new Uint8Array(chunk));
      } else {
        hasher.update(chunk);
      }
    },
    digest(encoding = "hex") {
      return hasher.digest(encoding);
    },
  };
}

/**
 * Computes the SHA-256 hash of a file by streaming its contents.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const stream = file.stream();
  const reader = stream.getReader();
  const hasher = createIncrementalHasher();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hasher.update(value);
    }
  }

  return hasher.digest("hex");
}

/**
 * Formats a raw hex hash as an Ollama/OCI-style digest (sha256:<hex>).
 */
export function formatDigest(hexHash: string): string {
  if (hexHash.startsWith("sha256:")) {
    return hexHash;
  }
  return `sha256:${hexHash}`;
}

/**
 * Extracts raw hex hash from a digest string.
 */
export function extractHexHash(digest: string): string {
  if (digest.startsWith("sha256:")) {
    return digest.slice(7);
  }
  return digest;
}
