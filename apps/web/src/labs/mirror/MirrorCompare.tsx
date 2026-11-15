// Look parity check (/?mirrorlab&compare): the kiosk's dressed jacket (GarmentView: cloth settled on
// the display-pose body) beside the live mirror's jacket (KioskMirrorView: the same GarmentLayer
// look, skinned preview) on the same body, size, pose (the neutral display pose) and camera
// preset. A public reference body only; no user data. Dev route, not for judges.
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { GarmentView } from '../../kiosk/garmentView';
import { createLiveTryOn } from '../../engine/live/LiveTryOnEngine';

/** ?jacket=: a style code (FB7675-100) or a word; the shortest matching title wins ("puffer"). */
export function pickJacket<T extends { title: string; style: string }>(list: T[], query?: string) {
  if (!query) return undefined;
  const q = query.toLowerCase();
  return (
    list.find((p) => p.style.toLowerCase() === q) ??
    list
      .filter((p) => `${p.title} ${p.style}`.toLowerCase().includes(q))
      .sort((a, b) => a.title.length - b.title.length)[0]
  );
}

const REFERENCE = { sex: 'male' as const, height_cm: 175, weight_kg: 75 };

export function MirrorCompare() {
  const params = new URLSearchParams(location.search);
  const kioskRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    let cancelled = false;
    const kiosk = new GarmentView(kioskRef.current!);
    const engine = createLiveTryOn({ mirrorDisplay: false });
    engine.attachMirrorView(liveRef.current!);
    const done = window as unknown as { __mirrorCompare?: { ready: boolean; error?: string } };
    done.__mirrorCompare = { ready: false };
    void (async () => {
      try {
        const [capabilities, options, products] = await Promise.all([
          api.capabilities(),
          api.garmentOptions(),
          api.products(),
        ]);
        const jacket = params.get('jacket')?.toLowerCase() ?? 'parka';
        const product = pickJacket(products, jacket) ?? products[0];
        const body = await api.fit({
          ...REFERENCE,
          shape_reference: 'neutral',
          density_kg_m3: capabilities.default_density_kg_m3 as 980 | 1010,
          known_measurements: {},
        });
        const fit = await api.garmentFit({
          body_id: body.body_id,
          product_id: product.product_id,
          layer_cm: options.layer_presets_cm['t-shirt'] ?? 0,
          preference: 'regular',
        });
        const size = params.get('size') ?? fit.recommended_size ?? Object.keys(fit.sizes)[0];
        if (cancelled) return;
        setStatus(`${product.title} · size ${size} · reference body 175 cm / 75 kg`);
        await kiosk.showBody(body);
        await kiosk.dress(fit, size);
        kiosk.preset('front');
        await new Promise<void>((resolve) => {
          const off = engine.onState((s) => {
            if (s.phase === 'idle' && s.message.startsWith('Dressed')) {
              off();
              resolve();
            }
          });
          void engine.load({
            bodyId: body.body_id,
            fitId: fit.fit_id,
            productId: product.product_id,
            size,
          });
        });
        engine.kioskView?.frame('kiosk', body.measurements.stature.value_cm / 100);
        done.__mirrorCompare = { ready: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Error: ${message}`);
        done.__mirrorCompare = { ready: false, error: message };
      }
    })();
    return () => {
      cancelled = true;
      engine.dispose();
    };
  }, []);

  const panel = {
    position: 'relative',
    height: '100%',
    borderRadius: 8,
    overflow: 'hidden',
  } as const;
  const label = {
    position: 'absolute',
    left: 10,
    top: 8,
    zIndex: 2,
    font: '600 18px system-ui',
    background: '#fffa',
    padding: '2px 8px',
    borderRadius: 6,
  } as const;
  return (
    <main
      style={{
        height: '100vh',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        gap: 8,
        padding: 8,
        boxSizing: 'border-box',
        fontFamily: 'system-ui',
        color: '#111',
      }}
    >
      <div style={{ fontSize: 18 }}>{status}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, minHeight: 0 }}>
        <div style={panel}>
          <span style={label}>kiosk (cloth settled on the display pose)</span>
          <div ref={kioskRef} style={{ position: 'absolute', inset: 0 }} />
        </div>
        <div style={panel}>
          <span style={label}>live mirror (same look, skinned preview)</span>
          <div ref={liveRef} style={{ position: 'absolute', inset: 0 }} />
        </div>
      </div>
    </main>
  );
}
