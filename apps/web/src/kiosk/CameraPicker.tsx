import { useEffect, useState } from 'react';
import { listCameras } from '@satisfy/vision';
import { CAMERA_STORAGE_KEY } from '../engine/live/sources/cameraChoice';

/**
 * Small camera chooser for the scan and try-on screens (F2, user 19:00: iPhone as a webcam,
 * ZED 2). Lists the video inputs, remembers the label in sessionStorage (read by
 * cameraChoice/openLiveCamera; ?cam= in the URL still wins) and asks the screen to reopen the
 * camera. Hidden while there is only one camera and no stored choice.
 */
export function CameraPicker(props: { onChange: () => void }) {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [current, setCurrent] = useState(() => {
    try {
      return sessionStorage.getItem(CAMERA_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void listCameras()
        .then((list) => alive && setDevices(list))
        .catch(() => undefined);
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    };
  }, []);
  if (devices.length < 2 && !current) return null;
  return (
    <label className="k-cam-picker">
      <span>Camera</span>
      <select
        value={current}
        onChange={(e) => {
          const label = e.target.value;
          try {
            if (label) sessionStorage.setItem(CAMERA_STORAGE_KEY, label);
            else sessionStorage.removeItem(CAMERA_STORAGE_KEY);
          } catch {
            // storage blocked: the choice lasts for this screen only
          }
          setCurrent(label);
          props.onChange();
        }}
      >
        <option value="">Default camera</option>
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.label}>
            {d.label || `Camera ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}
