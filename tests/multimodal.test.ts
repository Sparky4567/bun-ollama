import { afterEach, expect, test, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ollamaMessages, imageDataURL, requireVision, validateOpenAIImages } from '../src/api/multimodal.ts';
import { normalizeChatMessages, handleOllamaChat, handleOpenAIChat } from '../src/api/chat.ts';
import { handleOllamaGenerate } from '../src/api/generate.ts';
import { handleShowModel, modelCapabilities } from '../src/api/models.ts';
import { downloadModel } from '../src/models/downloader.ts';
import { scanLocalOllamaModels, importLocalOllamaModel } from '../src/models/ollama-local.ts';
import { loadConfig } from '../src/config.ts';
import { saveManifest, getManifest, deleteModel } from '../src/models/storage.ts';
import { createManifest } from '../src/models/manifest.ts';
import { spawnLlamaServer } from '../src/runtime/llama-server.ts';
import type { ProcessManager } from '../src/runtime/process-manager.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const dirs: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { spies.splice(0).forEach(s => s.mockRestore()); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
function setup() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'ollama-vision-')); dirs.push(dir);
  return { dir, config: loadConfig({ modelsDir: path.join(dir, 'models'), runtimeDir: path.join(dir, 'runtime'), logLevel: 'none' }) };
}
async function fixture() {
  const { dir, config } = setup();
  const model = path.join(dir, 'model.gguf'), projector = path.join(dir, 'projector.gguf');
  fs.writeFileSync(model, 'model'); fs.writeFileSync(projector, 'projector');
  const manifest = createManifest({ name: 'vision:latest', digest: 'sha256:abc123', size: 14, quantization: 'F16', repository: 'test', filename: 'model.gguf', blobPath: model,
    projector: { digest: 'sha256:def456', blob_path: projector, size: 9 }, capabilities: ['completion', 'vision'] });
  await saveManifest(manifest, config);
  return { dir, config, manifest };
}
const pm = { ensureModelReady: async () => ({ port: 12345 }), touch() {} } as unknown as ProcessManager;
function req(url: string, body: unknown) { return new Request(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }); }
function mockFetch(callback: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  spies.push(spyOn(globalThis, 'fetch').mockImplementation(callback as typeof fetch));
}

test('Ollama image conversion keeps images in history when adjacent roles merge', () => {
  const original = [{ role: 'user', content: 'First', images: [png] }, { role: 'user', content: 'Second', images: [png] }];
  const result = normalizeChatMessages(ollamaMessages(original).messages);
  expect(result).toHaveLength(1);
  expect(result[0]!.content).toEqual([
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }, { type: 'text', text: 'First' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }, { type: 'text', text: 'Second' },
  ]);
  expect(original[0]!.images).toEqual([png]);
  expect(normalizeChatMessages([{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }])[0]!.content).toBe('A\nB');
});

test('malformed images and excessive image counts fail before inference', () => {
  expect(imageDataURL(`data:image/jpeg;base64,${png}`)).toBe(`data:image/png;base64,${png}`);
  for (const bad of ['', 'not base64!', Buffer.from('text').toString('base64')]) expect(() => imageDataURL(bad)).toThrow();
  expect(() => ollamaMessages([{ role: 'user', content: '', images: Array(9).fill(png) }])).toThrow();
  expect(() => validateOpenAIImages([{ content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }])).toThrow();
});

test('chat forwards multimodal parts and leaves text-only requests intact', async () => {
  const { config } = await fixture();
  mockFetch((_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect((init as RequestInit & { timeout: boolean }).timeout).toBe(false);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(body.messages[0].content[0].image_url.url).toBe(`data:image/png;base64,${png}`);
    expect(body.messages[0].content[1].text).toBe('What is this?');
    return Response.json({ choices: [{ message: { content: 'A white pixel.' }, finish_reason: 'stop' }] });
  });
  const response = await handleOllamaChat(req('/api/chat', { model: 'vision:latest', stream: false, messages: [{ role: 'user', content: 'What is this?', images: [png] }] }), pm, config);
  expect(response.status).toBe(200);
  expect((await response.json() as any).message.content).toBe('A white pixel.');
});

test('OpenAI image parts survive role normalization', async () => {
  const { config } = await fixture();
  const parts = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }, { type: 'text', text: 'Describe' }];
  mockFetch((_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect(body.messages[0].content).toEqual(parts);
    return Response.json({ choices: [{ message: { content: 'White.' } }] });
  });
  const response = await handleOpenAIChat(req('/v1/chat/completions', { model: 'vision:latest', messages: [{ role: 'user', content: parts }] }), pm, config);
  expect(response.status).toBe(200);
});

