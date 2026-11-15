// Independent query validation with real, throwaway resource IDs on the shared loopback API.
// Every valid body DELETE must be an ID obtained from THIS job's own successful body-fit POST.
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, waitForBrowserLock } from './demo-day-warm.mjs';
import { operationCases, persistedState } from './demo-day-api-audit.mjs';

const base = 'http://127.0.0.1:8001';
const hashId = /^[a-f0-9]{64}$/;
export function assertOwnedDelete(id, created) {
  if (!hashId.test(id) || !created.has(id))
    throw new Error('Refusing DELETE of a body not created by this job');
}
export function assertSafeOperation(path, method, operation) {
  if (method === 'get') return;
  if (method === 'delete') {
    if (
      ![
        '/body/{body_id}',
        '/agent/profile',
        '/agent/learning',
        '/agent/learning/{purchase_id}',
      ].includes(path)
    )
      throw new Error(`Unreviewed DELETE: ${path}`);
    return;
  }
  if (!operation.requestBody)
    throw new Error(`Unreviewed mutation without schema: ${method} ${path}`);
  operationCases(path, method, operation); // Throws for a new body-bearing mutation.
}
export function probePath(template, kind, resources) {
  let first = true;
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    if (kind === 'wrong-type-or-id' && first) {
      first = false;
      return 'invalid!';
    }
    const value = resources[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value))
      throw new Error(`Missing safe resource: ${name}`);
    if (name.endsWith('_id') && name !== 'motion_id' && !hashId.test(value))
      throw new Error(`Invalid resource hash: ${name}`);
    return value;
  });
}

