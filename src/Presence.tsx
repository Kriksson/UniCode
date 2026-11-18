import { useEffect, useRef, useState, type ReactNode } from 'react';
import './presence.css';

/** Retain a closing surface for its short exit, with interaction disabled. */
export function Presence({ show, children }: { show: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState(show);
  const content = useRef(children);
  if (show) content.current = children;
  useEffect(() => {
    if (show) { setRetained(true); return; }
    const timer = window.setTimeout(() => setRetained(false), 180);
    return () => window.clearTimeout(timer);
  }, [show]);
  if (!show && !retained) return null;
  return <div className="surface-presence" data-leaving={!show || undefined} aria-hidden={!show || undefined} inert={!show || undefined}>
    {show ? children : content.current}
  </div>;
}
