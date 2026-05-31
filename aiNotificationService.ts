import type { Pool } from 'pg';

import type { AiSettings } from './aiTypes.js';
import {
  generateHabitReminderMessages,
  generateSpontaneousPlan,
} from './geminiService.js';
import { extraNotificationsPerDay, requiredPersonalizedVariants } from './habitAiFrequency.js';

type HabitRow = {
  id: string;
  name: string;
  frequency: string;
  notification_time: string | null;
  ai_personalized_reminders: boolean | null;
  ai_spontaneous_reminders: boolean | null;
  ai_reminder_frequency: number | null;
};

type CheckRow = {
  habit_id: string;
  check_date: string;
  completed: boolean;
  updated_at: string | null;
};

type SpontaneousRow = {
  id: string;
  habit_id: string;
  scheduled_at: string;
  title: string;
  message: string;
};

type SpontaneousEntry = {
  habitId: string;
  scheduledAt: string;
  title: string;
  message: string;
};

function normalizeAiReminderFrequency(value: unknown): number {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(10, Math.max(0, Math.round(parsed)));
}

function dayKeyFromTimestamp(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function mapSpontaneousRow(row: SpontaneousRow): SpontaneousEntry {
  return {
    habitId: row.habit_id,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    title: row.title,
    message: row.message,
  };
}

function parseStoredHabitVariants(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0);
    }
  } catch {
    // Legacy single-message row.
  }

  const trimmed = raw.trim();

  return trimmed ? [trimmed] : [];
}

function serializeHabitVariants(variants: string[]): string {
  return JSON.stringify(variants);
}

