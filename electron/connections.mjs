const officialUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
      && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

/** Keep the progressive catalog on the main side; paginate and search locally. */
export class Connections {
  constructor(rpc, changed = () => {}) {
    this.rpc = rpc; this.changed = changed;
    this.apps = new Map(); this.installed = new Map(); this.waiters = new Set();
    this.epoch = 0; this.started = false;
    rpc.on('notification', message => {
      if (message.method === 'app/list/updated' && Array.isArray(message.params?.data)) {
        this.merge(message.params.data); this.signal();
      }
      if (message.method === 'account/updated') this.reset();
    });
    rpc.on('disconnected', () => this.reset());
  }

  reset() {
    this.epoch++; this.started = false; this.catalogJob = null; this.runtimeJob = null;
    this.catalogError = ''; this.runtimeError = ''; this.runtimeKnown = false;
    this.apps.clear(); this.installed.clear(); this.signal();
  }

  signal() {
    for (const wake of [...this.waiters]) wake();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.changed(); }, 100);
      this.timer.unref?.();
    }
  }

  merge(data) {
    for (const app of data) {
      if (typeof app?.id !== 'string' || typeof app.name !== 'string') continue;
      this.apps.set(app.id, { id: app.id, name: app.name, description: app.description || '',
        installUrl: officialUrl(app.installUrl), isAccessible: app.isAccessible === true, isEnabled: app.isEnabled === true });
    }
  }

  refresh(force) {
    const epoch = this.epoch;
    this.started = true;
    if (!this.catalogJob) {
      this.catalogError = '';
      const deadline = Date.now() + 20000;
      this.catalogJob = this.rpc.request('app/list', { cursor: null, limit: 100, forceRefetch: force }, { timeoutMs: 20000 })
        .then(async result => {
          if (epoch !== this.epoch) return;
          if (!Array.isArray(result.data)) throw new Error('Неверный ответ каталога.');
          this.merge(result.data);
          // Full progressive notifications include all sources, while the final
          // response can be just its first page. Preserve the larger snapshot.
          let cursor = result.nextCursor;
          let received = result.data.length;
          while (cursor && this.apps.size <= received && epoch === this.epoch) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Истекло время загрузки каталога.');
            const page = await this.rpc.request('app/list', { cursor, limit: 100, forceRefetch: false }, { timeoutMs: remaining });
            if (epoch !== this.epoch) return;
            if (!Array.isArray(page.data)) throw new Error('Неверный ответ каталога.');
            this.merge(page.data); this.signal(); received += page.data.length;
            if (page.nextCursor === cursor) throw new Error('Каталог вернул повторную страницу.');
            cursor = page.nextCursor;
          }
        })
        .catch(error => {
          if (epoch !== this.epoch) return;
          this.catalogError = error.code === -32601 || /experimental|not supported|unknown method/i.test(error.message)
            ? 'Каталог недоступен в этой версии Codex CLI. Обновите Codex CLI.'
            : 'Не удалось завершить загрузку каталога Codex. Нажмите «Обновить статус», чтобы повторить.';
        })
        .finally(() => { if (epoch === this.epoch) { this.catalogJob = null; this.signal(); } });
    }
    if (!this.runtimeJob) {
      this.runtimeError = '';
      this.runtimeJob = this.rpc.request('app/installed', { forceRefresh: force }, { timeoutMs: 15000 })
        .then(result => {
          if (epoch !== this.epoch) return;
          if (!Array.isArray(result.apps)) throw new Error('Неверный ответ подключений.');
          this.installed = new Map(result.apps.filter(app => typeof app.id === 'string').map(app => [app.id, app]));
          this.runtimeKnown = true;
        })
        .catch(() => { if (epoch === this.epoch) { this.runtimeKnown = false; this.runtimeError = 'Codex не подтвердил доступность инструментов. Обновите статус позже.'; } })
        .finally(() => { if (epoch === this.epoch) { this.runtimeJob = null; this.signal(); } });
    }
  }

  snapshot(query) {
    const values = new Map(this.apps);
    for (const app of this.installed.values()) if (!values.has(app.id)) values.set(app.id, {
      id: app.id, name: app.runtimeName || app.id, description: '', installUrl: null,
      isAccessible: app.callable === true, isEnabled: app.enabled === true,
    });
    return [...values.values()].map(app => {
      const effective = this.installed.get(app.id);
      return { ...app, runtimeKnown: this.runtimeKnown === true, callable: this.runtimeKnown === true && effective?.callable === true,
        enabled: effective ? effective.enabled === true : app.isEnabled };
    }).filter(app => `${app.name} ${app.description}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(b.callable) - Number(a.callable) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async list(cursor = null, refresh = false, query = '') {
    if (cursor !== null && (typeof cursor !== 'string' || !/^\d{1,8}$/.test(cursor))) throw new Error('Неверная страница подключений.');
    if (typeof query !== 'string' || query.length > 200) throw new Error('Слишком длинный поисковый запрос.');
    await this.rpc.connect();
    if (!this.started || refresh === true) this.refresh(refresh === true);
    // Return quickly if installed apps or progressive directory data are ready.
    // The network catalog and the runtime status refresh never block each other.
    if (!this.apps.size && !this.installed.size && (this.catalogJob || this.runtimeJob)) {
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 2000); this.waiters.add(wake);
      });
    }
    const all = this.snapshot(query.trim().toLocaleLowerCase());
    const offset = Number(cursor || 0);
    return { data: all.slice(offset, offset + 100), nextCursor: offset + 100 < all.length ? String(offset + 100) : null,
      total: all.length, loading: !!this.catalogJob || !!this.runtimeJob,
      runtimeWarning: [this.catalogError, this.runtimeError].filter(Boolean).join(' ') || null };
  }

  async setEnabled({ id, enabled } = {}) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id) || (!this.apps.has(id) && !this.installed.has(id)) || typeof enabled !== 'boolean') throw new Error('Неверное подключение.');
    await this.rpc.request('config/value/write', { keyPath: `apps.${id}.enabled`, value: enabled, mergeStrategy: 'upsert' });
  }
}
