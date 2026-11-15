// "Try it on" accuracy proof and the operator's accuracy board.
import { useEffect, useState } from 'react';
import type { GarmentFitResponse, GarmentSpec, SizeFit } from '../api';
import {
  BOARD_METRICS,
  METRIC_LABELS,
  hasMeasurement,
  summarize,
  type BoardEntry,
  type BoardMetric,
} from './board';
import { cuffLine, drawnOffsets, predictions } from './fitSummary';
import { addToBoard, readBoard } from './kioskApi';
import { CM_PER_IN, formatHeight, formatLength, formatSigned, type Units } from './units';

// Tape instructions, shortened from docs/MEASUREMENTS.md "Worn jacket validation".
const HOW: Record<BoardMetric, string> = {
  shoulder_seam:
    'From the bony tip of the shoulder, along the top of the arm to the sleeve seam. + if the seam has dropped down the arm.',
  cuff_vs_wrist:
    'Arms relaxed in a slight A. From the wrist crease to the cuff edge. + if the cuff is past the wrist.',
  hem_vs_hip:
    'Height of the back hem minus height of the hip level, both from the floor. + if the hem is above the hip.',
};

function describe(metric: BoardMetric, cm: number, units: Units): string {
  const length = formatLength(cm, units);
  if (metric === 'shoulder_seam')
    return cm >= 0 ? `seam ${length} past your shoulder bone` : `seam ${length} inside it`;
  if (metric === 'cuff_vs_wrist') return cuffLine(cm, null, units) ?? '';
  return cm >= 0 ? `hem ${length} above your hip` : `hem ${length} below your hip`;
}

export interface TryOnJacket {
  product: GarmentSpec;
  fit: GarmentFitResponse;
  size: string;
  /** Metrics measured on the shown, settled 3D shell of this size (secondary numbers). */
  shown?: SizeFit;
}

/**
 * Worn offsets have never been measured against a real jacket (KE-HOACH-SONG-SONG §5), so
 * Try it on says so until the accuracy board holds at least one measured entry.
 */
export function useValidated(): boolean | null {
  const [validated, setValidated] = useState<boolean | null>(null);
  useEffect(() => {
    void readBoard().then((entries) =>
      setValidated(entries !== 'unavailable' && entries.some(hasMeasurement)),
    );
  }, []);
  return validated;
}

