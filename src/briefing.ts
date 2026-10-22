/**
 * The morning message: what the night was, what today allows, and how
 * yesterday actually ended.
 *
 * Written from the database alone — no model call. A briefing that arrives at
 * the same minute every morning should cost nothing and say the same kind of
 * thing each time, so it can be read in four seconds and skipped when it is
 * dull.
 */
import type { Queryable } from './db.js';
import { shiftDay, today } from './dates.js';
import { cycleStatus } from './cycle.js';
import { energyBalance } from './energy.js';
import { getDay, weightTrend } from './service.js';

const r1 = (v: number) => Math.round(v * 10) / 10;
const hhmm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, '0')}`;
const signed = (v: number) => (v > 0 ? `+${r1(v)}` : String(r1(v)));

export async function composeBriefing(db: Queryable, day: string = today()): Promise<string> {
  const yesterday = shiftDay(day, -1);
  const [t, y, trend, energy, cycle] = await Promise.all([
    getDay(db, day),
    getDay(db, yesterday),
    weightTrend(db, 28, day),
    energyBalance(db, 28, day),
    cycleStatus(db, day),
  ]);

  const lines: string[] = [`☀️ <b>${day}</b>`];

  // The night. Readiness and sleep are the two that change what today should
  // ask of her, so they lead.
  const m = t.metrics;
  const night: string[] = [];
  if (m.sleep_min != null) night.push(`сон ${hhmm(m.sleep_min)}`);
  if (m.readiness != null) night.push(`готовность ${Math.round(m.readiness)}`);
  if (m.resting_hr != null) night.push(`пульс покоя ${Math.round(m.resting_hr)}`);
  if (m.hrv != null) night.push(`HRV ${Math.round(m.hrv)}`);
  lines.push(night.length ? `😴 ${night.join(' · ')}` : '😴 Данных с кольца за ночь пока нет.');

  // Today's allowance. Yesterday's activity is what earned any bonus, and
  // today's is nearly zero at this hour, so say so rather than imply it.
  const b = t.budget;
  lines.push(
    b.extra > 0
      ? `🔥 Сегодня <b>${b.adjusted}</b> ккал (${b.base} + ${b.extra} за активность)`
      : `🔥 Сегодня <b>${b.adjusted}</b> ккал`,
  );
  lines.push(`🥩 ${Math.round(t.targets.protein_g)} г белка · 🧈 ${Math.round(t.targets.fat_g)} г жиров`);

  // Yesterday, stated plainly.
  if (y.consumed.meals) {
    const over = y.remaining.kcal < 0;
    lines.push(
      '',
      over
        ? `📉 Вчера: ${y.consumed.kcal} из ${y.budget.adjusted} — перебор на ${Math.abs(y.remaining.kcal)}`
        : `📉 Вчера: ${y.consumed.kcal} из ${y.budget.adjusted} — в бюджете`,
    );
    lines.push(`   белок ${Math.round(y.consumed.protein_g)} г из ${Math.round(y.targets.protein_g)}`);
  } else {
    lines.push('', '📉 Вчера ничего не записано.');
  }

  // Weight: the trend, never a single number — and in the luteal phase, with
  // the reason the number may be lying.
  lines.push(weightLine(trend));
  if (cycle.cycle_day != null) {
    const hedge = cycle.confidence === 'assumed' ? ', фаза предположительная' : '';
    lines.push(`🌙 Цикл: день ${cycle.cycle_day}, ${cycle.phase}${hedge}`);
    if (cycle.phase === 'лютеиновая') lines.push('   вес сейчас может держать 1–2 кг воды — это не жир');
  }

  // The measured expenditure, once there is enough of it to mean anything.
  if (energy.tdee != null) {
    lines.push(
      '',
      `📐 Измеренный расход ≈ <b>${energy.tdee}</b> ккал/день (${energy.confidence === 'high' ? 'уверенно' : 'предварительно'})`,
    );
    if (energy.suggested_budget != null && Math.abs(energy.suggested_budget - t.budget.base) >= 100) {
      lines.push(`   для −0.5 кг/нед бюджет был бы ${energy.suggested_budget}, сейчас ${t.budget.base}`);
    }
  }

  return lines.join('\n');
}

/** The weight line. A single weigh-in is water; the 7-day average is the claim. */
export function weightLine(trend: {
  latest: { kg: number; day: string } | null;
  avg7_now: number | null;
  delta_week: number | null;
}): string {
  if (!trend.latest) return '⚖️ Взвешиваний ещё нет — без них прогресс считать не из чего.';
  if (trend.avg7_now == null) {
    return `⚖️ ${trend.latest.kg} кг (${trend.latest.day}); для среднего за 7 дней нужно хотя бы три взвешивания`;
  }
  const delta = trend.delta_week != null ? ` (${signed(trend.delta_week)} за неделю)` : '';
  return `⚖️ ${trend.avg7_now} кг в среднем за 7 дней${delta}`;
}
