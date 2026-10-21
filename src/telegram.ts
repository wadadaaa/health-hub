/**
 * Telegram bot: photos and sentences about food in, a logged meal and the
 * day's remaining budget out.
 *
 * The webhook lives behind a secret path and Telegram's own secret-token
 * header. The first chat to say /start is bound as the owner (the URL is
 * already unguessable); everything after that is refused.
 */
import type { Queryable } from './db.js';
import { estimateFromPhoto, estimateFromText, EstimateError, type MealEstimate } from './estimate.js';
import { getSetting, setSetting } from './settings.js';
import { suggestFood, SuggestError } from './suggest.js';
import { deleteMeal, getDay, getWeek, listMeals, logMeal, logWeight, type DaySummary } from './service.js';

const API = 'https://api.telegram.org';

// ---------- Telegram API ----------

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
}

async function tg<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { ok: boolean; result: T; description?: string };
  if (!parsed.ok) throw new Error(`Telegram ${method}: ${parsed.description ?? 'not ok'}`);
  return parsed.result;
}

async function send(token: string, chatId: number, text: string): Promise<void> {
  await tg(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

/** Downloads a photo and returns it base64-encoded for the vision call. */
async function fetchPhoto(token: string, fileId: string): Promise<{ base64: string; mediaType: string }> {
  const file = await tg<{ file_path: string }>(token, 'getFile', { file_id: fileId });
  const res = await fetch(`${API}/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mediaType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { base64: buf.toString('base64'), mediaType };
}

export async function setWebhook(token: string, url: string, secret: string): Promise<void> {
  await tg(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

// ---------- replies ----------

const r1 = (v: number) => Math.round(v * 10) / 10;
const hhmm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, '0')}`;

/** "1500", or "1569 (1500 + 69 за активность)" when the ring earned a bonus. */
function budgetText(day: DaySummary): string {
  const b = day.budget;
  return b.extra > 0 ? `${b.adjusted} (${b.base} + ${b.extra} за активность)` : String(b.adjusted);
}

/**
 * What the wearables say about the day. The budget already reflects the
 * activity; this is so the number is not a figure out of nowhere.
 */
function metricsLine(day: DaySummary): string | null {
  const m = day.metrics;
  const parts: string[] = [];
  if (m.active_kcal != null) parts.push(`актив. ${Math.round(m.active_kcal)} ккал`);
  if (m.steps != null) parts.push(`${Math.round(m.steps)} шагов`);
  if (m.workout_min) parts.push(`трен. ${Math.round(m.workout_min)} мин`);
  if (m.sleep_min != null) parts.push(`сон ${hhmm(m.sleep_min)}`);
  if (m.readiness != null) parts.push(`готовность ${Math.round(m.readiness)}`);
  if (!parts.length) return null;
  return `💍 <i>${parts.join(' · ')}</i>`;
}

function dayLine(day: DaySummary): string {
  const r = day.remaining;
  const over = r.kcal < 0;
  const lines = [
    over
      ? `⚠️ <b>Перебор на ${Math.abs(r.kcal)} ккал</b> (бюджет ${budgetText(day)}, съедено ${day.consumed.kcal})`
      : `🔥 <b>Осталось ${r.kcal} ккал</b> из ${budgetText(day)} (съедено ${day.consumed.kcal})`,
    `🥩 ${r1(r.protein_g)} г белка · 🧈 ${r1(r.fat_g)} г жиров · 🍞 ${r1(r.carbs_g)} г углеводов`,
  ];
  const metrics = metricsLine(day);
  if (metrics) lines.push(metrics);
  return lines.join('\n');
}

function mealReply(est: MealEstimate, day: DaySummary, id: number): string {
  const lines = [
    `📝 Записала: <b>${est.description}</b>`,
    `${est.kcal} ккал · Б ${r1(est.protein_g)} · Ж ${r1(est.fat_g)} · У ${r1(est.carbs_g)}`,
  ];
  if (est.confidence === 'low') lines.push('🤔 <i>Оценка грубая — напиши состав или вес, уточню.</i>');
  if (est.note) lines.push(`<i>${est.note}</i>`);
  lines.push('', dayLine(day));
  lines.push(`<i>/undo — удалить (#${id})</i>`);
  return lines.join('\n');
}

const HELP = [
  'Что умею:',
  '📸 <b>фото еды</b> — оценю и запишу; подпись с деталями («без масла», «300 г») уточняет оценку',
  '✍️ <b>текстом</b>: «тарелка овсянки с бананом» — то же самое, без фото',
  '🔥 <b>«сколько осталось»</b> или /day — остаток на сегодня',
  '🍽 <b>«что съесть»</b> или /eat — что взять на оставшийся бюджет',
  '📊 <b>/week</b> — неделя и динамика веса',
  '⚖️ <b>«вес 81.4»</b> — записать взвешивание',
  '🗑 <b>/undo</b> — удалить последнюю запись',
].join('\n');

// ---------- routing ----------

const ASK_REMAINING = /(скольк|остал|остаток|бюджет|сегодня)/i;
// Asking for advice, not describing a meal: "что съесть", "посоветуй что-нибудь",
// "чем поужинать". Anchored on the question so "съел салат" still logs a salad.
const ASK_WHAT_TO_EAT =
  /(^|\s)(что|чего|чем)\s+(\S+\s+){0,2}(съесть|поесть|покушать|пожрать|заказать|приготовить|поужинать|пообедать|позавтракать)|посовету|что\s+(на|для)\s+(ужин|обед|завтрак)/i;
const WEIGHT = /^\s*(?:вес|weight)\s*[:=]?\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg)?\s*$/i;

export interface TelegramDeps {
  db: Queryable;
  token: string;
  anthropicKey: string | null;
}

/** Handles one update. Never throws: a failure is reported to the chat. */
export async function handleUpdate(deps: TelegramDeps, update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg || msg.chat.type !== 'private') return;
  const { db, token } = deps;
  const chatId = msg.chat.id;

  // Trust on first use: the first private chat to say /start owns the bot.
  const owner = await getSetting(db, 'telegram_chat_id');
  if (!owner) {
    if (!(msg.text ?? '').startsWith('/start')) return;
    await setSetting(db, 'telegram_chat_id', String(chatId));
    await send(token, chatId, `👋 Привет! Бот привязан к этому чату.\n\n${HELP}`);
    return;
  }
  if (String(chatId) !== owner) {
    await send(token, chatId, 'Этот бот личный и уже привязан к другому чату.');
    return;
  }

  try {
    await route(deps, msg, chatId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[telegram]', message);
    await send(token, chatId, `❌ Не получилось: ${message.slice(0, 300)}`);
  }
}

async function route(deps: TelegramDeps, msg: TgMessage, chatId: number): Promise<void> {
  const { db, token, anthropicKey } = deps;
  const text = (msg.text ?? '').trim();

  if (msg.photo?.length) {
    if (!anthropicKey) {
      await send(token, chatId, 'Фото пока не распознаю: на сервере не задан ключ Anthropic API.');
      return;
    }
    // The last entry is the largest rendition Telegram kept.
    const best = msg.photo[msg.photo.length - 1];
    await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    const image = await fetchPhoto(token, best.file_id);
    const est = await estimateFromPhoto(anthropicKey, image, msg.caption);
    const meal = await logMeal(db, { ...est, source: 'telegram' });
    await send(token, chatId, mealReply(est, await getDay(db), meal.id));
    return;
  }

  if (!text) return;

  if (text.startsWith('/start') || text.startsWith('/help')) {
    await send(token, chatId, HELP);
    return;
  }

  if (text.startsWith('/eat') || ASK_WHAT_TO_EAT.test(text)) {
    if (!anthropicKey) {
      await send(token, chatId, 'Совет не соберу: на сервере не задан ключ Anthropic API.');
      return;
    }
    await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    const day = await getDay(db);
    const advice = await suggestFood(anthropicKey, day, text.replace(/^\/eat\s*/i, ''));
    await send(token, chatId, `🍽 <b>На оставшийся бюджет</b>\n${advice}\n\n${dayLine(day)}`);
    return;
  }

  if (text.startsWith('/day') || ASK_REMAINING.test(text)) {
    const day = await getDay(db);
    const meals = day.meals.map(m => `• ${m.description} — ${m.kcal}`).join('\n');
    await send(token, chatId, meals ? `${dayLine(day)}\n\n${meals}` : dayLine(day));
    return;
  }

  if (text.startsWith('/week')) {
    const week = await getWeek(db);
    // Narrow enough for a phone: date, kcal, protein, steps in thousands,
    // readiness. Protein and readiness are the two that a kcal total hides.
    const rows = week.days
      .map(d => {
        const cells = [d.day.slice(5), d.meals ? `${d.consumed}/${d.budget}` : '—'];
        if (d.meals) cells.push(`Б${Math.round(d.protein_g)}`);
        if (d.steps != null) cells.push(`${r1(d.steps / 1000)}к`);
        if (d.readiness != null) cells.push(`R${Math.round(d.readiness)}`);
        return cells.join(' ');
      })
      .join('\n');
    const w = week.weight;
    const trend =
      w.avg7_now != null
        ? `\n\nВес: ${w.latest?.kg} кг, среднее за 7 дней ${w.avg7_now}${
            w.delta_week != null ? ` (${w.delta_week > 0 ? '+' : ''}${w.delta_week} за неделю)` : ''
          }`
        : '';
    await send(token, chatId, `📊 <b>Неделя</b>\n${rows}${trend}`);
    return;
  }

  if (text.startsWith('/undo')) {
    const meals = await listMeals(db, (await getDay(db)).day);
    const last = meals.at(-1);
    if (!last) {
      await send(token, chatId, 'Сегодня ещё ничего не записано.');
      return;
    }
    await deleteMeal(db, last.id);
    await send(token, chatId, `🗑 Удалила: ${last.description} (−${last.kcal} ккал)\n\n${dayLine(await getDay(db))}`);
    return;
  }

  const weight = WEIGHT.exec(text);
  if (weight) {
    const kg = Number(weight[1].replace(',', '.'));
    await logWeight(db, kg, new Date(), 'telegram');
    await send(token, chatId, `⚖️ Записала вес ${kg} кг.`);
    return;
  }

  if (!anthropicKey) {
    await send(token, chatId, 'Не задан ключ Anthropic API — оценивать еду пока нечем.');
    return;
  }
  await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  const est = await estimateFromText(anthropicKey, text);
  const meal = await logMeal(db, { ...est, source: 'telegram' });
  await send(token, chatId, mealReply(est, await getDay(db), meal.id));
}

export { EstimateError, SuggestError };
