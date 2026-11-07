import fs from 'node:fs';
import type { ModelManifest } from '../models/manifest.ts';

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } };
export type ChatContent = string | ContentPart[] | null;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 8;

export function imageDataURL(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('Images must be non-empty base64 strings.');
  const base64 = value.startsWith('data:') ? value.match(/^data:image\/[\w.+-]+;base64,([\s\S]+)$/)?.[1] : value;
  if (!base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) throw new Error('Invalid image base64 or image exceeds 20 MB.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB.');
  const ascii = (a: number, b: number) => bytes.subarray(a, b).toString('ascii');
  let mime: string;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') mime = 'image/webp';
  else if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) mime = 'image/gif';
  else if (ascii(0, 2) === 'BM') mime = 'image/bmp';
  else throw new Error('Unsupported image data. Use PNG, JPEG, WebP, GIF or BMP.');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function ollamaMessages<T extends { role: string; content: string; images?: string[] }>(messages: T[]) {
  let count = 0;
  const converted = messages.map(message => {
    if (!message || typeof message.role !== 'string' || typeof message.content !== 'string') throw new Error('Each message requires a role and text content.');
    if (message.images !== undefined && !Array.isArray(message.images)) throw new Error('Message images must be an array of base64 strings.');
    const { images, content, ...rest } = message;
    count += images?.length || 0;
    if (count > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images are allowed per request.`);
    return { ...rest, content: images?.length ? [
      ...images.map(image => ({ type: 'image_url' as const, image_url: { url: imageDataURL(image) } })),
      { type: 'text' as const, text: content },
    ] : content };
  });
  return { messages: converted, hasImages: count > 0 };
}

export function validateOpenAIImages(messages: { content?: ChatContent }[]): boolean {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'image_url') continue;
      if (++count > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images are allowed per request.`);
      const url = part.image_url?.url;
      if (typeof url !== 'string') throw new Error('An image_url part requires a URL.');
      if (url.startsWith('data:')) imageDataURL(url);
      else if (!/^https?:\/\//i.test(url)) throw new Error('Image URLs must use HTTP, HTTPS, or a base64 data URL.');
    }
  }
  return count > 0;
}

export function requireVision(manifest: ModelManifest | null): void {
  // Cloud providers validate their own models; local models need an installed projector.
  if (!manifest || manifest.is_cloud || manifest.format === 'cloud' || manifest.source === 'ollama-cloud') return;
  if (!manifest.projector || !fs.existsSync(manifest.projector.blob_path)) throw new Error('This local model has no vision projector. Pull a vision model again (for example: ollama-lite pull moondream:latest).');
}

// Bun otherwise closes a socket after five idle minutes even while a CPU vision
// encoder is working. Request cancellation remains controlled by the caller.
export function inferenceFetch(url: string, init: RequestInit): Promise<Response> {
  const options = { ...init, timeout: false };
  return fetch(url, options);
}
