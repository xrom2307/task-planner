// Слой хранения. Сейчас — localStorage; схема специально сделана такой,
// чтобы в Фазе 2 её можно было один в один перенести в Google Sheets
// (каждый top-level массив = один лист, объекты = строки).

const STORAGE_KEY = 'planner_state_v1';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  return {
    tasks: [],       // см. форму объекта ниже
    settings: {
      mode: 'work',            // work | duty | weekend
      lastEquipmentId: null,   // последнее использованное оборудование — для батчинга
      lastMaintenanceMonth: null,  // 'YYYY-MM' последнего месяца, для которого создали ТО станков
    },
  };
}

/*
Task shape:
{
  id, title,
  productType, stage,          // может быть пусто для произвольной задачи
  equipmentId,                 // null для computer/portable задач
  source: 'manual' | 'moysklad' | 'cleanup' | 'maintenance',
  portable: bool,               // можно делать без станка (сборка руками/за компом)
  materialsPrepped: bool,       // для portable: материалы уже взяты с собой на дежурство
  dueDate: 'YYYY-MM-DD' | null,
  urgent: bool,                   // форс-мажор — всегда наверху очереди
  manualBoost: number,            // ручная подстройка порядка (кнопки ▲▼ в очереди), по умолчанию 0
  status: 'pending' | 'in_progress' | 'paused' | 'done',
  moyskladOrderId: string | null,
  createdAt, startedAt, completedAt,   // ISO строки
  activeSec: number,             // накопленное время работы (без пауз), обновляется по ходу
  pauses: [{ start, end, reason }],
  estimateSec: number | null,    // кэш последней оценки (медиана), пересчитывается при показе
  qty: number | null,            // плановое количество, если задача партийная (напр. 100 счётчиков)
  qtyDone: number | null,        // сколько реально сделано — заполняется при завершении
  kind: 'task' | 'machine_cycle' | 'machine_unload' | 'wait',  // фазы работы со станком/ожиданием
  runStartedAt: string | null,   // момент начала текущего "забега" (переживает перезагрузку страницы)
  // Только для kind='wait': что создать, когда время выйдет (см. startWait/finishWait).
  resultProductType: string | null,
  resultStage: string | null,
  resultEquipmentId: string | null,
  resultQty: number | null,
}
*/

