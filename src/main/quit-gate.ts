// Quit gate (owner: platform): the first quit is held (before-quit preventDefault) until the graceful shutdown —
// session flush, GPU clock-out when "clock out on quit" is on, core close — has finished, then the app quits for real.
//
// The updater needs the opposite order: run the shutdown FIRST, then start the installer and quit at once.
// electron-updater's quitAndInstall() spawns the NSIS installer and then calls app.quit() (after emitting
// before-quit-for-update); the installer force-closes a still-running app after ~2 s. If before-quit still held the
// quit for a 20 s clock-out at that point, the clock-out would be killed half way. prepareForQuit() runs the shutdown
// up front and opens the gate, so the updater's quit passes straight through.

export interface QuitGate {
  /** app.on('before-quit') handler. */
  onBeforeQuit(event: { preventDefault(): void }): void;
  /** Run the graceful shutdown now; afterwards every quit passes without waiting. Never rejects. */
  prepareForQuit(): Promise<void>;
  /** The shutdown has finished and quits pass through. */
  readonly open: boolean;
}

export function createQuitGate(deps: { shutdown: () => Promise<void>; quit: () => void }): QuitGate {
  let open = false;
  let pending: Promise<void> | null = null;
  const run = (): Promise<void> => {
    pending ??= deps
      .shutdown()
      .catch(() => undefined)
      .then(() => {
        open = true;
      });
    return pending;
  };
  return {
    onBeforeQuit(event) {
      if (open) return;
      event.preventDefault();
      void run().then(() => deps.quit());
    },
    prepareForQuit: run,
    get open() {
      return open;
    },
  };
}
