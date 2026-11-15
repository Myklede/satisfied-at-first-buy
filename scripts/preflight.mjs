// Read-only local demo checks. Never starts/stops a service or changes power/privacy.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, statfsSync, readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHash, warmProven } from './demo-day-warm.mjs';

export const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = join(
  ROOT,
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
);
// Operational warning, not an accuracy threshold: prompt 07 F asks for <4 GiB.
export const RAM_WARNING_GIB = 4;
// Lead's S memory-pressure finding (docs/requests/lead-to-CX-DAY.md): preserve ≥3 GiB
// during judging. 2.5 GiB is only the shared browser-launch minimum.
export const JUDGING_RAM_GIB = 3;

export function ramStatus(available, kiosk = false) {
  const recommended = kiosk ? JUDGING_RAM_GIB : RAM_WARNING_GIB;
  return {
    status: available < 2.5 ? 'fail' : available < recommended ? 'warn' : 'pass',
    detail: `${available.toFixed(2)} GiB; ${kiosk ? 'keep at least 3 GiB free while judging' : 'close unneeded apps if below 4 GiB'}; browser requires 2.5 GiB`,
  };
}

export function warmStatus(dist, record) {
  try {
    const report = JSON.parse(readFileSync(record, 'utf8'));
    if (report.buildHash === buildHash(dist) && warmProven(report))
      return {
        status: 'pass',
        detail: `Matching build; two E2E runs (${report.at}); disk cache best-effort, wait for judge window's green dot`,
      };
  } catch {
    /* missing or invalid evidence is never a pass */
  }
  return { status: 'warn', detail: 'Warm-up absent, stale or failed; run npm run kiosk -- --warm' };
}

export function goDecision(rows) {
  const first = rows.find((r) => r.status === 'fail');
  return first ? `NO-GO: ${first.check}: ${first.detail}` : 'GO';
}

export function preflightOptions(args) {
  const at = args.indexOf('--api-port');
  const apiPort = at < 0 ? 8001 : Number(args[at + 1]);
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
    throw new Error('--api-port must be a port 1024-65535');
  return { kiosk: args.includes('--kiosk'), apiPort };
}

export function apiUrl(path, apiPort) {
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
    throw new Error('--api-port must be a port 1024-65535');
  return `http://127.0.0.1:${apiPort}${path}`;
}

export function versionAtLeast(actual, required) {
  const match = actual.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] > required[i]) return true;
    if (parts[i] < required[i]) return false;
  }
  return true;
}

// Exact supported range from pinned node_modules/vite/package.json engines.node.
export function supportedNode(version) {
  return (
    (/^v?20\./.test(version) && versionAtLeast(version, [20, 19, 0])) ||
    versionAtLeast(version, [22, 12, 0])
  );
}

export function newestFile(root) {
  if (!existsSync(root)) return 0;
  const info = statSync(root);
  if (info.isFile()) return info.mtimeMs;
  let newest = 0;
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink() || ['node_modules', 'dist', '.cache', '.git'].includes(item.name))
      continue;
    newest = Math.max(newest, newestFile(join(root, item.name)));
  }
  return newest;
}

export function distFreshness(dist, sourcePaths) {
  const index = join(dist, 'index.html');
  if (!existsSync(index)) return { status: 'fail', detail: 'Missing web dist; run npm run build' };
  const sourceTime = Math.max(0, ...sourcePaths.map(newestFile));
  const builtTime = statSync(index).mtimeMs;
  return sourceTime > builtTime
    ? { status: 'fail', detail: 'Web dist is older than sources; run npm run build' }
    : { status: 'pass', detail: 'Web dist is present and newer than source inputs' };
}

export function privacyStatus(health, profile, { kiosk = false } = {}) {
  if (health?.model_loaded !== true)
    return { status: 'fail', detail: 'API not ready/model not loaded' };
  if (profile?.kiosk_mode !== true || profile?.saved !== false || profile?.profile !== null)
    return {
      status: kiosk ? 'fail' : 'warn',
      detail: kiosk
        ? 'Kiosk requires verified privacy mode; start npm run kiosk (no mode is changed)'
        : 'Development API; kiosk privacy is not verified. Use --kiosk before judging',
    };
  return { status: 'pass', detail: 'API ready; kiosk_mode=true, saved=false, profile=null' };
}

