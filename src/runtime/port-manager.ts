import net from "node:net";

export class PortManager {
  private startPort: number;
  private endPort: number;
  private allocatedPorts: Map<string, number> = new Map(); // model -> port
  private usedPorts: Set<number> = new Set();

  constructor(startPort = 41000, endPort = 42000) {
    this.startPort = startPort;
    this.endPort = endPort;
  }

  /**
   * Tests whether a TCP port is currently free and bindable on localhost.
   */
  async isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();

      server.on("error", () => {
        resolve(false);
      });

      server.listen(port, "127.0.0.1", () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
  }

  /**
   * Allocates a free port for a given model.
   */
  async allocatePort(model: string): Promise<number> {
    // If model already has a port allocated, reuse it
    const existing = this.allocatedPorts.get(model);
    if (existing && !this.usedPorts.has(existing)) {
      const isFree = await this.isPortFree(existing);
      if (isFree) {
        this.usedPorts.add(existing);
        return existing;
      }
    }

    for (let port = this.startPort; port <= this.endPort; port++) {
      if (!this.usedPorts.has(port)) {
        const isFree = await this.isPortFree(port);
        if (isFree) {
          this.usedPorts.add(port);
          this.allocatedPorts.set(model, port);
          return port;
        }
      }
    }

    throw new Error(`Port manager exhausted: no available ports in range ${this.startPort}-${this.endPort}`);
  }

  /**
   * Releases an allocated port.
   */
  releasePort(portOrModel: number | string): void {
    if (typeof portOrModel === "number") {
      this.usedPorts.delete(portOrModel);
      for (const [model, port] of this.allocatedPorts.entries()) {
        if (port === portOrModel) {
          this.allocatedPorts.delete(model);
          break;
        }
      }
    } else {
      const port = this.allocatedPorts.get(portOrModel);
      if (port) {
        this.usedPorts.delete(port);
        this.allocatedPorts.delete(portOrModel);
      }
    }
  }

  getPortForModel(model: string): number | undefined {
    return this.allocatedPorts.get(model);
  }
}

export const portManager = new PortManager();
