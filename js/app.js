// Склейка UI: всё на одном экране — текущая задача (с паузой внутри неё же)
// сверху, очередь на сегодня и форма добавления снизу. Обновляется раз в секунду.

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function equipmentName(id) {
  const e = EQUIPMENT.find(e => e.id === id);
  return e ? e.name : null;
}

function displayTitle(t) {
  const base = t.title || `${t.productType} — ${t.stage}`;
  return t.qty ? `${base} (${t.qty} шт)` : base;
}

function productLabel(t) {
  if (t.productType) return t.productType;
  if (t.source === 'cleanup') return 'Уборка';
  if (t.source === 'maintenance') return 'ТО';
  return 'Задача';
}

// Короткий двойной сигнал через Web Audio — без внешних файлов, не требует сети.
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.15);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.16);
    });
  } catch (e) { /* звук не критичен, молча пропускаем */ }
}

// Проверяем фоновые таймеры каждый тик: станочный цикл — со звуком (станок физически
// освободился, надо подойти); пассивное ожидание (склейка/сушка) — тихо, просто появится
// в очереди следующая задача сама.
function tickBackgroundCycles() {
  Store.runningCycles().forEach(cycle => {
    if (Store.elapsedSec(cycle) >= cycle.estimateSec) {
      Store.finishCycle(cycle.id);
      beep();
    }
  });
  Store.runningWaits().forEach(wait => {
    if (Store.elapsedSec(wait) >= wait.estimateSec) {
      Store.finishWait(wait.id);
    }
  });
}

function renderCycles() {
  const wrap = document.getElementById('cyclesWrap');
  const items = [...Store.runningCycles(), ...Store.runningWaits()];
  wrap.hidden = items.length === 0;
  wrap.innerHTML = '';
  items.forEach(c => {
    const remaining = c.estimateSec - Store.elapsedSec(c);
    const label = c.equipmentId ? equipmentName(c.equipmentId) : `${c.productType} — отлёживается`;
    const div = document.createElement('div');
    div.className = 'cycle-chip';
    if (c.kind === 'wait') div.classList.add('wait-chip');
    div.innerHTML = `<span class="cycle-eq">${label}</span>` +
      `<span class="cycle-time">${remaining > 0 ? 'осталось ' + fmt(remaining) : 'завершается…'}</span>`;
    wrap.appendChild(div);
  });
}

function renderUnloadBanner() {
  const banner = document.getElementById('unloadBanner');
  const pending = Store.pendingUnloadTasks();
  banner.hidden = pending.length === 0;
  banner.innerHTML = '';
  pending.forEach(t => {
    const row = document.createElement('div');
    row.className = 'unload-row';
    const label = document.createElement('span');
    label.textContent = `🔔 ${equipmentName(t.equipmentId)} закончил цикл`;
    const goBtn = document.createElement('button');
    goBtn.textContent = 'Перейти';
    goBtn.onclick = () => startTaskAndShow(t.id);
    row.appendChild(label);
    row.appendChild(goBtn);
    banner.appendChild(row);
  });
}

// Предлагает длительность цикла: медиана по прошлым циклам этой же связки продукт/этап/станок,
// иначе — известный ориентир самой задачи (например, у гравировки ширмы он задан вручную,
// см. SHIRMA_ENGRAVING_OPTIONS), а если и его нет — пусто, пользователь вводит сам.
function promptCycleDuration(loadTask) {
  const probe = Object.assign({}, loadTask, { kind: 'machine_cycle' });
  const sig = Store.signatureFor(probe);
  const perUnit = Store.medianPerUnitSec(sig);
  const suggested = perUnit != null ? Math.round(perUnit * (loadTask.qty || 1) / 60)
    : (loadTask.estimateSec ? Math.round(loadTask.estimateSec / 60) : '');
  const input = prompt('Станок запущен. Сколько будет длиться цикл, минут?', suggested ? String(suggested) : '');
  if (input === null) return null;
  const minutes = parseFloat(input.replace(',', '.'));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.round(minutes * 60);
}