async function main() {
  const report = { at: new Date().toISOString(), results: [], preparation: [], cleanup: [] };
  const created = new Set();
  let currentBody;
  const release = await waitForBrowserLock(); // Bound heavy asset/uncertainty work, even without Chrome.
  const deadline = Date.now() + 13 * 60000; // Reserve up to one minute for cleanup, below the 15-minute lease.
  const call = async (path, method = 'GET', body, headers = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Fourteen-minute resource lease exhausted');
    return fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Math.min(120000, remaining)),
    });
  };
  const json = async (path, method, body) => {
    const r = await call(path, method, body);
    if (!r.ok) throw new Error(`Preparation ${method ?? 'GET'} ${path}: HTTP ${r.status}`);
    report.preparation.push({ path, method: method ?? 'GET', status: r.status });
    return r.json();
  };
  // Randomized synthetic inputs avoid sharing the kiosk's deterministic reference-body cache ID.
  // This is an API validation fixture, not a claimed person's body or an accuracy measurement.
  const input = {
    height_cm: 171 + randomInt(1000000) / 1000000,
    weight_kg: 64 + randomInt(1000000) / 1000000,
    sex: 'male',
  };
  const createBody = async () => {
    const data = await json('/body/fit', 'POST', input);
    if (!hashId.test(data.body_id)) throw new Error('Body response lacks a validated hash ID');
    currentBody = data.body_id;
    created.add(currentBody);
    return currentBody;
  };
  const before = persistedState();
  try {
    const privacy = await json('/agent/profile');
    if (privacy.kiosk_mode !== true || privacy.saved !== false || privacy.profile !== null)
      throw new Error(
        'Owned-resource audit requires the existing private API; no service was changed',
      );
    const openapi = await json('/openapi.json');
    const operations = Object.entries(openapi.paths).flatMap(([path, value]) =>
      Object.entries(value)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, operation]) => {
          assertSafeOperation(path, method, operation);
          return { path, method, cases: operationCases(path, method, operation) };
        }),
    );
    // Delete the throwaway body last, so every preceding ID-bearing read has a live resource.
    operations.sort(
      (a, b) =>
        Number(a.method === 'delete' && a.path === '/body/{body_id}') -
        Number(b.method === 'delete' && b.path === '/body/{body_id}'),
    );
    const bodyId = await createBody();
    const products = await json('/products');
    const productId = products[0]?.product_id;
    if (!hashId.test(productId)) throw new Error('No validated catalogue product ID');
    const fit = await json('/fit/garment', 'POST', { body_id: bodyId, product_id: productId });
    if (!hashId.test(fit.fit_id) || !fit.sizes.S?.geometry_available)
      throw new Error('No measured S fit resource');
    const cloth = await json(`/fit/${fit.fit_id}/S/cloth`);
    if (!hashId.test(cloth.sdf?.sdf_id)) throw new Error('Cloth lacks validated SDF ID');
    const resources = {
      body_id: bodyId,
      product_id: productId,
      fit_id: fit.fit_id,
      sdf_id: cloth.sdf.sdf_id,
      size: 'S',
      motion_id: 'reach_forward',
    };
    report.syntheticRequest = input;
    report.resources = resources;
    for (const { path, method, cases } of operations) {
      for (const sample of cases) {
        const guarded = method === 'delete' && path.startsWith('/agent/');
        const ownBodyDelete = method === 'delete' && path === '/body/{body_id}';
        if (ownBodyDelete && sample.kind !== 'wrong-type-or-id' && currentBody === undefined)
          resources.body_id = await createBody();
        const concrete = guarded
          ? path.replace(/\{[^}]+\}/g, 'invalid!')
          : probePath(path, sample.kind, resources);
        if (ownBodyDelete && !concrete.endsWith('/invalid!'))
          assertOwnedDelete(resources.body_id, created);
        const entry = {
          path,
          method,
          kind: sample.kind,
          physicalApplicable: sample.physicalApplicable,
          note: sample.note,
          concrete,
          guardOnly: guarded,
        };
        const requestBefore = persistedState();
        try {
          if (ownBodyDelete && !concrete.endsWith('/invalid!')) {
            const check = await call(`/body/${resources.body_id}/mesh.glb`);
            entry.bodyBeforeStatus = check.status;
            await check.arrayBuffer();
          }
          const r = await call(
            `${concrete}${sample.query ? `?${sample.query}` : ''}`,
            method.toUpperCase(),
            sample.body,
            guarded ? { Origin: 'http://127.0.0.1:5790' } : {},
          );
          entry.status = r.status;
          entry.rejected = r.status >= 400 && r.status < 500;
          if (r.status === 422) {
            const d = await r.json();
            entry.validation = Array.isArray(d.detail)
              ? d.detail.map(({ loc, type }) => ({ loc, type }))
              : [];
          } else await r.arrayBuffer();
          if (ownBodyDelete && r.ok && !concrete.endsWith('/invalid!')) {
            const check = await call(`/body/${resources.body_id}/mesh.glb`);
            await check.arrayBuffer();
            entry.bodyRemovalDetected = entry.bodyBeforeStatus === 200 && check.status === 404;
            if (entry.bodyRemovalDetected) currentBody = undefined;
          }
        } catch (error) {
          entry.error = String(error);
          entry.rejected = false;
        }
        entry.persistedStateUnchanged =
          JSON.stringify(requestBefore) === JSON.stringify(persistedState());
        report.results.push(entry);
        console.log(`CX-DAY API ${method} ${path} ${sample.kind}: ${entry.status ?? entry.error}`);
      }
    }
    report.operations = operations.length;
  } catch (error) {
    report.error = String(error);
    process.exitCode = 1;
  } finally {
    // Cleanup has a separate short deadline so it still runs after a measurement timeout.
    try {
      const cleanupDeadline = Date.now() + 45000;
      for (const id of created) {
        assertOwnedDelete(id, created);
        if (Date.now() >= cleanupDeadline) {
          report.cleanupError = 'Cleanup deadline exhausted';
          process.exitCode = 1;
          continue;
        }
        const r = await fetch(`${base}/body/${id}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(Math.min(15000, cleanupDeadline - Date.now())),
        });
        await r.arrayBuffer();
        const check = await fetch(`${base}/body/${id}/mesh.glb`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(10000, cleanupDeadline - Date.now()))),
        });
        await check.arrayBuffer();
        report.cleanup.push({ body_id: id, status: r.status, absentAfter: check.status === 404 });
      }
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    } finally {
      release();
    }
    report.requests = report.results.length;
    report.rejected = report.results.filter((r) => r.rejected).length;
    report.accepted = report.results.filter((r) => r.status >= 200 && r.status < 300).length;
    report.persistedStateUnchanged = JSON.stringify(before) === JSON.stringify(persistedState());
    report.complete =
      !report.error &&
      !report.cleanupError &&
      report.requests === report.operations * 3 &&
      report.cleanup.every((c) => c.absentAfter);
    report.contractPass =
      report.complete &&
      report.results.every(
        (r) => r.rejected && r.persistedStateUnchanged && !r.bodyRemovalDetected,
      );
    report.scope =
      "Real owned body/fit/SDF, real catalogue product, valid S/motion parameters for unknown/range probes; malformed first ID only for bad-ID probes. Routes without physical inputs are N/A. Agent DELETE remains disallowed-Origin guard-only to preserve existing personal data. Unknown-query body DELETE is intentionally tested only on this job's created body; any removal is a failed no-state-change expectation. All test bodies cleaned; other clients' IDs never deleted.";
    writeFileSync(
      join(ROOT, 'docs/validation/demo-day-api-owned.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        operations: report.operations,
        requests: report.requests,
        rejected: report.rejected,
        accepted: report.accepted,
        error: report.error,
        cleanup: report.cleanup,
        persistedStateUnchanged: report.persistedStateUnchanged,
      }),
    );
  }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/demo-day-api-owned.mjs')) await main();
