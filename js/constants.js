// Затравочные данные прототипа. Список станков и типовых причин паузы —
// можно редактировать прямо здесь, пока нет экрана настроек.

// unattended: true — станок можно зарядить, нажать пуск и уйти на другую задачу;
// цикл идёт в фоне сам, твоё участие требуется только чтобы зарядить/снять.
// Отметил по смыслу названий станков — поправь, если где-то не так.
// location/floor — второе здание (40м от основного цеха, там несколько этажей).
// Не только подрозетники: оптоволоконный лазер (трекеры заклинаний, KingLaser) тоже там.
const LOC_MAIN = 'Якорная';
const LOC_OUTLET = 'Второе здание (40м)';

const EQUIPMENT = [
  { id: 'laser_big',    name: 'CO2 лазер большой',        group: 'laser',  unattended: true,  location: LOC_MAIN },
  { id: 'laser_red',     name: 'CO2 лазер красный',         group: 'laser',  unattended: true,  location: LOC_MAIN,
    note: 'Резка трекеров инициативы — только до 09:00' },
  { id: 'laser_green',   name: 'CO2 лазер зелёный',         group: 'laser',  unattended: true,  location: LOC_MAIN },
  { id: 'laser_small',   name: 'CO2 лазер малый',           group: 'laser',  unattended: true,  location: LOC_MAIN },
  { id: 'drum_sander',   name: 'Барабанно-шлифовальный станок', group: 'sanding', unattended: false, location: LOC_MAIN },
  { id: 'cnc_big',       name: 'Фрезерный ЧПУ большой',      group: 'cnc',    unattended: true,  location: LOC_MAIN },
  { id: 'router',        name: 'Фрезерный станок',           group: 'cnc',    unattended: false, location: LOC_MAIN },
  { id: 'hand_sander',   name: 'Ручная шлифмашинка',         group: 'sanding', unattended: false, location: LOC_MAIN },
  { id: 'powder_coat',   name: 'Порошковая покраска с камерой полимеризации', group: 'paint', unattended: true, location: LOC_MAIN },

  // Второе здание (40м) — подрозетники + оптоволоконный лазер (KingLaser).
  { id: 'cnc_small',     name: 'Фрезерный ЧПУ малый (подрозетники)', group: 'cnc',   unattended: true,  location: LOC_OUTLET, floor: 2 },
  { id: 'panel_saw',     name: 'Форматно-раскроечный станок', group: 'cnc',    unattended: false, location: LOC_OUTLET },
  { id: 'spray_gun',     name: 'Краскопульт',                group: 'paint',  unattended: false, location: LOC_OUTLET },
  { id: 'fiber_laser',   name: 'Оптоволоконный лазерный ЧПУ', group: 'laser',  unattended: true,  location: LOC_OUTLET },
];

