import { expect, it, vi } from 'vitest';
import { syncBackgroundMotion } from './backgroundMotion';

it.each(['live-tryon', 'feel'])('preempts both clients during %s and resumes on exit', (screen) => {
  // Scheduling-only stand-ins: pause terminates work; pump cannot restart while paused.
  const clients = [0, 1].map(() => ({
    paused: false,
    running: true,
    pauseBackground() {
      this.paused = true;
      this.running = false;
    },
    resumeBackground() {
      this.paused = false;
    },
    pump() {
      if (!this.paused) this.running = true;
    },
  }));
  const kick = vi.fn(() => clients.forEach((client) => client.pump()));
  syncBackgroundMotion(screen, clients, kick);
  expect(clients.every((client) => client.paused && !client.running)).toBe(true);
  syncBackgroundMotion('result', clients, kick);
  expect(clients.every((client) => !client.paused && client.running)).toBe(true);
  expect(kick).toHaveBeenCalledTimes(2);
});
