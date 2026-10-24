import { forwardRef, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ChevronUp, LoaderCircle } from 'lucide-react';
import { Virtuoso, type Components, type ListProps, type VirtuosoHandle } from 'react-virtuoso';
import type { Item, Runtime } from './types';
import { HISTORY_START, isVisibleItem } from './history';

type Context = { hasOlder: boolean; loading: boolean; error?: string; loadOlder: () => void; footer: ReactNode };

const HistoryList = forwardRef<HTMLDivElement, ListProps & { context?: Context }>(function HistoryList({ context: _context, ...props }, ref) {
  return <div {...props} className="virtual-message-list" ref={ref} />;
});
function Header({ context }: { context?: Context }) {
  return <div className="history-header">{context?.hasOlder && <>
    <button type="button" className="history-more" disabled={context.loading} onClick={context.loadOlder}>
      {context.loading ? <LoaderCircle size={13} className="spinning" /> : <ChevronUp size={13} />}
      {context.loading ? 'Загружаем…' : context.error ? 'Повторить загрузку' : 'Более ранние сообщения'}
    </button>{context.error && <span className="history-page-error" role="alert">{context.error}</span>}
  </>}</div>;
}
function Footer({ context }: { context?: Context }) {
  return <div className="history-footer">{context?.footer}</div>;
}
const components: Components<Item, Context> = { List: HistoryList, Header, Footer };
const keyForItem = (_index: number, item: Item) => item.id;

export function ChatHistory({ runtime, renderItem, onLoadOlder, scrollSignal, footer }: {
  runtime: Runtime; renderItem: (item: Item) => ReactNode; onLoadOlder: () => void; scrollSignal: number; footer: ReactNode;
}) {
  const list = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const userScrolled = useRef(false);
  const items = useMemo(() => runtime.items.filter(isVisibleItem), [runtime.items]);
  const context: Context = { hasOlder: !!runtime.historyCursor, loading: !!runtime.loadingOlder, error: runtime.historyError, loadOlder: onLoadOlder, footer };
  const live = useRef({ runtime, onLoadOlder, renderItem });
  live.current = { runtime, onLoadOlder, renderItem };
  const older = useCallback(() => {
    const { runtime, onLoadOlder } = live.current;
    if (userScrolled.current && runtime.historyCursor && !runtime.loadingOlder && !runtime.historyError) onLoadOlder();
  }, []);
  const content = useCallback((_index: number, item: Item) => <div className="virtual-message">{live.current.renderItem(item)}</div>, []);

  useEffect(() => {
    atBottom.current = true;
    list.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, [scrollSignal]);
  useEffect(() => {
    if (atBottom.current) list.current?.autoscrollToBottom();
  }, [runtime.items, footer]);

  return <Virtuoso<Item, Context> ref={list} className="history-scroller" style={{ height: '100%' }}
    data={items} context={context} components={components} itemContent={content} computeItemKey={keyForItem}
    firstItemIndex={runtime.historyOffset ?? HISTORY_START} defaultItemHeight={110}
    initialTopMostItemIndex={items.length ? { index: 'LAST', align: 'end' } : undefined}
    increaseViewportBy={{ top: 240, bottom: 160 }} atBottomThreshold={80} followOutput="auto"
    atBottomStateChange={value => { atBottom.current = value; }}
    startReached={older}
    onWheel={() => { userScrolled.current = true; }} onTouchMove={() => { userScrolled.current = true; }}
    onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) userScrolled.current = true; }}
    onScroll={event => {
      if (event.currentTarget.scrollTop > 240) userScrolled.current = true;
      if (event.currentTarget.scrollTop < 180) older();
    }} />;
}
