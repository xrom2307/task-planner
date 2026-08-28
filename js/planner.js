// Логика приоритизации: что доступно в текущем режиме и в каком порядке предлагать.

function isRedLaserCutoffPassed(now) {
  return now.getHours() >= 9;
}

// Сколько секунд осталось до конца рабочего дня (только в режиме "Работа"). Если рабочий
// день уже кончился (иногда задерживаешься) — не считаем это жёстким стопом, просто окно
// перестаёт влиять на скоринг (возвращаем null).
function remainingWorkSec(mode, now) {
  if (mode !== 'work') return null;
  const [eh, em] = WORK_HOURS.end.split(':').map(Number);
  const end = new Date(now);
  end.setHours(eh, em, 0, 0);
  return now < end ? (end - now) / 1000 : null;
}

function buildCtx(state, now) {
  const mode = state.settings.mode;
  return { now, mode, lastEquipmentId: state.settings.lastEquipmentId, remainingSec: remainingWorkSec(mode, now) };
}

// Задача доступна в текущем режиме дежурства/дома/выходного?
function isAvailable(task, mode, now) {
  if (task.status === 'done') return false;

  // Красный лазер: резка трекеров инициативы — только до 09:00.
  if (task.equipmentId === 'laser_red' && task.stage && task.stage.includes('до 09:00')) {
    if (isRedLaserCutoffPassed(now)) return false;
  }

  // Станок физически занят другим фоновым циклом — нельзя параллельно зарядить его же.
  if (task.equipmentId && Store.runningCycles().some(c => c.equipmentId === task.equipmentId)) {
    return false;
  }

  if (mode === 'weekend') return true; // выходной — свободный режим, ограничений нет

  if (mode === 'duty') {
    // Задачи из МойСклад (Фаза 3) — это всегда физическая работа в цехе (иначе бы её
    // не делал сам Хромов Д. В., см. Code.gs), даже когда у неё пока нет equipmentId
    // (v1 не сопоставляет техкарты со станками) — их нельзя принять за компьютерную.
    if (task.source === 'moysklad') return false;
    // На дежурстве: только компьютерные задачи (нет оборудования, не портативная сборка)
    // либо портативная сборка с материалами, заранее взятыми с собой.
    if (task.equipmentId) return false;
    if (task.portable) return !!task.materialsPrepped;
    return true; // задача без оборудования и без пометки portable считаем компьютерной
  }

  // mode === 'work': всё доступно.
  return true;
}

