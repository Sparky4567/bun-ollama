export interface HealthCheckOptions {
  timeoutMs?: number;
  intervalMs?: number;
  process?: {
    exitCode?: number | null;
    killed?: boolean;
    getStderr?: () => string;
  };
}

/**
 * Polls llama-server's /health endpoint until it reports ready or fails.
 */
export async function waitForHealthy(
  port: number,
  options?: HealthCheckOptions
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const intervalMs = options?.intervalMs ?? 250;
  const startTime = Date.now();
  const url = `http://127.0.0.1:${port}/health`;

  while (Date.now() - startTime < timeoutMs) {
    // Check if the underlying subprocess has crashed
    if (options?.process && options.process.exitCode !== null && options.process.exitCode !== undefined) {
      const stderr = options.process.getStderr ? options.process.getStderr() : "";
      throw new Error(
        `llama-server process exited unexpectedly with code ${options.process.exitCode} before becoming healthy.\n${stderr}`
      );
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(intervalMs * 2) });
      if (res.status === 200) {
        const body = (await res.json().catch(() => ({ status: "ok" }))) as any;
        if (body.status === "ok" || body.status === "ready" || res.ok) {
          return true;
        }
      }
      // Status 503 means model is still loading - continue polling
    } catch {
      // Connection refused or timed out - server still starting, continue polling
    }

    await Bun.sleep(intervalMs);
  }

  const stderr = options?.process?.getStderr ? options.process.getStderr() : "";
  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for llama-server on port ${port} to become healthy.\n${stderr}`
  );
}
