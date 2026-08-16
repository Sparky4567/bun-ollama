import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import {
  expandPath,
  normalizeModelName,
  validateSafePath,
  getDefaultBaseDir,
} from "../src/utils/paths.ts";

describe("Path Utilities", () => {
  it("expands tilde to home directory", () => {
    const expanded = expandPath("~/models");
    expect(expanded).toBe(path.join(os.homedir(), "models"));
  });

  it("normalizes model names safely", () => {
    expect(normalizeModelName("llama3.2:1b")).toBe("llama3.2-1b");
    expect(normalizeModelName("Qwen/Qwen2.5-0.5B-Instruct-GGUF")).toBe("qwen-qwen2.5-0.5b-instruct-gguf");
    expect(normalizeModelName("bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M")).toBe("bartowski-llama-3.2-1b-instruct-gguf-q4_k_m");
  });

  it("strips path traversal attacks in model names", () => {
    expect(normalizeModelName("../../etc/passwd")).toBe("etc-passwd");
  });

  it("validates safe paths within base directory", () => {
    const base = "/tmp/test-base";
    const validTarget = "/tmp/test-base/subdir/file.txt";
    expect(validateSafePath(base, validTarget)).toBe(path.resolve(validTarget));

    const invalidTarget = "/tmp/other/file.txt";
    expect(() => validateSafePath(base, invalidTarget)).toThrow();
  });
});
