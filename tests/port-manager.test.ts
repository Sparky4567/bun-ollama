import { describe, it, expect } from "bun:test";
import { PortManager } from "../src/runtime/port-manager.ts";

describe("Port Manager", () => {
  it("allocates and checks free ports", async () => {
    const pm = new PortManager(45000, 45010);
    const port1 = await pm.allocatePort("model-a");
    expect(port1).toBeGreaterThanOrEqual(45000);
    expect(port1).toBeLessThanOrEqual(45010);

    const port2 = await pm.allocatePort("model-b");
    expect(port2).toBeGreaterThanOrEqual(45000);
    expect(port2).not.toBe(port1);

    // Release port
    pm.releasePort("model-a");
    pm.releasePort("model-b");
  });

  it("reuses allocated port for the same model", async () => {
    const pm = new PortManager(45020, 45030);
    const portA = await pm.allocatePort("model-c");
    const portA2 = pm.getPortForModel("model-c");
    expect(portA2).toBe(portA);
    pm.releasePort("model-c");
  });
});