const Store = {
  state: null,

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.state = raw ? JSON.parse(raw) : defaultState();
    } catch (e) {
      console.error('Ошибка чтения хранилища, начинаем с чистого состояния', e);
      this.state = defaultState();
    }
    return this.state;
  },

  // Только локально — используется, когда состояние ТОЛЬКО ЧТО пришло с сервера
  // (Sync.pull), чтобы не запускать push сразу вслед за pull того же самого.
  saveLocalOnly() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  },

  save() {
    this.saveLocalOnly();
    if (typeof Sync !== 'undefined') Sync.schedulePush();
  },

  signatureFor(task) {
    let base;
    if (task.equipmentId) base = `${task.productType || ''}|${task.stage || ''}|${task.equipmentId}`;
    else if (task.productType) base = `${task.productType}|${task.stage || ''}`;
    else base = `title:${(task.title || '').trim().toLowerCase()}`;
    // Загрузка станка, сам цикл и снятие/перезарядка — совсем разные по длительности
    // фазы одной и той же связки продукт+этап+станок, медиану им нельзя мешать в одну кучу.
    return task.kind && task.kind !== 'task' ? `${base}::${task.kind}` : base;
  },

  // Медиана считается НА ЕДИНИЦУ (activeSec / фактическое количество), чтобы задачи
  // с разным qty (например, 30 и 100 счётчиков) корректно масштабировались.
  // Для задач без qty единица — сама задача (qty=1).
  medianPerUnitSec(signature) {
    const samples = this.state.tasks
      .filter(t => t.status === 'done' && this.signatureFor(t) === signature && t.activeSec > 0)
      .map(t => t.activeSec / (t.qtyDone || t.qty || 1))
      .sort((a, b) => a - b);
    if (samples.length === 0) return null;
    const mid = Math.floor(samples.length / 2);
    return samples.length % 2 === 0 ? Math.round((samples[mid - 1] + samples[mid]) / 2) : samples[mid];
  },

  estimateFor(task) {
    const sig = this.signatureFor(task);
    const perUnit = this.medianPerUnitSec(sig);
    if (perUnit != null) return Math.round(perUnit * (task.qty || 1));
    if (task.stage === 'Уборка') return DEFAULT_CLEANUP_SEC;
    return task.equipmentId ? 25 * 60 : 15 * 60; // грубая заглушка, пока нет истории по этой сигнатуре
  },

  addTask(partial) {
    const task = Object.assign({
      id: genId(),
      title: '',
      productType: '',
      stage: '',
      equipmentId: null,
      source: 'manual',
      portable: false,
      materialsPrepped: false,
      dueDate: null,
      urgent: false,
      manualBoost: 0,
      status: 'pending',
      moyskladOrderId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      activeSec: 0,
      pauses: [],
      estimateSec: null,
      qty: null,
      qtyDone: null,
      kind: 'task',
      runStartedAt: null,
      resultProductType: null,
      resultStage: null,
      resultEquipmentId: null,
      resultQty: null,
    }, partial);
    // Для станочных циклов длительность задаёт человек при запуске (программа резки/фрезеровки
    // известна заранее) — она авторитетнее любой медианы, поэтому не пересчитываем поверх неё.
    task.estimateSec = partial.estimateSec != null ? partial.estimateSec : this.estimateFor(task);
    this.state.tasks.push(task);
    this.save();
    return task;
  },

  // Запускает фоновый станочный цикл: отдельная "задача" с kind='machine_cycle',
  // которая сразу в статусе in_progress и не участвует в очереди (getQueue её не видит,
  // т.к. она никогда не бывает pending). Таймер идёт независимо от того, чем ты занят руками.
  startCycle(loadTask, durationSec) {
    const now = new Date().toISOString();
    return this.addTask({
      productType: loadTask.productType,
      stage: loadTask.stage,
      equipmentId: loadTask.equipmentId,
      source: loadTask.source,
      kind: 'machine_cycle',
      status: 'in_progress',
      startedAt: now,
      runStartedAt: now,
      estimateSec: durationSec,
    });
  },

  runningCycles() {
    return this.state.tasks.filter(t => t.kind === 'machine_cycle' && t.status === 'in_progress');
  },

  // Цикл догорел — фиксируем его как done и создаём задачу "снять/перезарядить",
  // которая продавливается в самый верх очереди (см. planner.js). Шумная — со звуком.
  finishCycle(cycleId) {
    const cycle = this.getTask(cycleId);
    if (!cycle) return null;
    cycle.status = 'done';
    cycle.completedAt = new Date().toISOString();
    if (cycle.runStartedAt) {
      cycle.activeSec = (Date.now() - new Date(cycle.runStartedAt).getTime()) / 1000;
      cycle.runStartedAt = null;
    }
    this.save();

    const equipment = EQUIPMENT.find(e => e.id === cycle.equipmentId);
    return this.addTask({
      title: `Снять / перезарядить: ${equipment ? equipment.name : cycle.equipmentId}`,
      productType: cycle.productType,
      stage: cycle.stage,
      equipmentId: cycle.equipmentId,
      source: cycle.source,
      kind: 'machine_unload',
      urgent: true,
    });
  },

  // Пассивное ожидание (склейка/высыхание) — не занимает станок, просто отсчитывает время
  // до готовности партии к следующему этапу. Тихая — без звука/баннера, просто появится
  // в очереди сама, когда время выйдет (см. app.js renderCycles/renderUnloadBanner).
  startWait(sourceTask, durationSec, nextStage) {
    const now = new Date().toISOString();
    return this.addTask({
      productType: sourceTask.productType,
      stage: sourceTask.stage,
      equipmentId: null,
      source: sourceTask.source,
      kind: 'wait',
      status: 'in_progress',
      startedAt: now,
      runStartedAt: now,
      estimateSec: durationSec,
      resultProductType: nextStage.productType,
      resultStage: nextStage.stage,
      resultEquipmentId: nextStage.equipmentId,
      resultQty: nextStage.qty || null,
    });
  },

  runningWaits() {
    return this.state.tasks.filter(t => t.kind === 'wait' && t.status === 'in_progress');
  },

  finishWait(waitId) {
    const wait = this.getTask(waitId);
    if (!wait) return null;
    wait.status = 'done';
    wait.completedAt = new Date().toISOString();
    if (wait.runStartedAt) {
      wait.activeSec = (Date.now() - new Date(wait.runStartedAt).getTime()) / 1000;
      wait.runStartedAt = null;
    }
    this.save();

    return this.addTask({
      productType: wait.resultProductType,
      stage: wait.resultStage,
      equipmentId: wait.resultEquipmentId,
      source: wait.source,
      kind: 'task',
      qty: wait.resultQty,
    });
  },

  updateTask(id, patch) {
    const t = this.state.tasks.find(t => t.id === id);
    if (!t) return null;
    Object.assign(t, patch);
    this.save();
    return t;
  },

  getTask(id) {
    return this.state.tasks.find(t => t.id === id) || null;
  },

  pendingTasks() {
    return this.state.tasks.filter(t => t.status === 'pending' || t.status === 'paused');
  },

  // Фоновые станочные циклы и ожидания (kind='machine_cycle'/'wait') намеренно исключены —
  // это не "текущая задача", которой ты занят руками, а параллельный фоновый таймер.
  currentTask() {
    return this.state.tasks.find(t =>
      t.status === 'in_progress' && t.kind !== 'machine_cycle' && t.kind !== 'wait'
    ) || null;
  },

  pendingUnloadTasks() {
    return this.state.tasks.filter(t => t.kind === 'machine_unload' && t.status === 'pending');
  },

  setMode(mode) {
    this.state.settings.mode = mode;
    this.save();
  },

  getMode() {
    return this.state.settings.mode;
  },

  // runStartedAt (а не переменная в памяти) хранит момент начала текущего "забега" —
  // так таймер переживает перезагрузку страницы/закрытие вкладки.
  startTask(id) {
    const t = this.getTask(id);
    if (!t) return null;
    t.status = 'in_progress';
    if (!t.startedAt) t.startedAt = new Date().toISOString();
    t.runStartedAt = new Date().toISOString();
    this.save();
    return t;
  },

  pauseTask(id, reason) {
    const t = this.getTask(id);
    if (!t) return null;
    if (t.runStartedAt) {
      t.activeSec += (Date.now() - new Date(t.runStartedAt).getTime()) / 1000;
      t.runStartedAt = null;
    }
    t.pauses.push({ start: new Date().toISOString(), end: null, reason: reason || null });
    t.status = 'paused';
    this.save();
    return t;
  },

  setLastPauseReason(id, reason) {
    const t = this.getTask(id);
    if (!t) return null;
    const open = t.pauses.find(p => p.end === null);
    if (open) open.reason = reason;
    this.save();
    return t;
  },

  resumeTask(id) {
    const t = this.getTask(id);
    if (!t) return null;
    const open = t.pauses.find(p => p.end === null);
    if (open) open.end = new Date().toISOString();
    t.status = 'in_progress';
    t.runStartedAt = new Date().toISOString();
    this.save();
    return t;
  },

  // Отмена: работа прекращается, но задача НЕ считается выполненной — возвращается
  // в очередь как обычная pending-задача. Накопленное время (activeSec) сохраняется,
  // чтобы при повторном старте не терять уже сделанное; в медиану оно не попадёт,
  // так как медиана считается только по status === 'done'.
  cancelTask(id) {
    const t = this.getTask(id);
    if (!t) return null;
    if (t.runStartedAt) {
      t.activeSec += (Date.now() - new Date(t.runStartedAt).getTime()) / 1000;
      t.runStartedAt = null;
    }
    const open = t.pauses.find(p => p.end === null);
    if (open) open.end = new Date().toISOString();
    t.status = 'pending';
    this.save();
    return t;
  },

  // qtyDone передаётся только для партийных задач (task.qty задан). Если сделано
  // меньше плана — остаток НЕ теряется, а становится новой pending-задачей с тем же
  // продуктом/этапом/станком, чтобы она осталась в очереди на потом.
  completeTask(id, qtyDone) {
    const t = this.getTask(id);
    if (!t) return null;
    if (t.status === 'in_progress' && t.runStartedAt) {
      t.activeSec += (Date.now() - new Date(t.runStartedAt).getTime()) / 1000;
      t.runStartedAt = null;
    }
    t.status = 'done';
    t.completedAt = new Date().toISOString();
    if (t.qty) t.qtyDone = Math.max(0, Math.min(t.qty, qtyDone == null ? t.qty : qtyDone));
    this.state.settings.lastEquipmentId = t.equipmentId || this.state.settings.lastEquipmentId;
    // Задача из МойСклад v1 — только чтение: завершение тут не продвигает статус там,
    // поэтому запоминаем локально, что она уже сделана, иначе воскреснет при следующем pull.
    if (t.source === 'moysklad' && typeof Sync !== 'undefined') Sync.dismissMoysklad(t.id);
    this.save();

    if (t.qty && t.qtyDone < t.qty) {
      this.addTask({
        title: t.title,
        productType: t.productType,
        stage: t.stage,
        equipmentId: t.equipmentId,
        source: t.source,
        portable: t.portable,
        materialsPrepped: t.materialsPrepped,
        dueDate: t.dueDate,
        urgent: t.urgent,
        qty: t.qty - t.qtyDone,
      });
    }
    return t;
  },

  // Завершение сборной задачи из МойСклад (несколько вариантов сразу под одним этапом,
  // см. groupMoySkladTasks) — doneMap это {subItemId: сколькоСделано}. В отличие от
  // completeTask, не создаём задачу-остаток: раз задача не пишется обратно в МойСклад,
  // недоделанные варианты сами всплывут заново на следующей синхронизации.
  completeGroupedMoyskladTask(id, doneMap) {
    const t = this.getTask(id);
    if (!t) return null;
    if (t.status === 'in_progress' && t.runStartedAt) {
      t.activeSec += (Date.now() - new Date(t.runStartedAt).getTime()) / 1000;
      t.runStartedAt = null;
    }
    const totalDone = Object.values(doneMap).reduce((a, b) => a + b, 0);
    t.status = 'done';
    t.completedAt = new Date().toISOString();
    t.qtyDone = totalDone;
    this.save();

    if (typeof Sync !== 'undefined') {
      (t.subItems || []).forEach(item => Sync.dismissMoysklad(item.id));
    }
    return t;
  },

  elapsedSec(t) {
    if (t.status === 'in_progress' && t.runStartedAt) {
      return t.activeSec + (Date.now() - new Date(t.runStartedAt).getTime()) / 1000;
    }
    return t.activeSec;
  },

  openPauseElapsedSec(t) {
    const open = t.pauses.find(p => p.end === null);
    if (!open) return 0;
    return (Date.now() - new Date(open.start).getTime()) / 1000;
  },

  // Раз в месяц — по задаче на ТО каждого станка. Проверяется дёшево (сравнение строки)
  // на каждый тик, поэтому неважно, когда именно открыть приложение в новом месяце —
  // хоть 1-го, хоть 15-го, задачи появятся при первом же заходе и не задублируются.
  generateMaintenanceTasksIfNeeded(now = new Date()) {
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (this.state.settings.lastMaintenanceMonth === ym) return [];
    this.state.settings.lastMaintenanceMonth = ym;
    const dueDate = `${ym}-05`;
    const created = EQUIPMENT.map(eq => this.addTask({
      title: `Обслуживание станка: ${eq.name}`,
      equipmentId: eq.id,
      stage: 'Обслуживание',
      source: 'maintenance',
      dueDate,
    }));
    this.save();
    return created;
  },

  removeTask(id) {
    const t = this.getTask(id);
    if (t && t.source === 'moysklad' && typeof Sync !== 'undefined') {
      if (t.subItems && t.subItems.length) t.subItems.forEach(item => Sync.dismissMoysklad(item.id));
      else Sync.dismissMoysklad(t.id);
    }
    this.state.tasks = this.state.tasks.filter(t => t.id !== id);
    this.save();
  },
};
