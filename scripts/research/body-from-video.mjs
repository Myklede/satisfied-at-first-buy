// P32 integration helper. Only numeric scans go to the existing loopback service.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildBodyFitRequest } from './body-scan-request.mjs';
export { buildBodyFitRequest } from './body-scan-request.mjs';

async function main() {
  process.chdir(resolve(import.meta.dirname, '../..'));
  execFileSync('git', ['check-ignore', '-q', '.cache/research/body/privacy-probe.png']);
  mkdirSync('.cache/research/body', { recursive: true });
  writeFileSync(
    '.cache/research/body/launch.py',
    '#! ' +
      process.cwd().replaceAll('\\', '/') +
      '/.venv/Scripts/python.exe\n' +
      'import sys,runpy\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"scripts/research"))\n' +
      'from camera_study_common import person_profile,private_directory,wait_for_cpu\nwait_for_cpu()\n' +
      'if "--guard-only" not in sys.argv:\n (private_directory("body")/"person.json").write_text(__import__("json").dumps(person_profile()))\n' +
      ' sys.argv=["scripts/research/body-from-video.py"]+sys.argv[1:]\n runpy.run_path(sys.argv[0],run_name="__main__")\n',
  );
  const options = process.argv.slice(2);
  if (options[0] === '--test' && options.length === 1) {
    const guard = spawnSync('py', ['.cache/research/body/launch.py', '--guard-only'], {
      stdio: 'inherit',
    });
    if (guard.status !== 0) throw new Error('CPU guard failed');
    const path = '.cache/research/body/test-launch.py';
    writeFileSync(
      path,
      '#! ' +
        process.cwd().replaceAll('\\', '/') +
        '/.venv/Scripts/python.exe\n' +
        'import sys,runpy\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"scripts/research"))\n' +
        'sys.argv=["pytest","scripts/research/test_body_from_video.py","-q","-o","cache_dir=.cache/research/body/pytest"]\nrunpy.run_module("pytest",run_name="__main__")\n',
    );
    for (const [cmd, args] of [
      ['py', [path]],
      [
        process.execPath,
        ['--test', '--test-concurrency=1', 'scripts/research/body-from-video.test.mjs'],
      ],
    ]) {
      const r = spawnSync(cmd, args, { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('Body study tests failed');
    }
    return;
  }
  if (options[0] === '--fit' || options[0] === '--validate-neutral') {
    if (options.length > 1) throw new Error('Unexpected fit options');
    const health = await fetch('http://127.0.0.1:8001/health', {
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok) throw new Error('Existing body service is unavailable; never restart it');
    const neutral = options[0] === '--validate-neutral';
    const person = neutral
      ? { height_cm: 170, weight_kg: 65, sex: 'female' }
      : JSON.parse(readFileSync('.cache/research/body/person.json', 'utf8'));
    for (const clip of neutral ? ['neutral-synthetic'] : ['venue-khong-ao', 'cam-tshirt']) {
      let data;
      try {
        data = neutral
          ? {
              result: {
                measurements: Object.fromEntries(
                  [
                    ['chest_cm', 90],
                    ['waist_cm', 75],
                    ['hip_cm', 100],
                  ].map(([name, value]) => [
                    name,
                    {
                      value_cm: value,
                      sigma_cm: 0.08 * value,
                      method: 'neutral synthetic integration fixture, NOT camera measurement',
                    },
                  ]),
                ),
              },
            }
          : JSON.parse(readFileSync('.cache/research/body/' + clip + '.json', 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
      if (Object.keys(data.result.measurements).length === 0) {
        console.log(clip + ': no valid scan; not fitted');
        continue;
      }
      const request = buildBodyFitRequest(person, data.result.measurements);
      // The Python guard also observes the new Studio HOLD lifted syntax. Check
      // immediately before a potentially expensive service solve.
      const r = spawnSync('py', ['.cache/research/body/launch.py', '--guard-only'], {
        stdio: 'inherit',
      });
      if (r.status !== 0) throw new Error('CPU guard failed');
      const response = await fetch('http://127.0.0.1:8001/body/fit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(180000),
      });
      const text = await response.text();
      writeFileSync(
        '.cache/research/body/' + clip + '-request.json',
        JSON.stringify(request, null, 2),
      );
      writeFileSync('.cache/research/body/' + clip + '-fit.json', text);
      if (!response.ok)
        throw new Error('Body service rejected scan; details remain in private cache');
      const fitted = JSON.parse(text);
      console.log(
        clip +
          ': /body/fit ' +
          response.status +
          ', converged=' +
          fitted.converged +
          ', scan entries=' +
          Object.keys(fitted.scan?.entries ?? {}).join(','),
      );
    }
    return;
  }
  if (
    options.some(
      (x, i) => x !== '--clip' && !['venue-khong-ao', 'cam-tshirt'].includes(x) && i > 0,
    ) ||
    options.length > 2
  )
    throw new Error('Use --clip venue-khong-ao|cam-tshirt, or --fit');
  const r = spawnSync('py', ['.cache/research/body/launch.py', ...options], {
    stdio: 'inherit',
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
  });
  if (r.status !== 0) throw new Error('Offline scan failed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