// Гравировка ширмы — не взаимозаменяемые альтернативы станка, а разные по времени и
// количеству проходов варианты (малый станок гравирует тремя проходами по секциям) — см.
// SHIRMA_ENGRAVING_OPTIONS. Спрашиваем номер простым prompt(), как и остальные диалоги
// приложения, вместо генерации отдельного этапа через nextTemplateStage.
function promptShirmaEngravingChoice() {
  const lines = SHIRMA_ENGRAVING_OPTIONS.map((opt, i) => {
    const totalSec = opt.passes.reduce((sum, p) => sum + p.estimateSec, 0);
    return `${i + 1}) ${opt.label} — ${Math.round(totalSec / 60)} мин`;
  });
  const input = prompt(`Гравировка ширмы — выбери станок:\n${lines.join('\n')}\nНомер (1-${SHIRMA_ENGRAVING_OPTIONS.length}):`, '1');
  if (input === null) return null;
  const idx = parseInt(input, 10) - 1;
  return SHIRMA_ENGRAVING_OPTIONS[idx] || null;
}

// Список задач из МойСклад, удалённых через ✕ на этом устройстве (см. Store.removeTask/
// Sync.markRemovedMoysklad) — по умолчанию предлагает САМУЮ ПОСЛЕДНЮЮ (частый случай:
// один случайный тап), но по названию можно выбрать и более раннюю, если между делом
// успел удалить/завершить что-то ещё.
function promptRestoreMoyskladChoice() {
  const items = Sync.loadRemovedMoysklad();
  if (!items.length) return null;
  const lines = items.map((it, i) => `${i + 1}) ${it.title}`);
  const input = prompt(`Какую задачу вернуть?\n${lines.join('\n')}\nНомер (1-${items.length}):`, String(items.length));
  if (input === null) return null;
  const idx = parseInt(input, 10) - 1;
  return items[idx] || null;
}

// Определяет, какой этап пойдёт следующим, если задачу сейчас завершить — с учётом
// того, что задача из МойСклад может быть входом в локальную цепочку (см. MOYSKLAD_CHAIN_MAP).
// Общая логика для suggestNextStage и для доBtn-проверки "нужен ли выбор станка ДО завершения".
function resolveNextStage(task) {
  const chainStart = task.source === 'moysklad' ? resolveMoyskladChainStart(task) : null;
  const productType = chainStart ? chainStart.productType : task.productType;
  const stage = chainStart ? chainStart.stage : task.stage;
  const equipmentId = chainStart ? chainStart.equipmentId : task.equipmentId;
  return { next: nextTemplateStage(productType, stage, equipmentId), chainStart };
}

// Подсказка после обычного завершения (без жёсткого тайм-гейта, поэтому не создаём
// задачу автоматически — просто предлагаем, добавить можно/нет решаешь сам). Пригождается,
// например, когда снял готовый модуль подрозетника со станка и параллельно зарядил
// следующий в цикл — уже снятый модуль можно сразу поставить в очередь на шлифовку/склейку.
//
// engravingChoice — если выбор станка для гравировки ширмы уже был сделан ЗАРАНЕЕ (см.
// doneBtn), используем его вместо повторного prompt(): важно, чтобы диалог с выбором не
// повторялся дважды и чтобы отмену можно было безопасно обработать ДО завершения задачи.
function suggestNextStage(completedTask, doneQty, engravingChoice) {
  const { next, chainStart } = resolveNextStage(completedTask);
  if (!next) return;

  if (next.productType === 'Ширма' && next.stage === 'Гравировка') {
    const choice = engravingChoice || promptShirmaEngravingChoice();
    if (!choice) return;
    choice.passes.forEach(p => {
      Store.addTask({
        productType: 'Ширма',
        stage: p.stage,
        title: p.title || '',
        equipmentId: choice.equipmentId,
        source: chainStart ? 'manual' : completedTask.source,
        qty: doneQty != null ? doneQty : completedTask.qty,
        estimateSec: p.estimateSec,
      });
    });
    return;
  }

  const label = doneQty ? `${next.stage} (${doneQty} шт)` : next.stage;
  if (!confirm(`Готово. Добавить в очередь следующий этап — «${label}»?`)) return;
  Store.addTask({
    productType: next.productType,
    stage: next.stage,
    equipmentId: next.equipmentId,
    source: chainStart ? 'manual' : completedTask.source,
    qty: doneQty != null ? doneQty : completedTask.qty,
  });
}

// Аналогично promptCycleDuration, но в часах — для пассивного ожидания (склейка/сушка).
function promptWaitHours(defaultHours) {
  const input = prompt('Партия должна отлежаться перед следующим этапом. Сколько часов ждать?', String(defaultHours));
  if (input === null) return null;
  const hours = parseFloat(input.replace(',', '.'));
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.round(hours * 3600);
}

