// Right-click menu of text fields and selected text (owner: platform). Electron shows no context menu by itself, so
// without this a right-click in the composer, the search boxes or a settings field does nothing: no Paste, no Copy.
// Pure (the template only), so it is unit-testable without Electron. The renderer's own menus call preventDefault on
// the contextmenu event, so this only runs where the page has none.

import type { MenuItemConstructorOptions } from 'electron';

/** The parts of Electron's context-menu params this needs. */
export interface ContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  linkURL: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  copyText(text: string): void;
  openLink(url: string): void;
}

const MAX_SUGGESTIONS = 5;

/** The menu for this right-click; empty when there is nothing to offer (then no menu opens). */
export function contextMenuTemplate(p: ContextMenuParams, a: ContextMenuActions): MenuItemConstructorOptions[] {
  const f = p.editFlags;
  if (p.isEditable) {
    const out: MenuItemConstructorOptions[] = [];
    if (p.misspelledWord && p.dictionarySuggestions.length) {
      for (const word of p.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) out.push({ label: word, click: () => a.replaceMisspelling(word) });
      out.push({ type: 'separator' });
    }
    out.push(
      { role: 'undo', enabled: f.canUndo },
      { role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: f.canSelectAll },
    );
    return out;
  }
  const out: MenuItemConstructorOptions[] = [];
  if (p.selectionText.trim()) out.push({ role: 'copy' });
  if (/^(https?:|mailto:)/i.test(p.linkURL)) {
    if (out.length) out.push({ type: 'separator' });
    out.push({ label: 'Open link in browser', click: () => a.openLink(p.linkURL) }, { label: 'Copy link address', click: () => a.copyText(p.linkURL) });
  }
  return out;
}
