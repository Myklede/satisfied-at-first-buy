import { useEffect, useRef, useState } from 'react';
import {
  REC_MAX_SECONDS,
  formatElapsed,
  startLiveRecording,
  type LiveRecording,
  type RecTargets,
} from './liveRecorder';
import './liveRec.css';

/** ?rec=1 only: REC / STOP button in a screen corner. Mounted only behind the flag. */
export function LiveRecButton(props: { targets(): RecTargets }) {
  const rec = useRef<LiveRecording | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  useEffect(() => () => void rec.current?.stop('unmount'), []);
  const toggle = () => {
    if (rec.current) {
      void rec.current.stop('user');
      return;
    }
    try {
      setError(null);
      rec.current = startLiveRecording(props.targets(), (err) => {
        rec.current = null;
        setStartedAt(null);
        setError(err);
      });
      setStartedAt(rec.current.startedAt);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="live-rec" data-testid="live-rec">
      <button
        type="button"
        className={startedAt === null ? 'live-rec-btn' : 'live-rec-btn on'}
        onClick={toggle}
        title={`Records up to ${REC_MAX_SECONDS} s`}
      >
        {startedAt === null ? '● REC' : `■ STOP ${formatElapsed(now - startedAt)}`}
      </button>
      <small>Recording stays on this computer</small>
      {error && <small className="live-rec-error">{error}</small>}
    </div>
  );
}