// Комбинации продукт+этап -> станок, которые встречаются регулярно.
// Используется для подсказки станка при создании задачи и для расчёта медианы.
const TASK_TEMPLATES = [
  { productType: 'Ширма',            stage: 'Резка заготовки',   equipmentId: 'laser_big' },
  { productType: 'Ширма',            stage: 'Гравировка',        equipmentId: 'laser_red' },
  { productType: 'Ширма',            stage: 'Гравировка',        equipmentId: 'laser_green' },
  { productType: 'Ширма',            stage: 'Гравировка',        equipmentId: 'laser_small' },
  { productType: 'Ширма',            stage: 'Шкурка',            equipmentId: 'drum_sander' },
  { productType: 'Ширма',            stage: 'Шкурка вручную',    equipmentId: 'hand_sander' },
  { productType: 'Ширма',            stage: 'Продувка от пыли',  equipmentId: null },
  { productType: 'Ширма',            stage: 'Сборка',            equipmentId: null, portable: true },

  // Заготовки под печать (UV-печать вместо покраски) — тот же самый МойСклад-этап
  // резки, что и обычная Ширма, но дальше идёт другой физический цикл: без гравировки
  // и сборки, зато с шпатлёвкой и временем на её высыхание. См. MOYSKLAD_CHAIN_MAP —
  // именно вариант продукта (assortmentName) в самой задаче МойСклад решает, в какую
  // из двух цепочек (эту или обычную Ширму) попадёт следующий этап после резки.
  { productType: 'Ширма (под печать)', stage: 'Резка заготовки',        equipmentId: 'laser_big' },
  { productType: 'Ширма (под печать)', stage: 'Шкурка',                 equipmentId: 'drum_sander' },
  { productType: 'Ширма (под печать)', stage: 'Шпатлёвка',              equipmentId: null, postWaitHours: 3 },
  { productType: 'Ширма (под печать)', stage: 'Шкурка после шпатлёвки', equipmentId: 'drum_sander' },

  { productType: 'Башня',            stage: 'Резка заготовки',   equipmentId: 'laser_big' },
  { productType: 'Башня',            stage: 'Шлифовка',          equipmentId: 'drum_sander' },
  { productType: 'Башня',            stage: 'Сборка',            equipmentId: null, portable: true },

  // МойСклад "резка арена с алькантарой" уже приезжает с наклеенной алькантарой —
  // сама наклейка происходит раньше и МойСклад не отслеживается, но оставляем в
  // шаблоне для порядка/ручного добавления. Цепочка стартует сразу с резки.
  { productType: 'Арена',            stage: 'Наклейка алькантары', equipmentId: null },
  { productType: 'Арена',            stage: 'Резка заготовки',   equipmentId: 'laser_big' },
  { productType: 'Арена',            stage: 'Шлифовка',          equipmentId: 'drum_sander' },

  { productType: 'Подставка',        stage: 'Резка заготовки',   equipmentId: 'laser_big' },
  { productType: 'Подставка',        stage: 'Шкурка',            equipmentId: 'drum_sander' },

  { productType: 'Магнитный держатель', stage: 'Резка заготовки', equipmentId: 'laser_big' },
  { productType: 'Магнитный держатель', stage: 'Шкурка',          equipmentId: 'drum_sander' },

  { productType: 'Счётчик',          stage: 'Резка/гравировка',  equipmentId: 'laser_red' },
  { productType: 'Счётчик',          stage: 'Шкурка',            equipmentId: 'drum_sander' },
  { productType: 'Счётчик',          stage: 'Сборка',            equipmentId: null, portable: true },

  // Отдельный вариант — белый счётчик: красится ДО резки (заготовка ещё без гравировки),
  // после красится каждая деталь режется/гравируется отдельным проходом (не альтернативы
  // станка, а разные детали — секвенция), в конце шкурятся только задние стенки и
  // шестерёнки (лицевые и внутренние остаются как есть после резки).
  { productType: 'Счётчик (белый)',  stage: 'Покраска в белый',        equipmentId: null },
  { productType: 'Счётчик (белый)',  stage: 'Резка лицевых',           equipmentId: 'laser_red' },
  { productType: 'Счётчик (белый)',  stage: 'Резка задних',            equipmentId: 'laser_red' },
  { productType: 'Счётчик (белый)',  stage: 'Резка шестерёнок',        equipmentId: 'laser_red' },
  { productType: 'Счётчик (белый)',  stage: 'Резка внутренних',        equipmentId: 'laser_red' },
  { productType: 'Счётчик (белый)',  stage: 'Шкурка задних и шестерёнок', equipmentId: 'drum_sander' },

  { productType: 'Трекер заклинаний', stage: 'Резка/гравировка (дерево)', equipmentId: 'laser_red' },
  { productType: 'Трекер заклинаний', stage: 'Металл (резка)',    equipmentId: 'fiber_laser' },
  { productType: 'Трекер заклинаний', stage: 'Покраска металла',  equipmentId: 'powder_coat' },
  { productType: 'Трекер заклинаний', stage: 'Шкурка вручную',    equipmentId: 'hand_sander' },
  { productType: 'Трекер заклинаний', stage: 'Сборка',            equipmentId: null, portable: true },

  { productType: 'Трекер инициативы', stage: 'Резка (до 09:00)',  equipmentId: 'laser_red' },

  // Полный цикл ДТ (заготовка -> магниты -> склейка -> отлёжка -> чистовая обработка).
  // МойСклад "заготовка дт" — это только первый шаг (фрезеровка), см. MOYSKLAD_CHAIN_MAP.
  { productType: 'Дайстрей',         stage: 'Фрезеровка на ЧПУ',        equipmentId: 'cnc_big' },
  { productType: 'Дайстрей',         stage: 'Лазерная резка (4мм)',     equipmentId: 'laser_big' },
  { productType: 'Дайстрей',         stage: 'Вставка магнитов',         equipmentId: null, portable: true },
  { productType: 'Дайстрей',         stage: 'Склейка',                  equipmentId: null, postWaitHours: 10 },
  { productType: 'Дайстрей',         stage: 'Шкурка грубым зерном',     equipmentId: 'drum_sander' },
  { productType: 'Дайстрей',         stage: 'Фрезеровка на фрезерном столе', equipmentId: 'router' },
  { productType: 'Дайстрей',         stage: 'Шкурка мелким зерном',     equipmentId: 'hand_sander' },

  { productType: 'Дайсбокс',         stage: 'Фрезеровка',         equipmentId: 'cnc_big' },
  { productType: 'Дайсбокс',         stage: 'Обработка кромки',   equipmentId: 'router' },

  { productType: 'Кингминибокс',     stage: 'Фрезеровка',         equipmentId: 'cnc_big' },
  { productType: 'Кингминибокс',     stage: 'Обработка кромки',   equipmentId: 'router' },

];