function scoreTask(task, ctx) {
  let score = 0;

  // Дедлайн — чем ближе, тем выше приоритет. Просроченные — максимум.
  if (task.dueDate) {
    const due = new Date(task.dueDate + 'T23:59:59');
    const daysLeft = (due - ctx.now) / (1000 * 60 * 60 * 24);
    if (daysLeft < 0) score += 100;
    else score += Math.max(0, 30 - daysLeft * 3);
  }

  // Срочно — форс-мажор, всегда выше обычной сортировки по дедлайну/возрасту.
  if (task.urgent) score += 1000;

  // Ручная подстройка порядка (кнопки ▲▼ в очереди).
  score += task.manualBoost || 0;

  // Батчинг: продолжить работу на том же станке, что и последняя завершённая задача.
  if (task.equipmentId && task.equipmentId === ctx.lastEquipmentId) score += 15;

  const equipment = task.equipmentId ? EQUIPMENT.find(e => e.id === task.equipmentId) : null;
  const lastEquipment = ctx.lastEquipmentId ? EQUIPMENT.find(e => e.id === ctx.lastEquipmentId) : null;

  // Группировка по зданию: если уже на "Втором здании" (40м) — не бегать туда-сюда
  // ради одной задачи, добить там всё, что есть, раз уж пришёл.
  if (equipment && lastEquipment && equipment.location === lastEquipment.location) score += 8;

  // Задачи с приближающимся окном (например, красный лазер до 09:00) — подталкиваем вверх.
  if (task.equipmentId === 'laser_red' && task.stage && task.stage.includes('до 09:00')) {
    score += 20;
  }

  // "Покормить станок": задача заряжает простаивающий неотрывный станок — пока он крутится
  // в фоне, ты успеваешь сделать что-то ещё, поэтому это обычно приоритетнее чисто ручной
  // работы. Исключение — конец рабочего дня: если по опыту цикл не успеет закончиться
  // до конца окна, станок останется работать без присмотра — бонус не даём.
  // Уборка и ТО тоже привязаны к станку, но цикл не запускают — их это не касается.
  if (equipment && equipment.unattended && task.source !== 'cleanup' && task.source !== 'maintenance') {
    let feedBonus = FEED_BONUS;
    if (ctx.remainingSec != null) {
      const cycleSig = Store.signatureFor(Object.assign({}, task, { kind: 'machine_cycle' }));
      const perUnit = Store.medianPerUnitSec(cycleSig);
      if (perUnit != null && perUnit * (task.qty || 1) > ctx.remainingSec) feedBonus = 0;
    }
    score += feedBonus;
  }

  // Влезает ли задача целиком в оставшееся до конца дня время — мягкая подсказка,
  // не жёсткий фильтр (не запрещаем начинать долгое под конец дня, просто не подталкиваем).
  if (ctx.remainingSec != null) {
    const est = task.estimateSec || Store.estimateFor(task);
    score += est <= ctx.remainingSec ? 5 : -5;
  }

  // Конец дня — подтягиваем уборку, чтобы не уйти домой в разгром на станке.
  if (ctx.remainingSec != null && ctx.remainingSec <= WIND_DOWN_MIN * 60 && task.source === 'cleanup') {
    score += 30;
  }

  // Не даём совсем старым задачам простаивать вечно.
  const ageDays = (ctx.now - new Date(task.createdAt)) / (1000 * 60 * 60 * 24);
  score += Math.min(ageDays, 10);

  return score;
}

// Возвращает задачи, доступные сейчас, отсортированные по приоритету.
// В режиме "выходной" сортируем только по ручному приоритету — без давления дедлайнов.
function getQueue(state, now = new Date()) {
  const mode = state.settings.mode;
  const ctx = buildCtx(state, now);

  const available = state.tasks.filter(t =>
    (t.status === 'pending' || t.status === 'paused') && isAvailable(t, mode, now)
  );

  // Задачи "снять/перезарядить станок" всегда продавливаются в самый верх —
  // станок физически стоит и ждёт, это не может подождать своей очереди по скорингу.
  const urgent = available.filter(t => t.kind === 'machine_unload');
  const rest = available.filter(t => t.kind !== 'machine_unload');

  if (mode === 'weekend') {
    return [...urgent, ...rest.sort((a, b) =>
      (b.urgent === a.urgent ? 0 : b.urgent ? 1 : -1) || (b.manualBoost || 0) - (a.manualBoost || 0)
    )];
  }

  const sortedRest = rest
    .map(t => ({ task: t, score: scoreTask(t, ctx) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.task);

  return [...urgent, ...sortedRest];
}

// После завершения задачи решаем, нужно ли вставить задачу "Уборка: <станок>".
// Логика: если следующая по очереди задача использует ТОТ ЖЕ станок — уборка пока не нужна
// (продолжаем серию на этом станке). Если станок больше сегодня не используется — вставляем уборку.
function maybeCreateCleanupTask(store, completedTask, now = new Date()) {
  if (!completedTask.equipmentId) return null;

  const queue = getQueue(store.state, now).filter(t => t.id !== completedTask.id);
  const nextUsesSameEquipment = queue.length > 0 && queue[0].equipmentId === completedTask.equipmentId;
  if (nextUsesSameEquipment) return null;

  const stillQueued = queue.some(t => t.equipmentId === completedTask.equipmentId);
  if (stillQueued) return null;

  const equipment = EQUIPMENT.find(e => e.id === completedTask.equipmentId);
  if (!equipment) return null;

  return store.addTask({
    title: `Уборка: ${equipment.name}`,
    equipmentId: equipment.id,
    stage: 'Уборка',
    source: 'cleanup',
    estimateSec: undefined, // пересчитается через estimateFor, но сигнатура своя (stage=Уборка)
  });
}
