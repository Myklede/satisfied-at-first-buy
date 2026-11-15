interface BackgroundMotionClient {
  pauseBackground(): unknown;
  resumeBackground(): void;
}

/** Stop even an already-running background bake while a camera interaction owns the CPU. */
export function syncBackgroundMotion(
  screen: string,
  clients: Iterable<BackgroundMotionClient>,
  kick: () => void,
): void {
  const paused = screen === 'feel' || screen === 'live-tryon';
  for (const client of clients)
    if (paused) client.pauseBackground();
    else client.resumeBackground();
  // Resume clients before waking the queue. Its existing canRun gate still rejects live/Feel.
  kick();
}
