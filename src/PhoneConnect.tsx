import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, LoaderCircle, Smartphone, X } from 'lucide-react';
import type { PhoneStatus } from './types';

export function PhoneConnect() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => window.codex.onEvent(event => {
    if (event.type === 'phone-status') setStatus(event.message);
  }), []);
  useEffect(() => {
    if (!open) return;
    void window.codex.phoneStatus().then(value => { setStatus(value); setHost(value.host || value.addresses[0]?.address || ''); }).catch(error => setError(String(error.message)));
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', keydown);
    return () => { window.clearInterval(timer); document.removeEventListener('keydown', keydown); };
  }, [open]);

  async function action(fn: () => Promise<PhoneStatus>) {
    if (busy) return;
    setBusy(true); setError('');
    try { setStatus(await fn()); }
    catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)); }
    finally { setBusy(false); }
  }
  const validCode = !!status?.qr && (status.expiresAt || 0) > now;
  return <>
    <button className={`phone-connect-trigger icon-button ${status?.enabled ? 'phone-on' : ''}`} type="button" title="Подключить телефон" aria-label="Подключить телефон" onClick={() => { setError(''); setOpen(true); }}><Smartphone size={17} /></button>
    {open && createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="phone-modal" role="dialog" aria-modal="true" aria-labelledby="phone-title">
        <div className="phone-modal-heading"><div><h2 id="phone-title">Телефон</h2><span>UniCode в одной Wi-Fi сети</span></div><button className="icon-button" type="button" aria-label="Закрыть подключение телефона" onClick={() => setOpen(false)}><X size={17} /></button></div>
        {error && <p className="phone-error" role="alert">{error}</p>}
        {!status ? <div className="phone-loading"><LoaderCircle className="spinning" size={21} /></div> : !status.enabled ? <>
          <div className="phone-intro"><Smartphone size={30} strokeWidth={1.3} /><p>Отправляй сообщения и подтверждай действия агента с телефона.</p></div>
          {status.addresses.length > 1 && <div className="phone-networks" aria-label="Локальная сеть">{status.addresses.map(address => <button type="button" key={address.address} className={host === address.address ? 'selected' : ''} onClick={() => setHost(address.address)}><span>{address.name}</span><span>{address.address}</span>{host === address.address && <Check size={13} />}</button>)}</div>}
          {!status.addresses.length && <p className="phone-note">Подключи компьютер к Wi-Fi или локальной сети.</p>}
          <button className="primary-button phone-wide" disabled={busy || !host} onClick={() => void action(() => window.codex.phoneStart(host))}>{busy ? 'Включаем…' : 'Включить подключение'}</button>
        </> : <>
          {validCode ? <div className="phone-pairing"><img src={status.qr!} alt="QR-код подключения к UniCode" width="220" height="220" /><p>Открой камерой телефона и подтверди подключение на компьютере.</p>
            <div className="phone-code-footer"><span>{Math.max(1, Math.ceil(((status.expiresAt || 0) - now) / 60000))} мин</span><button type="button" onClick={() => {
              if (status.pairingUrl) void navigator.clipboard.writeText(status.pairingUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }).catch(() => setError('Не удалось скопировать ссылку'));
            }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Скопировано' : 'Скопировать ссылку'}</button></div>
          </div> : <button type="button" className="secondary-button phone-wide" disabled={busy} onClick={() => void action(() => window.codex.phoneCode())}>{busy ? 'Создаём…' : status.devices.length ? 'Подключить ещё телефон' : 'Показать новый QR-код'}</button>}
          <details className="phone-certificate"><summary>Первое подключение</summary><p>Браузер может попросить подтвердить локальный сертификат UniCode. Сравни его отпечаток с указанным здесь:</p><code>{status.fingerprint}</code></details>
          <div className="phone-bottom"><span>{status.url}</span><button type="button" disabled={busy} onClick={() => void action(() => window.codex.phoneStop())}>Выключить</button></div>
        </>}
        {status && !!status.devices.length && <div className="phone-devices">{status.devices.map(device => <div key={device.id}><Smartphone size={16} /><span>{device.name}</span><button type="button" aria-label={`Отключить ${device.name}`} disabled={busy} onClick={() => void action(() => window.codex.phoneRevoke(device.id))}><X size={14} /></button></div>)}</div>}
      </section>
    </div>, document.body)}
  </>;
}
