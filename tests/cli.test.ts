import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCliArgs } from "../src/index.ts";
import { saveConfig, loadConfig } from "../src/config.ts";

describe("CLI Argument Parsing", () => {
  it("parses quiet flag (-q and --quiet)", () => {
    const res1 = parseCliArgs(["serve", "-q"]);
    expect(res1.command).toBe("serve");
    expect(res1.logLevel).toBe("warn");

    const res2 = parseCliArgs(["--quiet", "run", "llama3.2:1b"]);
    expect(res2.command).toBe("run");
    expect(res2.args).toEqual(["llama3.2:1b"]);
    expect(res2.logLevel).toBe("warn");
  });

  it("parses silent flag (-s and --silent)", () => {
    const res1 = parseCliArgs(["serve", "-s"]);
    expect(res1.command).toBe("serve");
    expect(res1.logLevel).toBe("none");

    const res2 = parseCliArgs(["--silent", "pull", "qwen2.5:0.5b"]);
    expect(res2.command).toBe("pull");
    expect(res2.args).toEqual(["qwen2.5:0.5b"]);
    expect(res2.logLevel).toBe("none");
  });

  it("parses --log-level flag with equals and space", () => {
    const res1 = parseCliArgs(["serve", "--log-level=error"]);
    expect(res1.command).toBe("serve");
    expect(res1.logLevel).toBe("error");

    const res2 = parseCliArgs(["serve", "--log-level", "none"]);
    expect(res2.command).toBe("serve");
    expect(res2.logLevel).toBe("none");
  });

  it("parses debug flag (-d and --debug)", () => {
    const res = parseCliArgs(["--debug", "ps"]);
    expect(res.command).toBe("ps");
    expect(res.logLevel).toBe("debug");
  });

  it("parses config subcommand arguments", () => {
    const res = parseCliArgs(["config", "set", "logLevel", "none"]);
    expect(res.command).toBe("config");
    expect(res.args).toEqual(["set", "logLevel", "none"]);
  });

  it("handles -- delimiter to stop flag parsing", () => {
    const res = parseCliArgs(["run", "llama3.2:1b", "--", "-q is an argument"]);
    expect(res.command).toBe("run");
    expect(res.args).toEqual(["llama3.2:1b", "-q is an argument"]);
    expect(res.logLevel).toBeUndefined();
  });

  it("parses import-ollama command and flags", () => {
    const res = parseCliArgs(["import-ollama", "--path", "~/.ollama/models", "--copy"]);
    expect(res.command).toBe("import-ollama");
    expect(res.args).toEqual(["--path", "~/.ollama/models", "--copy"]);
  });

  it("parses serve end command and subarguments", () => {
    const res1 = parseCliArgs(["serve", "end"]);
    expect(res1.command).toBe("serve");
    expect(res1.args).toEqual(["end"]);

    const res2 = parseCliArgs(["serve", "stop"]);
    expect(res2.command).toBe("serve");
    expect(res2.args).toEqual(["stop"]);

    const res3 = parseCliArgs(["--quiet", "serve", "end"]);
    expect(res3.command).toBe("serve");
    expect(res3.args).toEqual(["end"]);
    expect(res3.logLevel).toBe("warn");
  });
});
