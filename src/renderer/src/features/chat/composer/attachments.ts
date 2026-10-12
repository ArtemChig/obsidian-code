// Image attachments for the composer (paste / drag-drop / file picker). Owner: ui-chat.
import type { ImageBlock } from '@shared/types';
import { toast } from '@renderer/state/toasts';
import { parseDataUrl } from '../lib/composer';
import { setAttachments, useChatLocal } from '../state';

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
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
      toast({ title: `${f.name || 'Image'} is too large`, body: 'Images must be 10 MB or smaller.', level: 'warning' });
      continue;
    }
    try {
      const parsed = parseDataUrl(await readAsDataUrl(f));
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
