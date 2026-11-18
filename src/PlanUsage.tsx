import { useEffect, useRef, useState } from 'react';
import type { AccountLimits, RateLimitSnapshot, RateLimitWindow } from './types';
import './PlanUsage.css';

function mergeUpdate(previous: AccountLimits | null, patch: RateLimitSnapshot): AccountLimits {
  const id = patch.limitId || previous?.rateLimits?.limitId || 'codex';
  const old = previous?.rateLimitsByLimitId?.[id] || (previous?.rateLimits?.limitId === id ? previous.rateLimits : null);
  // Rolling notifications are sparse: null metadata does not clear the last known value.
  const present = Object.fromEntries(Object.entries(patch).filter(([, value]) => value != null));
  const merged = { ...old, ...present } as RateLimitSnapshot;
  return {
    rateLimits: id === 'codex' || !previous?.rateLimits || previous.rateLimits.limitId === id ? merged : previous.rateLimits,
    rateLimitsByLimitId: { ...previous?.rateLimitsByLimitId, [id]: merged },
  };
}

const remaining = (window: RateLimitWindow) => Math.max(0, Math.min(100, 100 - window.usedPercent));

function formatCountdown(resetsAt: number, now: number): string {
  const totalMinutes = Math.max(0, Math.ceil((resetsAt * 1000 - now) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m`;
}

function colorForRemaining(percent: number | null): string {
  if (percent === null) return 'quota-bar--unknown';
  if (percent < 20) return 'quota-bar--low';
  if (percent < 50) return 'quota-bar--mid';
  return 'quota-bar--high';
}

export function PlanUsage({ connected, authenticated }: { connected: boolean; authenticated: boolean }) {
  const [limits, setLimits] = useState<AccountLimits | null>(null);
  const limitsRef = useRef<AccountLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  limitsRef.current = limits;

  useEffect(() => {
    if (!connected || !authenticated) {
      setLimits(null); setLoading(false); return;
    }
    let alive = true;
    let busy = false;
    let generation = 0;
    let lastAttempt = 0;
    const updates: RateLimitSnapshot[] = [];
    const read = async (force = false) => {
      if (busy || (!force && Date.now() - lastAttempt < 30000)) return;
      busy = true; lastAttempt = Date.now();
      const accountGeneration = generation;
      updates.length = 0;
      try {
        const snapshot = await window.codex.rateLimits();
        if (!alive || generation !== accountGeneration) return;
        setLimits(updates.reduce<AccountLimits | null>((value, patch) => mergeUpdate(value, patch), snapshot));
      } catch {
        // Keep the last reported values until the next successful refresh.
      } finally {
        busy = false;
        if (alive) {
          setLoading(false);
          if (generation !== accountGeneration) void read(true);
        }
      }
    };
    setLoading(true); void read(true);
    const unsubscribe = window.codex.onEvent(event => {
      const messages = event.type === 'notification' ? [event.message] : event.type === 'notifications' ? event.messages || [] : [];
      for (const message of messages) {
        if (message?.method === 'account/rateLimits/updated' && message.params?.rateLimits) {
          const patch = message.params.rateLimits as RateLimitSnapshot;
          if (busy) updates.push(patch);
          setLimits(value => mergeUpdate(value, patch));
        }
        if (message?.method === 'account/updated' || message?.method === 'account/login/completed') {
          generation++; setLimits(null);
          if (message.method === 'account/login/completed' ? message.params?.success : message.params?.authMode) {
            setLoading(true); void read(true);
          }
        }
      }
    });
    const visible = () => { if (document.visibilityState === 'visible') void read(); };
    const timer = window.setInterval(visible, 60000);
    const clock = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      const currentLimits = limitsRef.current;
      const currentBucket = currentLimits?.rateLimitsByLimitId?.codex || currentLimits?.rateLimits;
      const hasExpiredWindow = [currentBucket?.primary, currentBucket?.secondary].some(window =>
        typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt * 1000 <= current,
      );
      if (hasExpiredWindow) void read();
    }, 30000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false; unsubscribe(); window.clearInterval(timer); window.clearInterval(clock);
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, [connected, authenticated]);

  if (!connected || !authenticated) return null;
  const bucket = limits?.rateLimitsByLimitId?.codex || limits?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary];
  return <div className="quota-usage" aria-label="Остаток лимитов плана">
    {[{ label: '5 часов', minutes: 300 }, { label: 'Неделя', minutes: 10080 }].map(({ label, minutes }) => {
      const window = windows.find(value => value?.windowDurationMins === minutes);
      const percent = window && Number.isFinite(window.usedPercent) ? remaining(window) : null;
      const resetsAt = typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt : null;
      const resetDate = resetsAt === null ? null : new Date(resetsAt * 1000);
      const validDate = resetDate && Number.isFinite(resetDate.getTime()) ? resetDate : null;
      const countdown = resetsAt !== null && validDate ? formatCountdown(resetsAt, now) : loading ? '…' : '—';
      const fill = percent === null ? 0 : percent / 100;
      return <div className="quota-row" key={minutes}>
        <div
          className={`quota-bar ${colorForRemaining(percent)}${loading && percent === null ? ' quota-bar--loading' : ''}`}
          role="progressbar"
          aria-label={`Остаток лимита: ${label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent === null ? undefined : Math.round(percent)}
          aria-valuetext={percent === null ? (loading ? 'Загрузка' : 'Нет данных') : `${Math.round(percent)}% доступно`}
        >
          <span className="quota-bar__track" aria-hidden="true">
            <span className="quota-bar__fill" style={{ transform: `scaleX(${fill})` }} />
          </span>
        </div>
        <time className="quota-countdown" dateTime={validDate?.toISOString()} aria-label={`До сброса лимита «${label}»: ${countdown}`}>
          {countdown}
        </time>
      </div>;
    })}
  </div>;
}
