import { getDb } from './connection.js';

export interface DailyBudgetRow {
  id: number;
  window_start: number;
  tokens_consumed: number;
}

export function getDailyBudget(): DailyBudgetRow {
  const db = getDb();
  const row = db.prepare('SELECT * FROM daily_budget WHERE id = 1').get() as DailyBudgetRow | undefined;
  if (!row) {
    // Initialize if missing
    const now = Date.now();
    db.prepare('INSERT OR IGNORE INTO daily_budget (id, window_start, tokens_consumed) VALUES (1, ?, 0)')
      .run(now);
    return { id: 1, window_start: now, tokens_consumed: 0 };
  }
  return row;
}

export function resetDailyBudget(windowStart: number): void {
  const db = getDb();
  db.prepare('UPDATE daily_budget SET window_start = ?, tokens_consumed = 0 WHERE id = 1')
    .run(windowStart);
}

export function incrementDailyTokens(tokens: number): void {
  const db = getDb();
  db.prepare('UPDATE daily_budget SET tokens_consumed = tokens_consumed + ? WHERE id = 1')
    .run(tokens);
}
