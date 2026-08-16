import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("Configuration Manager", () => {
  it("loads default configuration", () => {
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(11434);
    expect(config.defaultContext).toBe(2048);
    expect(config.defaultQuantization).toBe("Q4_K_M");
    expect(config.idleTimeout).toBe(300_000);
  });

  it("applies config overrides", () => {
    const customConfig = loadConfig({
      port: 19999,
      defaultContext: 4096,
      defaultQuantization: "Q8_0",
    });

    expect(customConfig.port).toBe(19999);
    expect(customConfig.defaultContext).toBe(4096);
    expect(customConfig.defaultQuantization).toBe("Q8_0");
  });

  it("discovers llama-server binary location", () => {
    const config = loadConfig();
    expect(config.llamaServer).toBeDefined();
    expect(typeof config.llamaServer).toBe("string");
  });
});