export function TryOnPanel({
  jackets,
  units,
  sex,
  heightCm,
  scanned,
  onBoard,
}: {
  jackets: TryOnJacket[];
  units: Units;
  sex: 'female' | 'male';
  heightCm: number;
  scanned: boolean;
  onBoard: () => void;
}) {
  const [index, setIndex] = useState(0);
  // Session memory only: cleared on reset (page reload), never stored unless opted in.
  const [measured, setMeasured] = useState<Record<string, string>>({});
  const [optIn, setOptIn] = useState(false);
  const [saved, setSaved] = useState('');
  const validated = useValidated();
  const jacket = jackets[index];
  if (!jacket) return <p className="k-lead">No jacket fit is available to check.</p>;
  const predicted = predictions(jacket.fit.sizes[jacket.size]);
  const drawn = drawnOffsets(jacket.shown);
  const key = (metric: BoardMetric) => `${jacket.product.product_id}:${jacket.size}:${metric}`;
  const toCm = (text: string | undefined) => {
    if (!text || text.trim() === '') return null;
    const value = Number(text);
    if (!Number.isFinite(value)) return NaN;
    return units === 'imperial' ? value * CM_PER_IN : value;
  };

  async function save() {
    const entry: BoardEntry = {
      version: 1,
      sex,
      height_cm: Math.round(heightCm),
      product_style: jacket.product.style,
      size: jacket.size,
      scanned,
      shoulder_seam: null,
      cuff_vs_wrist: null,
      hem_vs_hip: null,
    };
    for (const metric of BOARD_METRICS) {
      const value = toCm(measured[key(metric)]);
      if (Number.isNaN(value) || (value !== null && Math.abs(value) > 60)) {
        setSaved(`Please check the ${METRIC_LABELS[metric].toLowerCase()} value.`);
        return;
      }
      const p = predicted[metric];
      if (p !== null)
        entry[metric] = {
          predicted_cm: Math.round(p * 10) / 10,
          measured_cm: value === null ? null : Math.round(value * 10) / 10,
        };
    }
    if (!hasMeasurement(entry)) {
      setSaved('Enter at least one measured value first.');
      return;
    }
    if (!optIn) {
      setSaved('Kept for this session only. Not stored.');
      return;
    }
    setSaved(
      (await addToBoard(entry))
        ? 'Added to the accuracy board. Thank you!'
        : 'The board is not available right now.',
    );
  }

  return (
    <section className="k-panel k-tryon" data-screen="tryon">
      <div className="k-eyebrow">Try it on · accuracy check</div>
      <h2>Put the jacket on and check us with a tape</h2>
      {validated === false && (
        <p className="k-unvalidated" role="note">
          Not yet validated: these predictions have not been checked against tape measurements of
          the worn jacket. Your numbers would be the first.
        </p>
      )}
      <div className="k-tabs">
        {jackets.map((item, i) => (
          <button
            key={item.product.product_id}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
          >
            {item.product.style} · size {item.size}
          </button>
        ))}
      </div>
      <table className="k-table">
        <thead>
          <tr>
            <th>What</th>
            <th>We predict</th>
            <th>How to measure</th>
            <th>Measured ({units === 'imperial' ? 'in' : 'cm'}, optional)</th>
          </tr>
        </thead>
        <tbody>
          {BOARD_METRICS.map((metric) => (
            <tr key={metric}>
              <th>{METRIC_LABELS[metric]}</th>
              <td>
                {predicted[metric] === null ? (
                  'not available for this size'
                ) : (
                  <>
                    <b>{formatSigned(predicted[metric]!, units)}</b>
                    <small>
                      {metric === 'cuff_vs_wrist'
                        ? cuffLine(predicted[metric], drawn.cuff_vs_wrist, units)
                        : describe(metric, predicted[metric]!, units)}
                    </small>
                  </>
                )}
              </td>
              <td className="k-how">{HOW[metric]}</td>
              <td>
                <input
                  inputMode="decimal"
                  aria-label={`Measured ${METRIC_LABELS[metric]}`}
                  disabled={predicted[metric] === null}
                  value={measured[key(metric)] ?? ''}
                  onChange={(event) =>
                    setMeasured({ ...measured, [key(metric)]: event.target.value })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="k-check">
        <input
          type="checkbox"
          checked={optIn}
          onChange={(event) => setOptIn(event.target.checked)}
        />
        Add to accuracy board — anonymous numbers only (predicted, measured, height, sex). No name,
        no photo.
      </label>
      <div className="k-actions">
        <button className="k-primary" onClick={() => void save()}>
          Save
        </button>
        <button className="k-secondary" onClick={onBoard}>
          See the accuracy board
        </button>
        <span className="k-note" role="status">
          {saved}
        </span>
      </div>
    </section>
  );
}

export function BoardPanel({ units }: { units: Units }) {
  const [entries, setEntries] = useState<BoardEntry[] | 'unavailable' | 'loading'>('loading');
  useEffect(() => {
    void readBoard().then(setEntries);
  }, []);
  if (entries === 'loading') return <section className="k-panel k-board" data-screen="board" />;
  const summary = entries === 'unavailable' ? null : summarize(entries);
  return (
    <section className="k-panel k-board" data-screen="board">
      <div className="k-eyebrow">Accuracy board · operator</div>
      <h2>Predicted vs measured on real people</h2>
      {entries === 'unavailable' ? (
        <p className="k-lead">The board is available when the app runs with npm run kiosk.</p>
      ) : entries.length === 0 ? (
        <p className="k-lead">No entries yet</p>
      ) : (
        <>
          <div className="k-summary">
            {BOARD_METRICS.map((metric) => (
              <div key={metric}>
                <span>{METRIC_LABELS[metric]}</span>
                <b>
                  {summary![metric].maeCm === null
                    ? '—'
                    : `±${formatSigned(summary![metric].maeCm!, units).replace('+', '')}`}
                </b>
                <small>mean absolute error · n = {summary![metric].n}</small>
              </div>
            ))}
          </div>
          <table className="k-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Jacket · size</th>
                <th>Person</th>
                {BOARD_METRICS.map((metric) => (
                  <th key={metric}>{METRIC_LABELS[metric]} pred → meas</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    {entry.product_style} · {entry.size}
                  </td>
                  <td>
                    {entry.sex}, {formatHeight(entry.height_cm, units)}
                    {entry.scanned ? ' · scanned' : ''}
                  </td>
                  {BOARD_METRICS.map((metric) => {
                    const pair = entry[metric];
                    return (
                      <td key={metric}>
                        {pair
                          ? `${formatSigned(pair.predicted_cm, units)} → ${pair.measured_cm === null ? '—' : formatSigned(pair.measured_cm, units)}`
                          : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