// Двигает задачу на одну позицию вверх/вниз в её текущем "поясе" очереди (срочные —
// отдельно от обычных). Реальные score соседних задач часто почти совпадают (бонус за
// возраст — доли дня), поэтому вместо фиксированного отступа берём точную середину между
// score соседа, которого обходим, и score следующего за ним — так гарантированно
// переставляется ровно на одну позицию, не перепрыгивая дальше.
function nudgeTask(id, direction) {
  const queue = getQueue(Store.state);
  const idx = queue.findIndex(t => t.id === id);
  const otherIdx = idx + direction;
  if (idx === -1 || otherIdx < 0 || otherIdx >= queue.length) return;

  const t = queue[idx];
  const other = queue[otherIdx];
  if (t.kind === 'machine_unload' || other.kind === 'machine_unload') return; // эти вне скоринга
  if (!!t.urgent !== !!other.urgent) return; // не перепрыгиваем через границу "срочно"

  const ctx = buildCtx(Store.state, new Date());
  // Задачи без дедлайна/станка часто получают ОДИНАКОВЫЙ score (совпадают до бонуса за
  // возраст, если созданы почти одновременно) — на голых score середина между двумя
  // одинаковыми числами не сдвигает ничего. Подмешиваем крошечный тай-брейк по текущей
  // позиции в очереди, чтобы соседние score гарантированно отличались.
  const TIE_EPS = 1e-9;
  const effScore = (task, pos) => scoreTask(task, ctx) - pos * TIE_EPS;

  const otherEff = effScore(other, otherIdx);
  const beyondIdx = otherIdx + direction;
  const beyondTask = queue[beyondIdx];
  const beyond = (beyondTask && !!beyondTask.urgent === !!t.urgent && beyondTask.kind !== 'machine_unload') ? beyondTask : null;
  const targetEff = beyond
    ? (otherEff + effScore(beyond, beyondIdx)) / 2
    : otherEff + (direction === -1 ? 1 : -1); // на краю пояса — перепрыгивать нечего

  const tScore = scoreTask(t, ctx);
  t.manualBoost = (t.manualBoost || 0) + (targetEff - tScore);
  Store.save();
  renderAll();
}

function renderSyncBar() {
  const text = document.getElementById('syncStatusText');
  const nowBtn = document.getElementById('syncNowBtn');
  const restoreBtn = document.getElementById('restoreMoyskladBtn');

  if (!Sync.isConfigured()) {
    text.textContent = 'Синхронизация не настроена';
    nowBtn.hidden = true;
    restoreBtn.hidden = true;
    return;
  }

  nowBtn.hidden = false;
  restoreBtn.hidden = Sync.loadRemovedMoysklad().length === 0;
  const labels = {
    idle: 'Синхронизация настроена',
    syncing: 'Синхронизируется…',
    ok: `Синхронизировано ${Sync.lastSyncedAt ? Sync.lastSyncedAt.toLocaleTimeString().slice(0, 5) : ''}`,
    error: 'Ошибка синхронизации',
    offline: 'Нет сети — работаем локально',
  };
  text.textContent = labels[Sync.status] || Sync.status;
}

