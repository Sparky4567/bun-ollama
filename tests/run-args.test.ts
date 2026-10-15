import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseRunArgs, resolveRunMessages } from "../src/cli.ts";

describe("run --messages-json / --messages-file parsing", () => {
  it("leaves plain prompts untouched", () => {
    const parsed = parseRunArgs(["Why", "is", "the", "sky", "blue?"]);
    expect(parsed.promptParts).toEqual(["Why", "is", "the", "sky", "blue?"]);
    expect(parsed.messagesJson).toBeUndefined();
    expect(parsed.messagesFile).toBeUndefined();
    expect(resolveRunMessages(parsed)).toBeNull();
  });

  it("extracts --messages-json (space and equals forms)", () => {
    const json = JSON.stringify([{ role: "user", content: "hi" }]);
    expect(parseRunArgs(["--messages-json", json]).messagesJson).toBe(json);
    expect(parseRunArgs([`--messages-json=${json}`]).messagesJson).toBe(json);
    expect(parseRunArgs(["--messages-file", "m.json"]).messagesFile).toBe("m.json");
    expect(parseRunArgs(["--messages-file=m.json"]).messagesFile).toBe("m.json");
  });

  it("keeps surrounding prompt text alongside flags", () => {
    const parsed = parseRunArgs(["hello", "--messages-json", "[]", "world"]);
    expect(parsed.promptParts).toEqual(["hello", "world"]);
  });

  it("resolves a valid role-labeled array", () => {
    const parsed = parseRunArgs([
      "--messages-json",
      JSON.stringify([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Why is the sky blue?" },
      ]),
    ]);
    expect(resolveRunMessages(parsed)).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Why is the sky blue?" },
    ]);
  });

  it("resolves --messages-file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-msgs-"));
    const file = path.join(dir, "messages.json");
    fs.writeFileSync(file, JSON.stringify([{ role: "assistant", content: "prior" }]));
    try {
      const resolved = resolveRunMessages(parseRunArgs(["--messages-file", file]));
      expect(resolved).toEqual([{ role: "assistant", content: "prior" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad input with clear errors", () => {
    expect(() => resolveRunMessages(parseRunArgs(["--messages-json", "not json"]))).toThrow(
      /not valid JSON/
    );
    expect(() => resolveRunMessages(parseRunArgs(["--messages-json", "{}"]))).toThrow(
      /non-empty array/
    );
    expect(() =>
      resolveRunMessages(parseRunArgs(["--messages-json", JSON.stringify([{ role: "tool", content: "x" }])]))
    ).toThrow(/system.*user.*assistant/);
    expect(() => resolveRunMessages(parseRunArgs(["--messages-file", "/nonexistent-xyz/messages.json"]))).toThrow(
      /Cannot read/
    );
  });
});
