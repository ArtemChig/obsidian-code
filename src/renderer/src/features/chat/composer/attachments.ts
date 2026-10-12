// Image attachments for the composer (paste / drag-drop / file picker). Owner: ui-chat.
import type { ImageBlock } from '@shared/types';
import { toast } from '@renderer/state/toasts';
import { MAX_IMAGE_SIDE, fitWithin, parseDataUrl, reencodeType } from '../lib/composer';
import { setAttachments, useChatLocal } from '../state';

export const MAX_IMAGES = 8;
/** Limit on the source file; what is attached is downscaled to ≤ MAX_IMAGE_SIDE px, so it ends up far smaller. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ACCEPTED = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Read an image as a data URL, downscaled on a canvas to ≤ MAX_IMAGE_SIDE px on the long side (aspect kept).
 * JPEG sources stay JPEG (q 0.9); everything else becomes PNG. Images already small enough in a format every vision
 * model accepts (PNG/JPEG) are passed through untouched. Falls back to the original bytes if decoding fails.
 */
export async function readImageDownscaled(file: File): Promise<string> {
  const passthrough = /^image\/(png|jpe?g)$/i.test(file.type);
  let decoded: Awaited<ReturnType<typeof decode>> | null = null;
  try {
    decoded = await decode(file);
    const { width, height, scaled } = fitWithin(decoded.width, decoded.height, MAX_IMAGE_SIDE);
    if (!scaled && passthrough) return await readAsDataUrl(file);
    if (!width || !height) return await readAsDataUrl(file);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return await readAsDataUrl(file);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const type = reencodeType(file.type);
    if (type === 'image/jpeg') {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, width, height);
    }
    g.drawImage(decoded.source, 0, 0, width, height);
    return canvas.toDataURL(type, type === 'image/jpeg' ? 0.9 : undefined);
  } catch {
    return readAsDataUrl(file);
  } finally {
    decoded?.close();
  }
}

export function isImageFile(f: File): boolean {
  return ACCEPTED.test(f.type);
}

/** Read image files and append them to a session's attachments. Returns how many were added. */
export async function addImageFiles(sessionId: string, files: File[]): Promise<number> {
  const images = files.filter(isImageFile);
  if (!images.length) return 0;
  const current = useChatLocal.getState().attachments[sessionId] ?? [];
  const room = MAX_IMAGES - current.length;
  if (room <= 0) {
    toast({ title: `Up to ${MAX_IMAGES} images per message`, level: 'warning' });
    return 0;
  }
  const added: ImageBlock[] = [];
  for (const f of images.slice(0, room)) {
    if (f.size > MAX_IMAGE_BYTES) {
      toast({ title: `${f.name || 'Image'} is too large`, body: 'Images must be 30 MB or smaller.', level: 'warning' });
      continue;
    }
    try {
      const parsed = parseDataUrl(await readImageDownscaled(f));
      if (parsed) added.push({ type: 'image', mediaType: parsed.mediaType, data: parsed.data, name: f.name || `pasted-${Date.now()}.png` });
    } catch {
      toast({ title: `Could not read ${f.name || 'the image'}`, level: 'error' });
    }
  }
  if (images.length > room) toast({ title: `Only ${room} more image${room === 1 ? '' : 's'} fit in this message`, level: 'warning' });
  if (added.length) {
    const latest = useChatLocal.getState().attachments[sessionId] ?? [];
    setAttachments(sessionId, [...latest, ...added]);
  }
  return added.length;
}

export function removeAttachment(sessionId: string, index: number): void {
  const cur = useChatLocal.getState().attachments[sessionId] ?? [];
  setAttachments(
    sessionId,
    cur.filter((_, i) => i !== index),
  );
}

/** Files from a DataTransfer (drop or paste). */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  } else {
    for (const f of Array.from(dt.files ?? [])) out.push(f);
  }
  return out;
}
