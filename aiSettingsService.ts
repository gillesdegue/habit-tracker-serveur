import type { Pool } from 'pg';

import {
  DEFAULT_AI_SETTINGS,
  type AiSettings,
  type AiTone,
} from './aiTypes.js';

type UserAiRow = {
  ai_enabled: boolean | null;
  ai_tone: string | null;
  ai_intensity: number | null;
  ai_spontaneous_enabled: boolean | null;
};

function normalizeTone(value: string | null | undefined): AiTone {
  if (
    value === 'gentle' ||
    value === 'motivating' ||
    value === 'direct' ||
    value === 'sarcastic' ||
    value === 'strict'
  ) {
    return value;
  }

  return DEFAULT_AI_SETTINGS.tone;
}

function clampIntensity(value: number | null | undefined): number {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_AI_SETTINGS.intensity;
  }

  return Math.min(5, Math.max(1, Math.round(value)));
}

export function mapAiSettings(row?: UserAiRow | null): AiSettings {
  if (!row) {
    return { ...DEFAULT_AI_SETTINGS };
  }

  return {
    enabled: Boolean(row.ai_enabled),
    tone: normalizeTone(row.ai_tone),
    intensity: clampIntensity(row.ai_intensity),
    spontaneousEnabled: Boolean(row.ai_spontaneous_enabled),
  };
}

export async function getUserAiSettings(
  pool: Pool,
  userId: string
): Promise<AiSettings> {
  const result = await pool.query<UserAiRow>(
    `SELECT ai_enabled, ai_tone, ai_intensity, ai_spontaneous_enabled
     FROM users WHERE id = $1`,
    [userId]
  );

  return mapAiSettings(result.rows[0]);
}

export async function updateUserAiSettings(
  pool: Pool,
  userId: string,
  settings: Partial<AiSettings>
): Promise<AiSettings> {
  const current = await getUserAiSettings(pool, userId);
  const next: AiSettings = {
    enabled: settings.enabled ?? current.enabled,
    tone: settings.tone ?? current.tone,
    intensity: clampIntensity(settings.intensity ?? current.intensity),
    spontaneousEnabled:
      settings.spontaneousEnabled ?? current.spontaneousEnabled,
  };

  await pool.query(
    `UPDATE users
     SET ai_enabled = $1,
         ai_tone = $2,
         ai_intensity = $3,
         ai_spontaneous_enabled = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [
      next.enabled,
      next.tone,
      next.intensity,
      next.spontaneousEnabled,
      userId,
    ]
  );

  return next;
}

export async function invalidateUserAiContent(
  pool: Pool,
  userId: string,
  weekKey: string
): Promise<void> {
  await pool.query(
    'DELETE FROM weekly_quotes WHERE user_id = $1 AND week_key = $2',
    [userId, weekKey]
  );
  await pool.query(
    'DELETE FROM habit_ai_messages WHERE user_id = $1 AND week_key = $2',
    [userId, weekKey]
  );
  await pool.query(
    'DELETE FROM spontaneous_notifications WHERE user_id = $1 AND week_key = $2',
    [userId, weekKey]
  );
}
