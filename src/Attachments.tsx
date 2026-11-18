import { useEffect, useRef, useState, type DragEvent } from 'react';
import { FileText, Image, LoaderCircle, Paperclip, X } from 'lucide-react';
import type { Attachment } from './types';

const MAX_FILE = 25 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const sizeLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(size / 1024)} КБ`;
const read = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error(`Не удалось прочитать «${file.name}».`));
  reader.onabort = () => reject(new Error('Чтение файла отменено.'));
  reader.readAsDataURL(file);
});

export function useAttachments(key: string, disabled: boolean, onError: (error: string) => void) {
  const [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const filesRef = useRef(files); filesRef.current = files;
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const move = (from: string, to: string) => {
    if (from === to) return;
    setFiles(all => {
      if (!all[from]) return all;
      const next = { ...all, [to]: [...(all[to] || []), ...all[from]] }; delete next[from]; return next;
    });
  };
  useEffect(() => window.codex.onEvent(event => {
    if (event.type === 'thread-ready' && event.localId && event.thread) move(event.localId, event.thread.id);
  }), []);
  async function add(list: FileList | File[]) {
    if (disabled || inFlight.current) return;
    const incoming = Array.from(list);
    if (!incoming.length) return;
    const existing = filesRef.current[key] || [];
    if (incoming.length + existing.length > 8) { onError('Можно прикрепить до 8 файлов.'); return; }
    if (incoming.some(file => file.size > MAX_FILE)) { onError('Максимальный размер файла — 25 МБ.'); return; }
    if (incoming.reduce((total, file) => total + file.size, existing.reduce((total, file) => total + file.size, 0)) > MAX_TOTAL) {
      onError('Общий размер вложений не должен превышать 100 МБ.'); return;
    }
    inFlight.current = true; setUploading(true);
    try {
      for (const file of incoming) {
        const attachment = await window.codex.uploadAttachment({ name: file.name, data: await read(file) });
        if (!alive.current) return;
        setFiles(all => ({ ...all, [key]: [...(all[key] || []), attachment] }));
      }
    } catch (error) { if (alive.current) onError(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; if (alive.current) setUploading(false); }
  }
  const isFile = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragEnter: (event: DragEvent) => { if (isFile(event)) { event.preventDefault(); if (++depth.current > 0) setDragging(true); } },
    onDragOver: (event: DragEvent) => { if (isFile(event)) { event.preventDefault(); event.dataTransfer.dropEffect = disabled || uploading ? 'none' : 'copy'; } },
    onDragLeave: (event: DragEvent) => { if (isFile(event)) { event.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setDragging(false); } } },
    onDrop: (event: DragEvent) => { if (isFile(event)) { event.preventDefault(); depth.current = 0; setDragging(false); void add(event.dataTransfer.files); } },
  };
  return {
    items: files[key] || [], uploading, dragging: dragging && !disabled, add, move, dropProps,
    remove: (id: string) => setFiles(all => ({ ...all, [key]: (all[key] || []).filter(file => file.id !== id) })),
    sent: (ids: string[]) => setFiles(all => Object.fromEntries(Object.entries(all).map(([key, list]) => [key, list.filter(file => !ids.includes(file.id))]))),
  };
}

export function AttachmentButton({ add, disabled, uploading }: { add: (files: FileList) => Promise<void>; disabled: boolean; uploading: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input className="attachment-file-input" ref={input} type="file" multiple tabIndex={-1} aria-label="Выбрать файлы" onChange={event => { if (event.target.files) void add(event.target.files); event.target.value = ''; }} />
    <button type="button" className="icon-button attachment-button" aria-label="Прикрепить файлы" title="Прикрепить файлы" disabled={disabled || uploading} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle size={17} className="spinning" /> : <Paperclip size={17} />}</button></>;
}

export function AttachmentStrip({ items, remove, disabled }: { items: Attachment[]; remove: (id: string) => void; disabled: boolean }) {
  if (!items.length) return null;
  return <div className="attachment-strip" aria-label="Вложения">{items.map(file => <div className="attachment-chip" key={file.id}>
    {file.image ? <Image size={16} /> : <FileText size={16} />}<span><strong>{file.name}</strong><small>{sizeLabel(file.size)}</small></span>
    <button type="button" aria-label={`Убрать ${file.name}`} disabled={disabled} onClick={() => remove(file.id)}><X size={13} /></button>
  </div>)}</div>;
}

export function attachmentMessage(text: string): { text: string; files: { name: string; path?: string; image?: boolean }[] } {
  text = text.replace(/\s*<unicode_auto>[\s\S]*?<\/unicode_auto>\s*/g, '').trim();
  const match = text.match(/\s*<unicode_attachments>\s*([\s\S]*?)\s*<\/unicode_attachments>\s*$/);
  if (!match) return { text, files: [] };
  try {
    const files = JSON.parse(match[1]);
    if (!Array.isArray(files) || !files.length || files.length > 8 || files.some(file => !file || typeof file.name !== 'string' || typeof file.path !== 'string')) return { text, files: [] };
    return { text: text.slice(0, match.index).trim(), files };
  } catch { return { text, files: [] }; }
}

export function MessageFiles({ files, onError, cwd }: { files: { name: string; path?: string; image?: boolean }[]; onError: (message: string) => void; cwd: string }) {
  if (!files.length) return null;
  return <div className="message-files">{files.map((file, index) => <button type="button" key={index} disabled={!file.path} onClick={() => {
    if (file.path) void window.codex.openLink({ href: encodeURI(file.path), cwd }).catch(error => onError(error instanceof Error ? error.message : String(error)));
  }}>{file.image ? <Image size={16} /> : <FileText size={16} />}<span>{file.name}</span></button>)}</div>;
}
