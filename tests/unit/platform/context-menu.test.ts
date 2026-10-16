// The Electron right-click menu of text fields and selections (src/main/context-menu.ts): the template only.
import { describe, expect, it, vi } from 'vitest';
import { contextMenuTemplate, type ContextMenuParams } from '../../../src/main/context-menu';

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const params = (over: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  isEditable: false,
  selectionText: '',
  linkURL: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: flags,
  ...over,
});
const actions = () => ({ replaceMisspelling: vi.fn(), copyText: vi.fn(), openLink: vi.fn() });
const roles = (t: { role?: string; type?: string }[]) => t.map((i) => i.role ?? i.type);

describe('contextMenuTemplate', () => {
  it('a text field gets Undo / Redo / Cut / Copy / Paste / Select all, enabled as the field allows', () => {
    const t = contextMenuTemplate(params({ isEditable: true, editFlags: { ...flags, canRedo: false, canCut: false } }), actions());
    expect(roles(t)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(t.find((i) => i.role === 'cut')?.enabled).toBe(false);
    expect(t.find((i) => i.role === 'paste')?.enabled).toBe(true);
    expect(t.find((i) => i.role === 'redo')?.enabled).toBe(false);
  });

  it('a misspelled word offers its suggestions first (at most five) and replaces it on click', () => {
    const a = actions();
    const t = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech', 'ten', 'tee', 'tea', 'tel'] }), a);
    expect(t.slice(0, 5).map((i) => i.label)).toEqual(['the', 'tech', 'ten', 'tee', 'tea']);
    expect(t[5].type).toBe('separator');
    (t[0].click as () => void)();
    expect(a.replaceMisspelling).toHaveBeenCalledWith('the');
    // a word without suggestions adds nothing
    expect(roles(contextMenuTemplate(params({ isEditable: true, misspelledWord: 'zzqx' }), a))[0]).toBe('undo');
  });

  it('selected text outside a field offers Copy; nothing selected offers nothing', () => {
    expect(contextMenuTemplate(params({ selectionText: 'hello' }), actions())).toEqual([{ role: 'copy' }]);
    expect(contextMenuTemplate(params({ selectionText: '   ' }), actions())).toEqual([]);
    expect(contextMenuTemplate(params(), actions())).toEqual([]);
  });

  it('a web link can be opened in the browser or copied; other schemes are left alone', () => {
    const a = actions();
    const t = contextMenuTemplate(params({ linkURL: 'https://example.com/a?b=1' }), a);
    expect(t.map((i) => i.label)).toEqual(['Open link in browser', 'Copy link address']);
    (t[0].click as () => void)();
    (t[1].click as () => void)();
    expect(a.openLink).toHaveBeenCalledWith('https://example.com/a?b=1');
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/a?b=1');
    expect(roles(contextMenuTemplate(params({ selectionText: 'x', linkURL: 'https://x.test' }), a))).toEqual(['copy', 'separator', undefined, undefined]);
    expect(contextMenuTemplate(params({ linkURL: 'javascript:alert(1)' }), a)).toEqual([]);
    expect(contextMenuTemplate(params({ linkURL: 'file:///C:/Windows/System32/calc.exe' }), a)).toEqual([]);
  });
});