export async function ensureHabitAiMessages(
  pool: Pool,
  userId: string,
  weekKey: string,
  aiSettings: AiSettings,
  firstName?: string | null
): Promise<Record<string, string[]>> {
  if (!aiSettings.enabled) {
    return {};
  }

  const habitsResult = await pool.query<HabitRow>(
    `SELECT id, name, frequency, notification_time, ai_personalized_reminders, ai_spontaneous_reminders, ai_reminder_frequency
     FROM habits
     WHERE user_id = $1`,
    [userId]
  );

  const habits = habitsResult.rows
    .filter((habit) => habit.ai_personalized_reminders !== false)
    .map((habit) => ({
      id: habit.id,
      name: habit.name,
      frequency: habit.frequency,
      notificationTime: habit.notification_time ?? '09:00',
      aiReminderFrequency: normalizeAiReminderFrequency(
        habit.ai_reminder_frequency
      ),
    }));

  if (habits.length === 0) {
    return {};
  }

  const requiredByHabit = new Map(
    habits.map((habit) => [
      habit.id,
      requiredPersonalizedVariants(habit.aiReminderFrequency),
    ])
  );

  const existing = await pool.query<{ habit_id: string; message: string }>(
    `SELECT habit_id, message
     FROM habit_ai_messages
     WHERE user_id = $1 AND week_key = $2`,
    [userId, weekKey]
  );

  if (existing.rows.length > 0) {
    const parsed = Object.fromEntries(
      existing.rows.map((row) => [
        row.habit_id,
        parseStoredHabitVariants(row.message),
      ])
    ) as Record<string, string[]>;

    const allSufficient = habits.every((habit) => {
      const required = requiredByHabit.get(habit.id) ?? 1;
      const variants = parsed[habit.id] ?? [];

      return variants.length >= required;
    });

    if (allSufficient) {
      return parsed;
    }
  }

  const generated = await generateHabitReminderMessages({
    aiSettings,
    firstName,
    habits,
  });

  for (const habit of habits) {
    const variants = generated[habit.id] ?? [];

    if (variants.length === 0) {
      continue;
    }

    await pool.query(
      `INSERT INTO habit_ai_messages (id, user_id, habit_id, week_key, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, habit_id, week_key)
       DO UPDATE SET message = EXCLUDED.message, updated_at = NOW()`,
      [
        `ham_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        userId,
        habit.id,
        weekKey,
        serializeHabitVariants(variants),
      ]
    );
  }

  return generated;
}

function computeHabitStats(
  checks: CheckRow[],
  habitId: string
): {
  completionRate14d: number;
  missedDays14d: number;
  usuallyCompletesMorning: boolean;
} {
  const habitChecks = checks.filter((check) => check.habit_id === habitId);

  if (habitChecks.length === 0) {
    return {
      completionRate14d: 0,
      missedDays14d: 14,
      usuallyCompletesMorning: true,
    };
  }

  const completed = habitChecks.filter((check) => check.completed);
  const morningCompleted = completed.filter((check) => {
    const hour = check.updated_at
      ? new Date(check.updated_at).getHours()
      : 12;
    return hour < 12;
  });

  return {
    completionRate14d: completed.length / 14,
    missedDays14d: 14 - completed.length,
    usuallyCompletesMorning:
      morningCompleted.length >= Math.ceil(completed.length / 2),
  };
}

function buildEligibleHabits(
  habitRows: HabitRow[],
  checks: CheckRow[]
): Array<{
  id: string;
  name: string;
  frequency: string;
  notificationTime: string;
  aiReminderFrequency: number;
  completionRate14d: number;
  missedDays14d: number;
  usuallyCompletesMorning: boolean;
}> {
  return habitRows
    .filter(
      (habit) =>
        habit.ai_personalized_reminders === false &&
        habit.ai_spontaneous_reminders !== false
    )
    .map((habit) => {
      const stats = computeHabitStats(checks, habit.id);

      return {
        id: habit.id,
        name: habit.name,
        frequency: habit.frequency,
        notificationTime: habit.notification_time ?? '09:00',
        aiReminderFrequency: normalizeAiReminderFrequency(
          habit.ai_reminder_frequency
        ),
        ...stats,
      };
    })
    .filter(
      (habit) => extraNotificationsPerDay(habit.aiReminderFrequency) > 0
    );
}

async function trimExistingSpontaneousToFrequencyCaps(
  pool: Pool,
  userId: string,
  weekKey: string,
  habitRows: HabitRow[],
  existingRows: SpontaneousRow[]
): Promise<SpontaneousEntry[]> {
  const maxPerDayByHabit = new Map<string, number>();

  for (const habit of habitRows) {
    const personalized = habit.ai_personalized_reminders !== false;
    const spontaneous = habit.ai_spontaneous_reminders !== false;
    const frequency = normalizeAiReminderFrequency(habit.ai_reminder_frequency);

    maxPerDayByHabit.set(
      habit.id,
      !personalized && spontaneous
        ? extraNotificationsPerDay(frequency)
        : 0
    );
  }

  const grouped = new Map<string, SpontaneousRow[]>();

  for (const row of existingRows) {
    const groupKey = `${row.habit_id}:${dayKeyFromTimestamp(row.scheduled_at)}`;
    const list = grouped.get(groupKey) ?? [];
    list.push(row);
    grouped.set(groupKey, list);
  }

  const kept: SpontaneousEntry[] = [];
  const deleteIds: string[] = [];

  for (const [groupKey, rows] of grouped.entries()) {
    const habitId = groupKey.split(':')[0] ?? '';
    const maxAllowed = maxPerDayByHabit.get(habitId) ?? 0;
    const sortedRows = [...rows].sort(
      (left, right) =>
        new Date(left.scheduled_at).getTime() -
        new Date(right.scheduled_at).getTime()
    );

    if (maxAllowed <= 0) {
      deleteIds.push(...sortedRows.map((row) => row.id));
      continue;
    }

    sortedRows.forEach((row, index) => {
      if (index < maxAllowed) {
        kept.push(mapSpontaneousRow(row));
      } else {
        deleteIds.push(row.id);
      }
    });
  }

  if (deleteIds.length > 0) {
    await pool.query(
      `DELETE FROM spontaneous_notifications
       WHERE user_id = $1 AND week_key = $2 AND id = ANY($3::text[])`,
      [userId, weekKey, deleteIds]
    );
  }

  return kept.sort(
    (left, right) =>
      new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime()
  );
}

export async function ensureSpontaneousPlan(
  pool: Pool,
  userId: string,
  weekKey: string,
  aiSettings: AiSettings,
  firstName?: string | null
): Promise<SpontaneousEntry[]> {
  if (!aiSettings.enabled || !aiSettings.spontaneousEnabled) {
    return [];
  }

  const habitsResult = await pool.query<HabitRow>(
    `SELECT id, name, frequency, notification_time, ai_personalized_reminders, ai_spontaneous_reminders, ai_reminder_frequency
     FROM habits
     WHERE user_id = $1`,
    [userId]
  );

  const checksResult = await pool.query<CheckRow>(
    `SELECT dc.habit_id, dc.date_key AS check_date, dc.completed, dc.updated_at
     FROM daily_checks dc
     INNER JOIN habits h ON h.id = dc.habit_id
     WHERE h.user_id = $1
       AND dc.date_key >= to_char(CURRENT_DATE - INTERVAL '14 days', 'YYYY-MM-DD')`,
    [userId]
  );

  const eligibleHabits = buildEligibleHabits(
    habitsResult.rows,
    checksResult.rows
  );

  const existing = await pool.query<SpontaneousRow>(
    `SELECT id, habit_id, scheduled_at, title, message
     FROM spontaneous_notifications
     WHERE user_id = $1 AND week_key = $2
     ORDER BY scheduled_at ASC`,
    [userId, weekKey]
  );

  const keptEntries = await trimExistingSpontaneousToFrequencyCaps(
    pool,
    userId,
    weekKey,
    habitsResult.rows,
    existing.rows
  );

  const keptCountByHabitDay = new Map<string, number>();

  for (const entry of keptEntries) {
    const key = `${entry.habitId}:${entry.scheduledAt.slice(0, 10)}`;
    keptCountByHabitDay.set(key, (keptCountByHabitDay.get(key) ?? 0) + 1);
  }

  const habitsNeedingGeneration = eligibleHabits.filter((habit) => {
    const keptForHabit = keptEntries.filter((entry) => entry.habitId === habit.id);

    return keptForHabit.length === 0;
  });

  if (habitsNeedingGeneration.length === 0) {
    return keptEntries;
  }

  const generated = await generateSpontaneousPlan({
    aiSettings,
    firstName,
    weekKey,
    habits: habitsNeedingGeneration,
  });

  const inserted: SpontaneousEntry[] = [];

  for (const entry of generated) {
    const dayKey = entry.scheduledAt.slice(0, 10);
    const countKey = `${entry.habitId}:${dayKey}`;
    const maxAllowed = extraNotificationsPerDay(
      eligibleHabits.find((habit) => habit.id === entry.habitId)
        ?.aiReminderFrequency ?? 0
    );
    const currentCount =
      (keptCountByHabitDay.get(countKey) ?? 0) +
      inserted.filter(
        (item) =>
          item.habitId === entry.habitId &&
          item.scheduledAt.slice(0, 10) === dayKey
      ).length;

    if (currentCount >= maxAllowed) {
      continue;
    }

    await pool.query(
      `INSERT INTO spontaneous_notifications
       (id, user_id, habit_id, week_key, scheduled_at, title, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        `spn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        userId,
        entry.habitId,
        weekKey,
        entry.scheduledAt,
        entry.title,
        entry.message,
      ]
    );

    inserted.push(entry);
    keptCountByHabitDay.set(countKey, currentCount + 1);
  }

  return [...keptEntries, ...inserted].sort(
    (left, right) =>
      new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime()
  );
}
