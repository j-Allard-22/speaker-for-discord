/**
 * Orphan prevention. The helper can't watch a parent PID (its parent dies on every
 * plugin hot-reload BY DESIGN), so instead: exit cleanly after `idleExitMs` with zero
 * WS clients. Hot reloads reconnect within seconds — the timer never fires. When
 * Stream Deck quits for real, the helper follows within ~2 minutes.
 */
export interface OrphanWatchTarget {
  clientCount: number;
  lastClientSeenAt: number;
}

export function startOrphanWatch(
  target: OrphanWatchTarget,
  idleExitMs: number,
  onIdle: () => void,
  checkIntervalMs = 30_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (target.clientCount === 0 && Date.now() - target.lastClientSeenAt > idleExitMs) {
      onIdle();
    }
  }, checkIntervalMs);
  timer.unref(); // never keep the process alive just to check for idleness
  return timer;
}
