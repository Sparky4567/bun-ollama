export function handleHealth(): Response {
  return Response.json({
    status: "ok",
    version: "0.1.0",
    runtime: "bun",
    backend: "llama.cpp",
  });
}