/** Process names, PIDs and working sets only: never expose command lines or terminate a process. */
export function topMemoryUsers(processes) {
  return processes
    .filter((p) => typeof p.name === 'string' && Number.isFinite(p.bytes) && p.bytes >= 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map((p) => `${p.name} (PID ${p.pid}): ${(p.bytes / 1024 ** 2).toFixed(0)} MiB`)
    .join('; ');
}

export function gitState(text) {
  const count = text.split(/\r?\n/).filter(Boolean).length;
  return count
    ? { status: 'fail', detail: `${count} dirty/untracked paths; review before judging` }
    : { status: 'pass', detail: 'Working tree clean' };
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function findChrome() {
  return [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((root) => join(root, 'Google/Chrome/Application/chrome.exe'))
    .find(existsSync);
}

async function fetchLocal(path, apiPort) {
  const response = await fetch(apiUrl(path, apiPort), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function probePrivacy(apiPort, kiosk = false) {
  const [health, profile] = await Promise.all([
    fetchLocal('/health', apiPort),
    fetchLocal('/agent/profile', apiPort),
  ]);
  const privacy = privacyStatus(health, profile, { kiosk });
  return { ...privacy, detail: `127.0.0.1:${apiPort}: ${privacy.detail}` };
}

function windowsSnapshot(includeMemory, apiPort) {
  // Static PowerShell only; process command lines are inspected but NEVER printed
  // (other processes may have credentials). Only ownership booleans leave this query.
  const script = `
    $ErrorActionPreference = 'Stop'
    $repo = (Get-Location).Path.ToLowerInvariant()
    $battery = $null
    try { $battery = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object PowerOnline,Discharging) } catch {}
    $camera = $null
    try { $camera = @(Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in 'Camera','Image' -and $_.Status -eq 'OK' } | Select-Object FriendlyName) } catch {}
    $ports = @()
    $memory = @()
    ${includeMemory ? '$memory = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object { @{ name=$_.ProcessName; pid=$_.Id; bytes=$_.WorkingSet64 } })' : ''}
    foreach ($port in @(${apiPort},5711,5730)) {
      $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
      foreach ($listener in $listeners) {
        $proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess)
        $cmd = [string]$proc.CommandLine
        $exe = [string]$proc.ExecutablePath
        $inRepo = $cmd.ToLowerInvariant().Contains($repo) -or $exe.ToLowerInvariant().StartsWith($repo + '\\')
        $expected = if ($port -eq ${apiPort}) { $cmd -match 'uvicorn.+body_service\\.app:app' } else { $cmd -match 'vite|kiosk|vision|sandbox' }
        $ports += @{ port=$port; pid=$listener.OwningProcess; loopback=($listener.LocalAddress -in '127.0.0.1','::1'); own=($inRepo -and $expected) }
      }
    }
    @{ battery=$battery; cameras=$camera; ports=$ports; memory=$memory } | ConvertTo-Json -Depth 5 -Compress
  `;
  return JSON.parse(command('powershell', ['-NoProfile', '-Command', script], { timeout: 30000 }));
}

export async function preflight({ kiosk = false, apiPort = 8001 } = {}) {
  apiUrl('/health', apiPort); // Validate before using the numeric port in the static OS query.
  const ports = [...new Set([apiPort, 5711, 5730])];
  const rows = [];
  const add = (name, result) => rows.push({ check: name, ...result });
  add('Node', {
    status: supportedNode(process.version) ? 'pass' : 'fail',
    detail: `${process.version}; pinned Vite supports ^20.19.0 or >=22.12.0`,
  });
  try {
    const version = command(PYTHON, ['--version']);
    add('Python', {
      status: /^Python 3\.12\./.test(version) ? 'pass' : 'fail',
      detail: `${version}; repo requires 3.12`,
    });
  } catch {
    add('Python', { status: 'fail', detail: 'Repository .venv interpreter unavailable' });
  }
  const available = freemem() / 1024 ** 3;
  add('Free RAM', ramStatus(available, kiosk));
  try {
    const disk = statfsSync(ROOT);
    const freeGiB = (disk.bavail * disk.bsize) / 1024 ** 3;
    add('Free disk', {
      status: freeGiB < 2 ? 'fail' : 'pass',
      detail: `${freeGiB.toFixed(2)} GiB on repo drive; free space if below 2 GiB`,
    });
  } catch {
    add('Free disk', { status: 'warn', detail: 'Unknown; inspect repo drive free space' });
  }
  const owner = join(ROOT, '.cache/locks/browser/owner.txt');
  add('Browser lock', {
    status: existsSync(join(ROOT, '.cache/locks/browser')) ? 'warn' : 'pass',
    detail: existsSync(owner)
      ? `${readFileSync(owner, 'utf8').trim().replace(/\s+/g, ' ')}; wait for its owner to release`
      : existsSync(join(ROOT, '.cache/locks/browser'))
        ? 'Held, owner unavailable; coordinate with lead'
        : 'Free',
  });
  add('Chrome', {
    status: findChrome() ? 'pass' : 'fail',
    detail: findChrome()
      ? `Installed: ${findChrome()}`
      : 'Installed Chrome not found; install Chrome before demo',
  });
  if (process.platform === 'win32' && findChrome()) {
    try {
      const version = command('powershell', [
        '-NoProfile',
        '-Command',
        '$p = Join-Path $env:PROGRAMFILES "Google/Chrome/Application/chrome.exe"; (Get-Item -LiteralPath $p).VersionInfo.ProductVersion',
      ]);
      add('Chrome version', { status: 'pass', detail: version });
    } catch {
      add('Chrome version', {
        status: 'warn',
        detail: 'Version unavailable; inspect chrome://version',
      });
    }
  }
  if (process.platform === 'win32') {
    try {
      const info = windowsSnapshot(available < RAM_WARNING_GIB, apiPort);
      if (available < RAM_WARNING_GIB)
        add('Top memory users', {
          status: 'warn',
          detail: topMemoryUsers(info.memory ?? []) || 'Process working sets unavailable',
        });
      const battery = info.battery;
      add('Power supply', {
        status: battery?.length && battery.every((b) => b.PowerOnline) ? 'pass' : 'warn',
        detail: battery?.length
          ? battery.some((b) => b.Discharging)
            ? 'Battery is discharging'
            : battery.every((b) => b.PowerOnline)
              ? 'AC power online'
              : 'AC state unknown'
          : 'Battery/AC state unavailable (best effort)',
      });
      add('Camera', {
        status: info.cameras?.length ? 'pass' : 'warn',
        detail: info.cameras?.length
          ? `${info.cameras.length} present camera/image device(s); live capture untested`
          : 'No present Camera/Image device confirmed (best effort)',
      });
      for (const port of ports) {
        const owners = info.ports.filter((p) => p.port === port);
        add(`Port ${port}`, {
          status: owners.every((p) => p.own && p.loopback) ? 'pass' : 'fail',
          detail: !owners.length
            ? 'Free'
            : owners.every((p) => p.own && p.loopback)
              ? 'Owned local service'
              : 'Busy; ownership/loopback not verified (no action taken)',
        });
      }
    } catch {
      for (const name of ['Power supply', 'Camera', ...ports.map((p) => `Port ${p}`)])
        add(name, {
          status: 'warn',
          detail: 'Windows device/owner query unavailable; inspect manually',
        });
    }
    try {
      add('Power plan', { status: 'pass', detail: command('powercfg', ['/getactivescheme']) });
    } catch {
      add('Power plan', { status: 'warn', detail: 'Power plan unavailable' });
    }
  } else {
    for (const name of ['Power supply', 'Power plan', 'Camera', ...ports.map((p) => `Port ${p}`)])
      add(name, { status: 'warn', detail: 'Windows-specific probe; inspect manually on this OS' });
  }
  const model = join(ROOT, '.cache/anny');
  const modelPresent = existsSync(model) && newestFile(model) > 0;
  add('Anny cache', {
    status: modelPresent ? 'pass' : 'fail',
    detail: modelPresent
      ? 'Nonempty local model cache (not a load/integrity test)'
      : 'Anny cache missing/empty',
  });
  const assets = join(ROOT, 'apps/web/public/vision');
  const media = existsSync(assets) ? walkMedia(assets) : [];
  add('Vision assets', {
    status:
      media.some((p) => p.endsWith('.wasm')) && media.some((p) => p.endsWith('.task'))
        ? 'pass'
        : 'fail',
    detail: `${media.length} local wasm/task asset files; run npm run kiosk:assets if missing`,
  });
  try {
    add('API + privacy', await probePrivacy(apiPort, kiosk));
  } catch {
    add('API + privacy', {
      status: 'fail',
      detail: `API/agent profile unavailable on 127.0.0.1:${apiPort}; start npm run kiosk`,
    });
  }
  add(
    'Web dist',
    distFreshness(
      join(ROOT, 'apps/web/dist'),
      [
        'apps/web/src',
        'apps/web/public',
        'packages/vision/src',
        'packages/api-types',
        'apps/web/vite.config.ts',
        'apps/web/index.html',
        'package.json',
        'package-lock.json',
      ].map((p) => join(ROOT, p)),
    ),
  );
  try {
    add('Git', gitState(command('git', ['status', '--porcelain=v1'])));
  } catch {
    add('Git', { status: 'fail', detail: 'Unable to read git status' });
  }
  add('Warm-up', warmStatus(join(ROOT, 'apps/web/dist'), join(ROOT, '.cache/kiosk-warm.json')));
  if (kiosk)
    add('Judge shaders', {
      status: 'warn',
      detail:
        'Operator must verify attract green dot in the actual judge window (about 70 s cold); no remote debugging surface is added',
    });
  return rows;
}

function walkMedia(root) {
  const paths = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const path = join(root, item.name);
    if (item.isDirectory()) paths.push(...walkMedia(path));
    else if (/\.(wasm|task)$/.test(item.name)) paths.push(relative(ROOT, path));
  }
  return paths;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await preflight(preflightOptions(process.argv.slice(2)));
  const icons = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  for (const row of rows) console.log(`${icons[row.status]} ${row.check.padEnd(16)} ${row.detail}`);
  console.log(goDecision(rows));
  process.exitCode = rows.some((row) => row.status === 'fail') ? 1 : 0;
}
