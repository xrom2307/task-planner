// Синхронизация с Google Sheets через веб-приложение на Apps Script (см.
// google-apps-script/Code.gs). Никаких OAuth-секретов на клиенте — просто URL + токен,
// оба хранятся в localStorage этого браузера/устройства.
//
// Модель: localStorage — источник истины офлайн, всегда пишем туда синхронно.
// Sheets — общий экземпляр между устройствами: тянем целиком при загрузке/возврате в
// приложение, отправляем целиком (с задержкой) после каждого изменения. Одновременная
// работа с двух устройств не предполагается (сутки/трое — ты физически в одном месте),
// поэтому конфликтов "кто последний записал" осознанно не разруливаем сложнее этого.

const SYNC_ENDPOINT_KEY = 'planner_sync_endpoint';
const SYNC_TOKEN_KEY = 'planner_sync_token';
const DISMISSED_MOYSKLAD_KEY = 'planner_dismissed_moysklad';
const REMOVED_MOYSKLAD_KEY = 'planner_removed_moysklad';
const PUSH_DEBOUNCE_MS = 1500;

const Sync = {
  endpoint: null,
  token: null,
  pushTimer: null,
  status: 'idle', // idle | syncing | ok | error | offline
  lastSyncedAt: null,
  onStatusChange: null,

  loadConfig() {
    this.endpoint = localStorage.getItem(SYNC_ENDPOINT_KEY) || null;
    this.token = localStorage.getItem(SYNC_TOKEN_KEY) || null;
    return this.isConfigured();
  },

  configure(endpoint, token) {
    this.endpoint = endpoint || null;
    this.token = token || null;
    if (this.endpoint) localStorage.setItem(SYNC_ENDPOINT_KEY, this.endpoint);
    else localStorage.removeItem(SYNC_ENDPOINT_KEY);
    if (this.token) localStorage.setItem(SYNC_TOKEN_KEY, this.token);
    else localStorage.removeItem(SYNC_TOKEN_KEY);
  },

  isConfigured() {
    return !!(this.endpoint && this.token);
  },

  setStatus(status) {
    this.status = status;
    if (status === 'ok') this.lastSyncedAt = new Date();
    if (this.onStatusChange) this.onStatusChange(status);
  },

  async pull() {
    if (!this.isConfigured()) return false;
    this.setStatus('syncing');
    try {
      const res = await fetch(`${this.endpoint}?token=${encodeURIComponent(this.token)}&t=${Date.now()}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!Array.isArray(data.tasks)) throw new Error('bad response');

      const dismissed = this.loadDismissedMoysklad();
      // Разовое восстановление: "резка ширм+подарок под покраску" была случайно удалена
      // через ✕ ДО того, как появился нормальный список для восстановления (см. ↺ и
      // restoreDismissedMoysklad) — список на телефоне тогда ещё пуст, поэтому снимаем
      // именно эту задачу из "скрытых" напрямую, один раз. Можно удалить этот блок
      // следующим коммитом, как только задача вернётся в очередь.
      if (dismissed.delete('ms_881e753b-9f9e-11f1-0a80-197a00bd3d73')) {
        localStorage.setItem(DISMISSED_MOYSKLAD_KEY, JSON.stringify([...dismissed]));
      }
      const priorById = new Map(Store.state.tasks.map(t => [t.id, t]));
      const tasks = data.tasks
        .map(normalizeTaskFromSheet)
        .filter(t => !(t.source === 'moysklad' && dismissed.has(t.id)));

      // Задачи МойСклад сервер всегда отдаёт "pending" (он не знает, что ты уже начал
      // таймер — это чисто клиентское состояние, никогда не пишется в Tasks). Без этого
      // любой фоновый pull (например, просто свернул и развернул приложение — событие
      // visibilitychange) обнулял бы уже идущий таймер. Переносим статус/таймер с
      // предыдущей копии той же задачи (id стабилен между синками).
      tasks.forEach(t => {
        if (t.source !== 'moysklad') return;
        const prior = priorById.get(t.id);
        if (prior && (prior.status === 'in_progress' || prior.status === 'paused')) {
          t.status = prior.status;
          t.runStartedAt = prior.runStartedAt;
          t.activeSec = prior.activeSec;
          t.pauses = prior.pauses;
          t.startedAt = prior.startedAt;
        }
      });

      Store.state.tasks = tasks;
      Object.assign(Store.state.settings, normalizeSettingsFromSheet(data.settings || {}));
      Store.saveLocalOnly();
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.warn('Sync pull failed', e);
      this.setStatus(navigator.onLine ? 'error' : 'offline');
      return false;
    }
  },

  // Задачи из МойСклад (Фаза 3, только чтение) сервер отдаёт заново на каждый pull —
  // он не знает, что ты её уже сделал. "Скрыто" храним чисто локально (не синкается),
  // это просто фильтр от повторного показа на этом устройстве, не источник истины.
  loadDismissedMoysklad() {
    try {
      return new Set(JSON.parse(localStorage.getItem(DISMISSED_MOYSKLAD_KEY) || '[]'));
    } catch (e) {
      return new Set();
    }
  },

  dismissMoysklad(id) {
    const set = this.loadDismissedMoysklad();
    set.add(id);
    localStorage.setItem(DISMISSED_MOYSKLAD_KEY, JSON.stringify([...set]));
  },

  // Отдельный (более узкий) список — только задачи, убранные через ✕ в очереди, а НЕ
  // через обычное завершение ("Готово" тоже вызывает dismissMoysklad — иначе она бы
  // воскресала на следующем pull). Если мешать оба случая в одном списке, "восстановить
  // последнюю" может по ошибке вернуть уже честно завершённую задачу вместо реально
  // удалённой по ошибке. Храним {id, title}, чтобы восстанавливать по названию, а не вслепую.
  loadRemovedMoysklad() {
    try {
      return JSON.parse(localStorage.getItem(REMOVED_MOYSKLAD_KEY) || '[]');
    } catch (e) {
      return [];
    }
  },

  markRemovedMoysklad(task) {
    const arr = this.loadRemovedMoysklad();
    arr.push({ id: task.id, title: task.title || task.productType || task.id });
    localStorage.setItem(REMOVED_MOYSKLAD_KEY, JSON.stringify(arr));
  },

  // Убирает задачу и из "удалённых" (список для восстановления), и из общих "скрытых"
  // (иначе следующий pull() тут же отфильтрует её обратно).
  restoreDismissedMoysklad(id) {
    const arr = this.loadRemovedMoysklad().filter(item => item.id !== id);
    localStorage.setItem(REMOVED_MOYSKLAD_KEY, JSON.stringify(arr));
    const dismissed = this.loadDismissedMoysklad();
    dismissed.delete(id);
    localStorage.setItem(DISMISSED_MOYSKLAD_KEY, JSON.stringify([...dismissed]));
  },

  // Вызывается из Store.save() после каждого изменения — с задержкой, чтобы не долбить
  // Apps Script на каждый чих (например, тикающий таймер сам по себе save() не дёргает,
  // но быстрая последовательность действий — пауза сразу после старта и т.п. — могла бы).
  schedulePush() {
    if (!this.isConfigured()) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push(), PUSH_DEBOUNCE_MS);
  },

  async push() {
    if (!this.isConfigured()) return false;
    this.setStatus('syncing');
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        // text/plain, а не application/json — иначе браузер шлёт CORS-preflight (OPTIONS),
        // а Apps Script Web App его не обрабатывает и запрос падает.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          token: this.token,
          tasks: Store.state.tasks,
          settings: Store.state.settings,
        }),
      });
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.warn('Sync push failed', e);
      this.setStatus(navigator.onLine ? 'error' : 'offline');
      return false;
    }
  },
};

// Sheets отдаёт пустые ячейки как '' — приводим обратно к null/числам/булевым,
// чтобы задачи вели себя так же, как только что созданные локально.
function normalizeTaskFromSheet(row) {
  const t = Object.assign({}, row);

  ['equipmentId', 'moyskladOrderId', 'dueDate', 'startedAt', 'completedAt', 'runStartedAt',
   'resultProductType', 'resultStage', 'resultEquipmentId'].forEach(f => {
    if (t[f] === '' || t[f] === undefined) t[f] = null;
  });

  ['qty', 'qtyDone', 'resultQty'].forEach(f => {
    t[f] = (t[f] === '' || t[f] === null || t[f] === undefined) ? null : Number(t[f]);
  });

  t.manualBoost = t.manualBoost === '' || t.manualBoost == null ? 0 : Number(t.manualBoost);
  t.activeSec = t.activeSec === '' || t.activeSec == null ? 0 : Number(t.activeSec);
  t.estimateSec = t.estimateSec === '' || t.estimateSec == null ? null : Number(t.estimateSec);

  ['portable', 'materialsPrepped', 'urgent'].forEach(f => {
    t[f] = t[f] === true || t[f] === 'TRUE' || t[f] === 'true';
  });

  // На случай если Sheets всё же успел превратить строку в дату несмотря на текстовый формат.
  ['dueDate', 'createdAt', 'startedAt', 'completedAt', 'runStartedAt'].forEach(f => {
    if (t[f] instanceof Date) t[f] = t[f].toISOString();
  });

  t.pauses = Array.isArray(t.pauses) ? t.pauses : [];
  return t;
}

function normalizeSettingsFromSheet(settings) {
  const out = Object.assign({}, settings);
  if (out.lastEquipmentId === '') out.lastEquipmentId = null;
  if (out.lastMaintenanceMonth === '') out.lastMaintenanceMonth = null;
  // На случай если Sheets всё же превратил 'YYYY-MM' в дату несмотря на текстовый формат столбца.
  if (out.lastMaintenanceMonth instanceof Date) {
    const d = out.lastMaintenanceMonth;
    out.lastMaintenanceMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return out;
}