function renderModeSwitch() {
  const mode = Store.getMode();
  document.querySelectorAll('#modeSwitch button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function renderCurrent() {
  const t = Store.currentTask() || Store.state.tasks.find(t => t.status === 'paused');
  document.getElementById('noCurrentTask').hidden = !!t;
  document.getElementById('currentTaskCard').hidden = !t;
  if (!t) return;

  document.getElementById('curProduct').textContent = productLabel(t);
  document.getElementById('curStage').textContent = t.source === 'cleanup' ? '' : (t.stage || '');
  document.getElementById('curTitle').textContent = displayTitle(t);
  document.getElementById('curEquipment').textContent = equipmentName(t.equipmentId) ? `Оборудование: ${equipmentName(t.equipmentId)}` :
    (t.source === 'moysklad' ? moyskladCategory(t) : '');

  const isPaused = t.status === 'paused';
  document.getElementById('runningView').hidden = isPaused;
  document.getElementById('pausedView').hidden = !isPaused;

  if (isPaused) {
    renderPauseControls(t);
  } else {
    const elapsed = Store.elapsedSec(t);
    const estimate = t.estimateSec || Store.estimateFor(t);
    const over = elapsed > estimate;

    const timerEl = document.getElementById('timerDisplay');
    timerEl.textContent = fmt(elapsed);
    timerEl.classList.toggle('over', over);

    document.getElementById('timerTarget').textContent = `Ориентир: ${fmt(estimate)}${over ? ' — превышено' : ''}`;

    const pct = Math.min(100, (elapsed / estimate) * 100);
    const fill = document.getElementById('progressFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('over', over);
  }
}

function renderPauseControls(t) {
  document.getElementById('pauseTimerDisplay').textContent = fmt(Store.openPauseElapsedSec(t));

  const open = t.pauses.find(p => p.end === null);
  const reason = open ? open.reason : null;
  const isPreset = PAUSE_REASONS.includes(reason) && reason !== 'Другое';
  const isCustom = !!reason && !PAUSE_REASONS.includes(reason);
  const showCustomInput = reason === 'Другое' || isCustom;

  const wrap = document.getElementById('pauseReasons');
  wrap.innerHTML = '';
  PAUSE_REASONS.forEach(r => {
    const b = document.createElement('button');
    b.textContent = r;
    const selected = isPreset ? r === reason : (r === 'Другое' && showCustomInput);
    b.classList.toggle('selected', selected);
    b.addEventListener('click', () => {
      if (r === 'Другое') {
        const existing = document.getElementById('pauseCustomReason').value.trim();
        Store.setLastPauseReason(t.id, existing || 'Другое');
      } else {
        Store.setLastPauseReason(t.id, r);
      }
      renderCurrent();
    });
    wrap.appendChild(b);
  });

  const customInput = document.getElementById('pauseCustomReason');
  customInput.hidden = !showCustomInput;
  if (showCustomInput && document.activeElement !== customInput) {
    customInput.value = isCustom ? reason : '';
  }
  customInput.oninput = () => {
    Store.setLastPauseReason(t.id, customInput.value.trim() || 'Другое');
  };
}

function renderQueueAndNext() {
  const queue = getQueue(Store.state);
  const nextCard = document.getElementById('nextSuggestionCard');
  const noQueue = document.getElementById('noQueueMsg');

  nextCard.hidden = queue.length === 0;
  noQueue.hidden = queue.length !== 0;

  if (queue.length > 0) {
    const t = queue[0];
    document.getElementById('nextProduct').textContent = productLabel(t);
    document.getElementById('nextStage').textContent = t.source === 'cleanup' ? '' : (t.stage || '');
    document.getElementById('nextTitle').textContent = displayTitle(t);
    document.getElementById('nextEquipment').textContent = equipmentName(t.equipmentId) ? `Оборудование: ${equipmentName(t.equipmentId)}` :
      (t.source === 'moysklad' ? moyskladCategory(t) : '');
    document.getElementById('nextEstimate').textContent = `Ориентир: ${fmt(t.estimateSec || Store.estimateFor(t))}`;
    document.getElementById('startNextBtn').onclick = () => startTaskAndShow(t.id);
  }

  const list = document.getElementById('queueList');
  list.innerHTML = '';
  queue.forEach(t => {
    const li = document.createElement('li');
    if (t.source === 'cleanup') li.classList.add('cleanup');
    if (t.urgent) li.classList.add('urgent');
    if (t.dueDate && t.dueDate < todayISO()) li.classList.add('overdue');

    const main = document.createElement('div');
    main.className = 'ql-main';
    const title = document.createElement('div');
    title.className = 'ql-title';
    title.textContent = (t.urgent ? '🔥 ' : '') + displayTitle(t);
    const sub = document.createElement('div');
    sub.className = 'ql-sub';
    const bits = [];
    if (equipmentName(t.equipmentId)) bits.push(equipmentName(t.equipmentId));
    else if (t.source === 'moysklad') bits.push(moyskladCategory(t));
    bits.push(`~${fmt(t.estimateSec || Store.estimateFor(t))}`);
    if (t.dueDate) bits.push(`до ${t.dueDate}`);
    if (t.source === 'moysklad') bits.push(`МойСклад №${t.moyskladTaskNumber || ''}`);
    sub.textContent = bits.join(' · ');
    main.appendChild(title);
    main.appendChild(sub);

    // Ручная подстройка порядка — не показываем для "снять/перезарядить"
    // (они и так всегда наверху, вне обычного скоринга).
    const nudge = document.createElement('div');
    nudge.className = 'ql-nudge';
    if (t.kind !== 'machine_unload') {
      const upBtn = document.createElement('button');
      upBtn.textContent = '▲';
      upBtn.title = 'Поднять выше';
      upBtn.onclick = () => nudgeTask(t.id, -1);
      const downBtn = document.createElement('button');
      downBtn.textContent = '▼';
      downBtn.title = 'Опустить ниже';
      downBtn.onclick = () => nudgeTask(t.id, 1);
      nudge.appendChild(upBtn);
      nudge.appendChild(downBtn);
    }

    const actions = document.createElement('div');
    actions.className = 'ql-actions';

    const startBtn = document.createElement('button');
    startBtn.textContent = 'Начать';
    startBtn.onclick = () => startTaskAndShow(t.id);

    const delBtn = document.createElement('button');
    delBtn.className = 'ql-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Удалить задачу';
    delBtn.onclick = () => {
      if (!confirm(`Удалить «${displayTitle(t)}»?`)) return;
      Store.removeTask(t.id);
      renderAll();
    };

    actions.appendChild(startBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(nudge);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

function startTaskAndShow(id) {
  const current = Store.currentTask();
  if (current && current.id !== id) {
    // одна активная задача за раз — паузим текущую без причины (можно указать её тут же в карточке)
    Store.pauseTask(current.id, null);
  }
  Store.startTask(id);
  renderAll();
  document.getElementById('block-current').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function populateProductDropdown() {
  const sel = document.getElementById('f_productType');
  PRODUCT_TYPES.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    sel.appendChild(opt);
  });
}

function populateStageDropdown(productType) {
  const sel = document.getElementById('f_stage');
  sel.innerHTML = '<option value="">—</option>';
  TASK_TEMPLATES.filter(t => t.productType === productType).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.stage; opt.textContent = t.stage;
    sel.appendChild(opt);
  });
}

function renderAll() {
  Store.generateMaintenanceTasksIfNeeded(); // дёшево — просто сравнение 'YYYY-MM', можно каждый тик
  tickBackgroundCycles();
  renderSyncBar();
  renderModeSwitch();
  renderCurrent();
  renderCycles();
  renderUnloadBanner();
  renderQueueAndNext();
}

function initEvents() {
  document.querySelectorAll('#modeSwitch button').forEach(b => {
    b.addEventListener('click', () => { Store.setMode(b.dataset.mode); renderAll(); });
  });

  document.getElementById('syncConfigureBtn').addEventListener('click', () => {
    const endpoint = prompt('URL веб-приложения Apps Script (Deploy > Web app):', Sync.endpoint || '');
    if (endpoint === null) return;
    const token = prompt('Токен (тот же, что в TOKEN в Code.gs):', Sync.token || '');
    if (token === null) return;
    Sync.configure(endpoint.trim(), token.trim());
    if (Sync.isConfigured()) {
      Sync.pull().then(() => renderAll());
    }
    renderAll();
  });

  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    await Sync.pull();
    renderAll();
  });

  document.getElementById('restoreMoyskladBtn').addEventListener('click', async () => {
    const item = promptRestoreMoyskladChoice();
    if (!item) return;
    Sync.restoreDismissedMoysklad(item.id);
    await Sync.pull();
    renderAll();
  });

  document.getElementById('pauseBtn').addEventListener('click', () => {
    const t = Store.currentTask();
    if (!t) return;
    Store.pauseTask(t.id, null);
    renderAll();
  });

  document.getElementById('resumeBtn').addEventListener('click', () => {
    const t = Store.state.tasks.find(t => t.status === 'paused');
    if (!t) return;
    Store.resumeTask(t.id);
    renderAll();
  });

  document.getElementById('doneBtn').addEventListener('click', () => {
    const t = Store.currentTask();
    if (!t) return;

    // Гравировка ширмы требует выбора станка — спрашиваем ДО завершения задачи, а не
    // после (как обычно делает suggestNextStage), иначе отмена диалога (или его случайное
    // закрытие на телефоне) оставляла бы задачу уже помеченной выполненной и убранной из
    // очереди без всякого следующего этапа — она просто "терялась".
    const { next: upcoming } = resolveNextStage(t);
    let engravingChoice = null;
    if (upcoming && upcoming.productType === 'Ширма' && upcoming.stage === 'Гравировка') {
      engravingChoice = promptShirmaEngravingChoice();
      if (!engravingChoice) return; // отмена — задача остаётся активной, ничего не потеряно
    }

    let qtyDone = null;
    if (t.qty) {
      const input = prompt(`Сколько выполнено из ${t.qty}?`, String(t.qty));
      if (input === null) return; // передумал — не завершаем
      const parsed = parseInt(input, 10);
      qtyDone = Number.isFinite(parsed) ? parsed : t.qty;
    }

    const equipment = EQUIPMENT.find(e => e.id === t.equipmentId);
    const isUnattended = equipment && equipment.unattended;

    if (isUnattended && confirm('Запустить цикл на этом станке (заготовка заряжена, жмём пуск)?')) {
      const durationSec = promptCycleDuration(t);
      if (durationSec == null) {
        alert('Не понял длительность — цикл не запущен, задача осталась активной.');
        return;
      }
      Store.completeTask(t.id, qtyDone); // время загрузки/перезарядки — в статистику этой фазы
      Store.startCycle(t, durationSec);
      suggestNextStage(t, qtyDone, engravingChoice); // например: снятый модуль можно шлифовать, пока новый мелется
      renderAll();
      return;
    }

    // Партия должна отлежаться (склейка/сушка), прежде чем станет доступен следующий этап.
    const template = TASK_TEMPLATES.find(tpl => tpl.productType === t.productType && tpl.stage === t.stage);
    if (template && template.postWaitHours) {
      const durationSec = promptWaitHours(template.postWaitHours);
      if (durationSec == null) {
        alert('Не понял, сколько ждать — задача осталась активной, попробуй ещё раз.');
        return;
      }
      const next = nextTemplateStage(t.productType, t.stage, t.equipmentId);
      Store.completeTask(t.id, qtyDone);
      if (next) {
        Store.startWait(t, durationSec, { productType: next.productType, stage: next.stage, equipmentId: next.equipmentId, qty: qtyDone != null ? qtyDone : t.qty });
      }
      renderAll();
      return;
    }

    Store.completeTask(t.id, qtyDone);
    maybeCreateCleanupTask(Store, t);
    suggestNextStage(t, qtyDone, engravingChoice);
    renderAll();
  });

  document.getElementById('cancelBtn').addEventListener('click', () => {
    const t = Store.currentTask() || Store.state.tasks.find(t => t.status === 'paused');
    if (!t) return;
    if (!confirm(`Отменить «${t.title || t.productType + ' — ' + t.stage}»? Задача вернётся в очередь как невыполненная.`)) return;
    Store.cancelTask(t.id);
    renderAll();
  });

  document.getElementById('openAddForm').addEventListener('click', () => {
    document.getElementById('addTaskForm').hidden = false;
    document.getElementById('addTaskForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('cancelAddForm').addEventListener('click', () => {
    document.getElementById('addTaskForm').hidden = true;
  });

  document.getElementById('f_productType').addEventListener('change', (e) => {
    populateStageDropdown(e.target.value);
  });

  document.getElementById('addTaskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const productType = document.getElementById('f_productType').value;
    const stage = document.getElementById('f_stage').value;
    const title = document.getElementById('f_title').value.trim();
    const due = document.getElementById('f_due').value || null;
    const urgent = document.getElementById('f_urgent').checked;
    const prepped = document.getElementById('f_prepped').checked;
    const qtyRaw = document.getElementById('f_qty').value;
    const qty = qtyRaw ? Math.max(1, parseInt(qtyRaw, 10)) : null;

    const template = TASK_TEMPLATES.find(t => t.productType === productType && t.stage === stage);

    Store.addTask({
      productType: productType || '',
      stage: stage || '',
      title: title || (productType ? `${productType} — ${stage}` : ''),
      equipmentId: template ? template.equipmentId : null,
      portable: template ? !!template.portable : !productType,
      materialsPrepped: prepped,
      dueDate: due,
      urgent,
      qty,
    });

    e.target.reset();
    document.getElementById('addTaskForm').hidden = true;
    renderAll();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  Store.load(); // localStorage — сразу, синхронно, работает офлайн
  Sync.loadConfig();
  Sync.onStatusChange = renderSyncBar;

  populateProductDropdown();
  initEvents();
  renderAll();
  setInterval(renderAll, 1000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (Sync.isConfigured()) {
    await Sync.pull(); // подтягиваем то, что могло измениться на другом устройстве
    renderAll();
  }

  // Вернулись в приложение (свернули/развернули, переключили вкладку) — досинхронизируемся.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Sync.isConfigured()) {
      Sync.pull().then(renderAll);
    }
  });
});