// Подрозетники — сторонний заказ, отдельное помещение (см. EQUIPMENT). 5 типов (1..5),
// делаются одинаково, поэтому шаблон генерируется циклом. Этапы 5 и 6 (ручная покраска,
// этикетки) делает не пользователь — в планировщик пока не включены.
// postWaitHours — после этапа партия должна отлежаться (клей/краска), прежде чем
// станет доступен следующий этап; см. store.js startWait/finishWait.
for (let n = 1; n <= 5; n++) {
  const p = `Подрозетник ${n}`;
  TASK_TEMPLATES.push(
    { productType: p, stage: 'Фрезеровка ЧПУ',              equipmentId: 'cnc_small' },
    { productType: p, stage: 'Шлифовка, склейка',            equipmentId: null, postWaitHours: 5 },
    { productType: p, stage: 'Покраска (краскопульт)',       equipmentId: 'spray_gun', postWaitHours: 3 },
    { productType: p, stage: 'Распиловка (раскроечный)',     equipmentId: 'panel_saw' },
  );
}

const PRODUCT_TYPES = [...new Set(TASK_TEMPLATES.map(t => t.productType))];

// Следующий этап по порядку в шаблоне того же продукта — используется и когда
// заканчивается фоновое ожидание (склейка/высыхание), и как подсказка после обычного
// завершения задачи. У некоторых продуктов один этап встречается несколько раз подряд
// с разным станком-АЛЬТЕРНАТИВОЙ (например, "Гравировка" Ширмы — любой из трёх лазеров,
// не последовательность) — поэтому ищем точное совпадение по станку, а следующим
// считаем первый шаг с ДРУГИМ названием этапа, пропуская остальные альтернативы.
function nextTemplateStage(productType, currentStage, currentEquipmentId) {
  const list = TASK_TEMPLATES.filter(t => t.productType === productType);
  let idx = list.findIndex(t => t.stage === currentStage && (t.equipmentId || null) === (currentEquipmentId || null));
  if (idx === -1) idx = list.findIndex(t => t.stage === currentStage);
  if (idx === -1) return null;
  for (let i = idx + 1; i < list.length; i++) {
    if (list[i].stage !== currentStage) return list[i];
  }
  return null;
}

