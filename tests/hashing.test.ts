import { describe, it, expect } from "bun:test";
import {
  createIncrementalHasher,
  formatDigest,
  extractHexHash,
} from "../src/utils/hashing.ts";

describe("Hashing Utilities", () => {
  it("computes SHA-256 incrementally", () => {
    const hasher = createIncrementalHasher();
    hasher.update("hello ");
    hasher.update("world");
    const digest = hasher.digest("hex");

    // SHA-256 of "hello world"
    expect(digest).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("formats and extracts digests properly", () => {
    const hex = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    const formatted = formatDigest(hex);
    expect(formatted).toBe(`sha256:${hex}`);
    expect(extractHexHash(formatted)).toBe(hex);
  });
});
