import type { Pool } from 'pg';

import type { AiSettings } from './aiTypes.js';
import {
  generateHabitReminderMessages,
  generateSpontaneousPlan,
} from './geminiService.js';

type HabitRow = {
  id: string;
  name: string;
  frequency: string;
  notification_time: string | null;
  ai_personalized_reminders: boolean | null;
  ai_spontaneous_reminders: boolean | null;
};

type CheckRow = {
  habit_id: string;
  check_date: string;
  completed: boolean;
  updated_at: string | null;
};

export async function ensureHabitAiMessages(
  pool: Pool,
  userId: string,
  weekKey: string,
  aiSettings: AiSettings,
  firstName?: string | null
): Promise<Record<string, string>> {
  const existing = await pool.query<{ habit_id: string; message: string }>(
    `SELECT habit_id, message
     FROM habit_ai_messages
     WHERE user_id = $1 AND week_key = $2`,
    [userId, weekKey]
  );

  if (existing.rows.length > 0) {
    return Object.fromEntries(
      existing.rows.map((row) => [row.habit_id, row.message])
    );
  }

  if (!aiSettings.enabled) {
    return {};
  }

  const habitsResult = await pool.query<HabitRow>(
    `SELECT id, name, frequency, notification_time, ai_personalized_reminders, ai_spontaneous_reminders
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
    }));

  if (habits.length === 0) {
    return {};
  }

  const generated = await generateHabitReminderMessages({
    aiSettings,
    firstName,
    habits,
  });

  for (const [habitId, message] of Object.entries(generated)) {
    await pool.query(
      `INSERT INTO habit_ai_messages (id, user_id, habit_id, week_key, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, habit_id, week_key)
       DO UPDATE SET message = EXCLUDED.message, updated_at = NOW()`,
      [
        `ham_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        userId,
        habitId,
        weekKey,
        message,
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

export async function ensureSpontaneousPlan(
  pool: Pool,
  userId: string,
  weekKey: string,
  aiSettings: AiSettings,
  firstName?: string | null
): Promise<
  Array<{
    habitId: string;
    scheduledAt: string;
    title: string;
    message: string;
  }>
> {
  const existing = await pool.query<{
    habit_id: string;
    scheduled_at: string;
    title: string;
    message: string;
  }>(
    `SELECT habit_id, scheduled_at, title, message
     FROM spontaneous_notifications
     WHERE user_id = $1 AND week_key = $2
     ORDER BY scheduled_at ASC`,
    [userId, weekKey]
  );

  if (existing.rows.length > 0) {
    return existing.rows.map((row) => ({
      habitId: row.habit_id,
      scheduledAt: new Date(row.scheduled_at).toISOString(),
      title: row.title,
      message: row.message,
    }));
  }

  if (!aiSettings.enabled || !aiSettings.spontaneousEnabled) {
    return [];
  }

  const habitsResult = await pool.query<HabitRow>(
    `SELECT id, name, frequency, notification_time, ai_personalized_reminders, ai_spontaneous_reminders
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

  const habits = habitsResult.rows
    .filter((habit) => habit.ai_spontaneous_reminders !== false)
    .map((habit) => {
      const stats = computeHabitStats(checksResult.rows, habit.id);

      return {
        id: habit.id,
        name: habit.name,
        frequency: habit.frequency,
        notificationTime: habit.notification_time ?? '09:00',
        ...stats,
      };
    });

  if (habits.length === 0) {
    return [];
  }

  const generated = await generateSpontaneousPlan({
    aiSettings,
    firstName,
    weekKey,
    habits,
  });

  for (const entry of generated) {
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
  }

  return generated;
}
