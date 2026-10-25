import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LoaderCircle, Smartphone } from 'lucide-react';
import { closeMobileApi, installMobileApi } from './mobile-api';
import appIcon from '../assets/unicode-generated.png';
import './style.css';
import './mobile.css';

const MobileApp = lazy(() => import('./MobileApp'));
let pairingSecret = new URLSearchParams(location.hash.slice(1)).get('pair');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

function PhoneEntry() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  async function connect() {
    setBusy(true); setError('');
    try {
      let response = await fetch('/session', { cache: 'no-store' });
      if (!response.ok && pairingSecret) {
        const name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Браузер';
        response = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: pairingSecret, name }) });
      }
      if (!response.ok) {
        const result = await response.json();
        if (response.status === 401 || response.status === 403) pairingSecret = null;
        throw new Error(result.error || 'Открой QR-код в UniCode на компьютере.');
      }
      pairingSecret = null; installMobileApi(); setReady(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Компьютер недоступен. Проверь Wi-Fi.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    void connect();
    const unpaired = () => { setReady(false); setError('Открой новый QR-код в UniCode на компьютере.'); };
    window.addEventListener('unicode-unpaired', unpaired);
    return () => { window.removeEventListener('unicode-unpaired', unpaired); closeMobileApi(); };
  }, []);
  if (ready) return <Suspense fallback={<div className="mobile-pair-screen"><LoaderCircle className="spinning" size={25} /></div>}><MobileApp /></Suspense>;
  return <div className="mobile-pair-screen"><img src={appIcon} width="64" height="64" alt="" /><h1>UniCode <span>v1</span></h1><small>by krkss</small>
    <div className="mobile-pair-card">{busy ? <><LoaderCircle className="spinning" size={23} /><p>{pairingSecret ? 'Подтверди подключение на компьютере' : 'Подключаемся…'}</p></> : <><Smartphone size={25} /><p>{error || 'Открой QR-код в UniCode на компьютере.'}</p><button className="primary-button" onClick={() => void connect()}>Повторить</button></>}</div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<PhoneEntry />);
