// Lead's reserved timing/user-test window, 2026-11-14 20:15-20:45 EST.
export function cpuFreeze(now) {
  return now >= Date.parse('2026-11-15T01:15:00Z') && now < Date.parse('2026-11-15T01:45:00Z');
}
export function syncHolds(text) {
  let userTest = false;
  const timing = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\d{4}-\d\d-\d\d \d\d:\d\d (lead|[A-Z][\w-]*)([^:]*):\s*(.*)$/);
    if (!m) continue;
    const [, who, title, body] = m;
    const event = (title.trim() + ' ' + body).trim();
    if ((who === 'lead' || who === 'F6') && /^USER\s*(?:LIVE\s*)?TEST/i.test(event)) {
      if (/^USER\s*TEST\s*END\b|^USER\s*TEST.*\bover\b/i.test(event)) userTest = false;
      else if (/\bHOLD\b|window.*starts|starts now/i.test(event)) userTest = true;
    }
    if (/^TIMING\b.*\bstart\b|^timing-begin\b/i.test(event)) timing.add(who);
    if (/^TIMING\b.*\bend\b|^timing-end\b|^RESULT\b.*(?:fps|kiosk-live|gate)/i.test(event))
      timing.delete(who);
  }
  return { userTest, timing: [...timing], blocked: userTest || timing.size > 0 };
}
export function resumeCheckpoint(previous, fresh) {
  for (const k of ['source', 'sourceSha256', 'modelSha256', 'sampling'])
    if (previous[k] !== fresh[k]) throw new Error('Resume identity mismatch: ' + k);
  if (previous.complete) throw new Error('Reference already complete');
  let lastIndex = -1,
    lastTime = -Infinity;
  for (const f of previous.frames) {
    if (
      !Number.isInteger(f.index) ||
      f.index <= lastIndex ||
      !Number.isFinite(f.tMs) ||
      f.tMs <= lastTime
    )
      throw new Error('Malformed checkpoint ordering');
    lastIndex = f.index;
    lastTime = f.tMs;
  }
  return {
    ...fresh,
    frames: previous.frames,
    inferenceThreadHistory: [
      ...(previous.inferenceThreadHistory ?? [
        { fromIndex: 0, threads: previous.inferenceThreads },
      ]),
      { fromIndex: lastIndex + 1, threads: 2 },
    ],
  };
}
export function timingBlocks(controls, heavy, now, gapUntil = 0, allowedTokens = []) {
  if (heavy) return true;
  const active = controls.filter((c) => c.expiresAt > now);
  if (gapUntil > now)
    return active.some((c) => !allowedTokens.includes(c.requester + ':' + c.requestedAt));
  return active.length > 0;
}
