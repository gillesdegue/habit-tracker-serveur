import type { Pool } from 'pg';

import { generateWeeklyQuotes } from './geminiService.js';

const generationLocks = new Map<string, Promise<string[]>>();

export function getWeekKey(date: Date = new Date()): string {
  const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayIndex = (normalized.getDay() + 6) % 7;
  normalized.setDate(normalized.getDate() - dayIndex);

  const year = normalized.getFullYear();
  const month = `${normalized.getMonth() + 1}`.padStart(2, '0');
  const day = `${normalized.getDate()}`.padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function getDayIndexInWeek(date: Date = new Date()): number {
  return (date.getDay() + 6) % 7;
}

export type WeeklyQuoteRecord = {
  weekKey: string;
  dayOfWeek: number;
  quote: string;
};

function mapWeeklyQuoteRows(
  weekKey: string,
  rows: Array<{ day_of_week: number; quote: string }>
): WeeklyQuoteRecord[] {
  return rows.map((row) => ({
    weekKey,
    dayOfWeek: row.day_of_week,
    quote: row.quote,
  }));
}

async function loadWeeklyQuotes(
  pool: Pool,
  userId: string,
  weekKey: string
): Promise<WeeklyQuoteRecord[]> {
  const result = await pool.query<{ day_of_week: number; quote: string }>(
    `SELECT day_of_week, quote
     FROM weekly_quotes
     WHERE user_id = $1 AND week_key = $2
     ORDER BY day_of_week ASC`,
    [userId, weekKey]
  );

  return mapWeeklyQuoteRows(weekKey, result.rows);
}

async function persistWeeklyQuotes(
  pool: Pool,
  userId: string,
  weekKey: string,
  quotes: string[]
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM weekly_quotes WHERE user_id = $1 AND week_key = $2',
      [userId, weekKey]
    );

    for (let dayOfWeek = 0; dayOfWeek < quotes.length; dayOfWeek += 1) {
      await client.query(
        `INSERT INTO weekly_quotes (id, user_id, week_key, day_of_week, quote)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `quote_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          userId,
          weekKey,
          dayOfWeek,
          quotes[dayOfWeek],
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function generateAndStoreWeeklyQuotes(
  pool: Pool,
  userId: string,
  weekKey: string,
  firstName?: string | null,
  aiSettings?: import('./aiTypes.js').AiSettings
): Promise<string[]> {
  const lockKey = `${userId}:${weekKey}`;
  const existingLock = generationLocks.get(lockKey);

  if (existingLock) {
    return existingLock;
  }

  const generationPromise = (async () => {
    const { getUserAiSettings } = await import('./aiSettingsService.js');
    const settings =
      aiSettings ?? (await getUserAiSettings(pool, userId));
    const quotes = await generateWeeklyQuotes({
      aiSettings: settings,
      firstName,
    });
    await persistWeeklyQuotes(pool, userId, weekKey, quotes);
    return quotes;
  })();

  generationLocks.set(lockKey, generationPromise);

  try {
    return await generationPromise;
  } finally {
    generationLocks.delete(lockKey);
  }
}

export async function ensureWeeklyQuotesForUser(
  pool: Pool,
  userId: string,
  firstName?: string | null,
  referenceDate: Date = new Date()
): Promise<WeeklyQuoteRecord[]> {
  const weekKey = getWeekKey(referenceDate);
  const existingQuotes = await loadWeeklyQuotes(pool, userId, weekKey);

  if (existingQuotes.length >= 7) {
    return existingQuotes;
  }

  await generateAndStoreWeeklyQuotes(pool, userId, weekKey, firstName);

  return loadWeeklyQuotes(pool, userId, weekKey);
}