// Задание из МойСклад иногда — только первый шаг более длинного физического цикла,
// который дальше уже ведётся локально по TASK_TEMPLATES (см. suggestNextStage в
// app.js). Сам этап МойСклад один на всех вариантов ("лазерная резка ширм+подарок"),
// поэтому какая именно цепочка имеется в виду, различаем по названию продукта строки
// (assortmentName — приходит с сервера как msAssortmentName, см. Code.gs
// syncMoySkladTasks_/readMoySkladTasks_): "заготовка под покраску" ведёт в обычную
// цепочку Ширмы (гравировка -> шкурка -> продувка -> сборка), "заготовка под печать" —
// в отдельную цепочку без гравировки и сборки, зато с шпатлёвкой и отлёжкой.
const MOYSKLAD_CHAIN_MAP = [
  { stageTest: s => s.includes('резка') && s.includes('ширм'), variantTest: v => v.includes('под покраску'),
    productType: 'Ширма', stage: 'Резка заготовки', equipmentId: 'laser_big' },
  { stageTest: s => s.includes('резка') && s.includes('ширм'), variantTest: v => v.includes('под печать'),
    productType: 'Ширма (под печать)', stage: 'Резка заготовки', equipmentId: 'laser_big' },
  { stageTest: s => s.includes('башн'), variantTest: () => true,
    productType: 'Башня', stage: 'Резка заготовки', equipmentId: 'laser_big' },
  { stageTest: s => s.includes('арена'), variantTest: () => true,
    productType: 'Арена', stage: 'Резка заготовки', equipmentId: 'laser_big' },
  // "резка,гравировка,шкурка счётчиков" — до этого назначение по ошибке цепляло
  // задачи под конкретные варианты ("ночной компас" и т.п.), которые на самом деле
  // не твои; варианты этой цепочки не различаем, ловим по самому названию этапа.
  { stageTest: s => s.includes('гравировка') && s.includes('шкурка'), variantTest: () => true,
    productType: 'Счётчик (белый)', stage: 'Резка лицевых', equipmentId: 'laser_red' },
  { stageTest: s => s.includes('заготовка дт'), variantTest: () => true,
    productType: 'Дайстрей', stage: 'Фрезеровка на ЧПУ', equipmentId: 'cnc_big' },
];

// Возвращает точку входа в локальную цепочку для завершённой задачи из МойСклад,
// либо null, если для неё известной цепочки нет (тогда suggestNextStage просто
// ничего не предложит, как и раньше для остальных МойСклад-этапов).
function resolveMoyskladChainStart(msTask) {
  const stage = (msTask.productType || '').toLowerCase();
  const variant = (msTask.msAssortmentName || '').toLowerCase();
  const entry = MOYSKLAD_CHAIN_MAP.find(e => e.stageTest(stage) && e.variantTest(variant));
  return entry ? { productType: entry.productType, stage: entry.stage, equipmentId: entry.equipmentId } : null;
}

// Типы продукции, которые можно СОБИРАТЬ на дежурстве, если материалы взяты заранее.
const DUTY_PORTABLE_PRODUCTS = ['Башня', 'Счётчик', 'Трекер заклинаний', 'Ширма'];

// Рабочий день в режиме "Работа" (Якорная) — для оценки, влезает ли задача/станочный
// цикл до конца дня. Обычно 7:00-16:30, иногда задерживаешься — поэтому "после конца
// дня" не считаем жёстким стопом, просто окно перестаёт учитываться (см. planner.js).
const WORK_HOURS = { start: '07:00', end: '16:30' };

const FEED_BONUS = 25;      // "покормить простаивающий неотрывный станок" — приоритетнее ручной работы
const WIND_DOWN_MIN = 45;   // за сколько минут до конца дня подтягивать уборку/короткие задачи

const PAUSE_REASONS = [
  'Перерыв / еда',
  'Отвлекли',
  'Не хватает материала',
  'Жду решения по складу',
  'Поломка / затупился инструмент',
  'Вызов (дежурство)',
  'Другое',
];

const MODES = {
  work:    { id: 'work',    label: 'Работа' },
  duty:    { id: 'duty',    label: 'Дежурство' },
  weekend: { id: 'weekend', label: 'Выходной' },
};

const DEFAULT_CLEANUP_SEC = 10 * 60; // 10 минут по умолчанию, пока нет своей истории

// Категории для задач из МойСклад (Фаза 3) — чисто для отображения в очереди
// (бейдж вместо станка, которого у них пока нет), порядок проверки важен:
// подрозетники — отдельная линия, даже если физически режутся на лазере/ЧПУ,
// их не нужно путать с "лазерными станками" основного цеха.
const MOYSKLAD_CATEGORIES = [
  { label: 'Подрозетники',    test: s => s.includes('подрозетник') },
  { label: 'Лазерные станки', test: s => s.includes('лазер') || s.includes('гравировк') },
  { label: 'Сборка',          test: s => s.includes('сборка') || s.includes('склейка') },
];

function moyskladCategory(task) {
  const s = `${task.productType || ''} ${task.title || ''}`.toLowerCase();
  const found = MOYSKLAD_CATEGORIES.find(c => c.test(s));
  return found ? found.label : 'Прочее';
}