test('image generate supports non-streaming and streaming response envelopes', async () => {
  const { config } = await fixture();
  mockFetch((_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect(body.messages[1].content[0].type).toBe('image_url');
    if (!body.stream) return Response.json({ choices: [{ message: { content: 'White.' }, finish_reason: 'stop' }] });
    return new Response('data: {"choices":[{"delta":{"content":"White."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  });
  for (const stream of [false, true]) {
    const response = await handleOllamaGenerate(req('/api/generate', { model: 'vision:latest', prompt: 'Describe', system: 'Be concise', images: [png], stream }), pm, config);
    expect(response.status).toBe(200);
    const chunks = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(chunks.map(c => c.response).join('')).toBe('White.');
    expect(chunks.at(-1).done).toBe(true);
    expect(chunks[0].message).toBeUndefined();
  }
});

test('capabilities report installed projectors, and text-only models reject images before loading', async () => {
  const { config, manifest } = await fixture();
  const shown = await handleShowModel(req('/api/show', { model: manifest.name }), config);
  expect((await shown.json() as any).capabilities).toContain('vision');
  fs.unlinkSync(manifest.projector!.blob_path);
  expect(modelCapabilities(manifest)).not.toContain('vision');
  expect(() => requireVision(manifest)).toThrow();
  let loaded = false;
  const response = await handleOllamaChat(req('/api/chat', { model: manifest.name, messages: [{ role: 'user', content: 'See', images: [png] }] }), { ensureModelReady: async () => { loaded = true; } } as unknown as ProcessManager, config);
  expect(response.status).toBe(400);
  expect(loaded).toBe(false);
});

test('pull downloads and verifies both model and projector, then reuses cached blobs', async () => {
  const { config } = setup();
  const model = Buffer.from('GGUF-model'), projector = Buffer.from('GGUF-projector');
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  let downloads = 0;
  mockFetch(url => {
    if (url.includes('/manifests/')) return Response.json({ layers: [
      { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${hash(model)}`, size: model.length },
      { mediaType: 'application/vnd.ollama.image.projector', digest: `sha256:${hash(projector)}`, size: projector.length },
    ] });
    downloads++;
    return new Response(url.endsWith(hash(model)) ? model : projector);
  });
  const manifest = await downloadModel('ollama:vision:latest', { config });
  expect(manifest.capabilities).toContain('vision');
  expect(manifest.size).toBe(model.length + projector.length);
  expect(fs.readFileSync(manifest.projector!.blob_path)).toEqual(projector);
  await downloadModel('ollama:vision:latest', { config });
  expect(downloads).toBe(2);
  fs.writeFileSync(manifest.projector!.blob_path, 'truncated');
  const repaired = await downloadModel('ollama:vision:latest', { config });
  expect(fs.readFileSync(repaired.projector!.blob_path)).toEqual(projector);
  expect(downloads).toBe(3);
});

test('failed projector verification never publishes an incomplete model', async () => {
  const { config } = setup();
  mockFetch(url => url.includes('/manifests/') ? Response.json({ layers: [
    { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${createHash('sha256').update('model').digest('hex')}`, size: 5 },
    { mediaType: 'application/vnd.ollama.image.projector', digest: `sha256:${'f'.repeat(64)}`, size: 5 },
  ] }) : new Response('model'));
  await expect(downloadModel('ollama:broken:latest', { config })).rejects.toThrow('Checksum verification failed');
  expect(await getManifest('broken:latest', config)).toBeNull();
  expect(fs.readdirSync(path.join(config.modelsDir, 'blobs')).some(name => name.endsWith('.part'))).toBe(false);
});

test('local import retains projector in copy and symlink modes; deletion preserves shared references', async () => {
  const { dir, config } = setup();
  const ollama = path.join(dir, 'ollama');
  const manifests = path.join(ollama, 'manifests/registry.ollama.ai/library/vision');
  const blobs = path.join(ollama, 'blobs');
  fs.mkdirSync(manifests, { recursive: true }); fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, 'sha256-111'), 'model'); fs.writeFileSync(path.join(blobs, 'sha256-222'), 'projector');
  fs.writeFileSync(path.join(manifests, 'latest'), JSON.stringify({ layers: [
    { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:111', size: 5 },
    { mediaType: 'application/vnd.ollama.image.projector', digest: 'sha256:222', size: 9 },
  ] }));
  const discovered = (await scanLocalOllamaModels(ollama))[0]!;
  expect(discovered.size).toBe(14);
  const first = await importLocalOllamaModel(discovered, { config, mode: 'copy' });
  expect(fs.readFileSync(first.projector!.blob_path, 'utf8')).toBe('projector');
  const shared = await importLocalOllamaModel(discovered, { config, mode: 'symlink', targetName: 'alias:latest' });
  await deleteModel(first.name, config);
  expect(fs.existsSync(shared.projector!.blob_path)).toBe(true);
  await deleteModel(shared.name, config);
  expect(fs.existsSync(shared.projector!.blob_path)).toBe(false);
  const linked = await importLocalOllamaModel(discovered, { config, mode: 'symlink' });
  expect(fs.lstatSync(linked.projector!.blob_path).isSymbolicLink()).toBe(true);
  fs.unlinkSync(path.join(blobs, 'sha256-222'));
  expect(await scanLocalOllamaModels(ollama)).toHaveLength(0);
});

test.skipIf(process.platform === 'win32')('runtime passes the projector and a single inference slot to llama-server', async () => {
  const { dir, config, manifest } = await fixture();
  const executable = path.join(dir, 'fake-llama-server');
  const argsPath = path.join(dir, 'args.json');
  fs.writeFileSync(executable, '#!' + process.execPath + '\nawait Bun.write(' + JSON.stringify(argsPath) + ', JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const options = { modelName: manifest.name, modelPath: manifest.blob_path, projectorPath: manifest.projector!.blob_path, ollamaTemplate: '{{ if .Prompt }} Question: {{ .Prompt }}\n\n{{ end }} Answer: {{ .Response }}', port: 12345, llamaServerBin: executable, runtimeDir: config.runtimeDir };
  const server = spawnLlamaServer(options);
  await server.process.exited;
  const args = JSON.parse(fs.readFileSync(argsPath, 'utf8')) as string[];
  expect(args.slice(args.indexOf('--mmproj'), args.indexOf('--mmproj') + 2)).toEqual(['--mmproj', manifest.projector!.blob_path]);
  expect(args.slice(args.indexOf('--parallel'), args.indexOf('--parallel') + 2)).toEqual(['--parallel', '1']);
  expect(args[args.indexOf('--chat-template') + 1]).toContain('Question: ');
  fs.unlinkSync(manifest.projector!.blob_path);
  expect(() => spawnLlamaServer(options)).toThrow('Vision projector missing');
});
