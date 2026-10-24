import { useEffect, useState } from 'react';
import type { AccountLimits, RateLimitSnapshot, RateLimitWindow } from './types';

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

const remaining = (window: RateLimitWindow) => Math.max(0, Math.min(100, Math.floor(100 - window.usedPercent)));
const resetDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const resetTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function PlanUsage({ connected, authenticated }: { connected: boolean; authenticated: boolean }) {
  const [limits, setLimits] = useState<AccountLimits | null>(null);
  const [loading, setLoading] = useState(true);

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
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false; unsubscribe(); window.clearInterval(timer);
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, [connected, authenticated]);

  if (!connected || !authenticated) return null;
  const bucket = limits?.rateLimitsByLimitId?.codex || limits?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary];
  return <div className="plan-usage" aria-label="Остаток лимитов плана">
    {[{ label: '5ч', minutes: 300 }, { label: 'Неделя', minutes: 10080 }].map(({ label, minutes }) => {
      const window = windows.find(value => value?.windowDurationMins === minutes);
      const percent = window && Number.isFinite(window.usedPercent) ? remaining(window) : null;
      const date = typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : null;
      const validDate = date && Number.isFinite(date.getTime()) ? date : null;
      const sameDay = validDate?.toDateString() === new Date().toDateString();
      const reset = validDate ? (minutes === 300 && sameDay ? resetTime : resetDate).format(validDate) : '—';
      return <div className="plan-usage-row" key={minutes}>
        <span className="plan-usage-period">{label}</span>
        <span className={`plan-usage-percent ${percent !== null && percent <= 10 ? 'low' : ''}`}>{percent ?? (loading ? '…' : '—')}{percent !== null ? '%' : ''} <span>/ 100%</span></span>
        <time className="plan-usage-reset" dateTime={validDate?.toISOString()} aria-label={`Сброс: ${reset}`}>{reset}</time>
      </div>;
    })}
  </div>;
}
