// Resizable panels: the drag/keyboard maths of the edge handle and the saved panel sizes (pure functions).
import { describe, expect, it } from 'vitest';
import { clampSize, dragWidth, keyWidth } from '@renderer/components/ui/resize-handle';
import { clampPanelSize, effectiveSidebarWidth, PANEL_LIMITS, sanitizePanelSizes, useUi } from '@renderer/state/ui';

describe('resize handle maths', () => {
  it('a right-edge handle grows when dragged right, a left-edge handle when dragged left', () => {
    expect(dragWidth('right', 240, 100, 160, 200, 420)).toBe(300);
    expect(dragWidth('right', 240, 100, 60, 200, 420)).toBe(200);
    expect(dragWidth('left', 340, 900, 820, 280, 640)).toBe(420);
    expect(dragWidth('left', 340, 900, 960, 280, 640)).toBe(280);
  });

  it('never leaves the limits', () => {
    expect(dragWidth('right', 240, 0, 5000, 200, 420)).toBe(420);
    expect(dragWidth('left', 340, 0, 5000, 280, 640)).toBe(280);
    expect(clampSize(250.6, 200, 420)).toBe(251);
  });

  it('keyboard: arrows toward the panel shrink it, away grow it; Shift = big steps; Home/End/Enter', () => {
    expect(keyWidth('right', 'ArrowRight', false, 240, 200, 420, 240)).toBe(256);
    expect(keyWidth('right', 'ArrowLeft', true, 240, 200, 420, 240)).toBe(200);
    expect(keyWidth('left', 'ArrowLeft', false, 340, 280, 640, 340)).toBe(356);
    expect(keyWidth('left', 'ArrowRight', true, 340, 280, 640, 340)).toBe(280);
    expect(keyWidth('left', 'Home', false, 340, 280, 640, 340)).toBe(280);
    expect(keyWidth('left', 'End', false, 340, 280, 640, 340)).toBe(640);
    expect(keyWidth('right', 'Enter', false, 400, 200, 420, 240)).toBe(240);
    expect(keyWidth('right', 'a', false, 400, 200, 420, 240)).toBeNull();
  });
});

describe('saved panel sizes', () => {
  it('clamps to each panel’s limits and turns junk into the default', () => {
    expect(clampPanelSize('sidebar', 9999)).toBe(PANEL_LIMITS.sidebar.max);
    expect(clampPanelSize('settingsNav', 10)).toBe(PANEL_LIMITS.settingsNav.min);
    expect(clampPanelSize('modelsList', 'wide')).toBe(PANEL_LIMITS.modelsList.default);
    expect(clampPanelSize('gpuAside', Number.NaN)).toBe(PANEL_LIMITS.gpuAside.default);
  });

  it('keeps only known panels from storage', () => {
    expect(sanitizePanelSizes({ sidebar: 300, homeAside: 1, bogus: 5, gpuAside: 'x' })).toEqual({ sidebar: 300, homeAside: PANEL_LIMITS.homeAside.min });
    expect(sanitizePanelSizes(null)).toEqual({});
    expect(sanitizePanelSizes('junk')).toEqual({});
  });

  it('the sidebar never takes more than a third of a small window', () => {
    expect(effectiveSidebarWidth(400, 1920)).toBe(400);
    expect(effectiveSidebarWidth(400, 900)).toBe(300);
    expect(effectiveSidebarWidth(400, 300)).toBe(PANEL_LIMITS.sidebar.min);
  });

  it('every panel starts at its default and the store keeps dragged sizes', () => {
    useUi.setState({ panelSizes: {} });
    expect(useUi.getState().panelSizes.sidebar).toBeUndefined();
    useUi.setState({ panelSizes: { sidebar: 320 } });
    expect(useUi.getState().panelSizes.sidebar).toBe(320);
    useUi.setState({ panelSizes: {} });
  });
});
