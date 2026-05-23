import bcrypt from 'bcryptjs';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

import { isMailConfigured } from './mailConfig.js';
import { sendPasswordResetEmail } from './mailService.js';
import {
  ensureHabitAiMessages,
  ensureSpontaneousPlan,
} from './aiNotificationService.js';
import {
  getUserAiSettings,
  invalidateUserAiContent,
  updateUserAiSettings,
} from './aiSettingsService.js';
import type { AiTone } from './aiTypes.js';
import { getWeekKey } from './quotesService.js';
import { ensureWeeklyQuotesForUser } from './quotesService.js';

dotenv.config();

const { Pool } = pkg;

const app = express();
const PORT = parseInt(process.env.PORT || '3010', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'habit-tracker-dev-secret';
const JWT_EXPIRES_IN = '30d';
const PASSWORD_RESET_EXPIRES_MS = 60 * 60 * 1000;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'habit-tracker-postgres',
  user: process.env.POSTGRES_USER || 'habit_tracker',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'habit_tracker',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  connectionTimeoutMillis: 10000,
});

type AuthPayload = {
  userId: string;
  email: string;
};

type AuthenticatedRequest = Request & {
  auth?: AuthPayload;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isStrongPassword(password: string): boolean {
  return (
    password.trim().length >= 8 &&
    /[a-zA-Z]/.test(password) &&
    /\d/.test(password)
  );
}

function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant.' });
    return;
  }

  const token = header.slice('Bearer '.length);
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: 'Token invalide ou expire.' });
    return;
  }

  req.auth = payload;
  next();
}

async function initDb(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS habits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        frequency TEXT NOT NULL,
        notification_time TEXT NOT NULL,
        deadline TIMESTAMPTZ,
        color TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS daily_checks (
        id TEXT PRIMARY KEY,
        habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        date_key TEXT NOT NULL,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(habit_id, date_key)
      );

      CREATE INDEX IF NOT EXISTS idx_habits_user_id ON habits(user_id);
      CREATE INDEX IF NOT EXISTS idx_daily_checks_habit_date ON daily_checks(habit_id, date_key);

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
        ON password_reset_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
        ON password_reset_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS weekly_quotes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        week_key TEXT NOT NULL,
        day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
        quote TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, week_key, day_of_week)
      );

      CREATE INDEX IF NOT EXISTS idx_weekly_quotes_user_week
        ON weekly_quotes(user_id, week_key);
    `);

    await client.query(`
      ALTER TABLE habits ADD COLUMN IF NOT EXISTS schedule_days TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_tone TEXT NOT NULL DEFAULT 'motivating';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_intensity INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_spontaneous_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE habits ADD COLUMN IF NOT EXISTS ai_personalized_reminders BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE habits ADD COLUMN IF NOT EXISTS ai_spontaneous_reminders BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS habit_ai_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        week_key TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, habit_id, week_key)
      );

      CREATE TABLE IF NOT EXISTS spontaneous_notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        week_key TEXT NOT NULL,
        scheduled_at TIMESTAMPTZ NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, habit_id, week_key, scheduled_at)
      );

      CREATE INDEX IF NOT EXISTS idx_habit_ai_messages_user_week
        ON habit_ai_messages(user_id, week_key);
      CREATE INDEX IF NOT EXISTS idx_spontaneous_notifications_user_week
        ON spontaneous_notifications(user_id, week_key);
    `);

    console.log('[DB] Schema habit_tracker pret.');
  } finally {
    client.release();
  }
}

async function findUserByEmail(email: string) {
  const result = await pool.query(
    `SELECT id, email, password_hash, first_name, last_name, created_at, updated_at
     FROM users WHERE email = $1`,
    [normalizeEmail(email)]
  );

  return result.rows[0] ?? null;
}

async function findUserById(userId: string) {
  const result = await pool.query(
    `SELECT id, email, first_name, last_name, created_at, updated_at
     FROM users WHERE id = $1`,
    [userId]
  );

  return result.rows[0] ?? null;
}

function mapUser(row: {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string | Date;
}) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapHabit(row: {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  frequency: string;
  schedule_days: string | null;
  notification_time: string;
  deadline: string | Date | null;
  color: string;
  created_at: string | Date;
  ai_personalized_reminders?: boolean | null;
  ai_spontaneous_reminders?: boolean | null;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description ?? undefined,
    frequency: row.frequency,
    scheduleDays: row.schedule_days ?? '[]',
    notificationTime: row.notification_time,
    deadline: row.deadline ? new Date(row.deadline).toISOString() : undefined,
    color: row.color,
    createdAt: new Date(row.created_at).toISOString(),
    aiPersonalizedReminders: row.ai_personalized_reminders !== false,
    aiSpontaneousReminders: row.ai_spontaneous_reminders !== false,
  };
}

function mapDailyCheck(row: {
  id: string;
  habit_id: string;
  date_key: string;
  completed: boolean;
}) {
  return {
    id: row.id,
    habitId: row.habit_id,
    date: row.date_key,
    completed: Boolean(row.completed),
  };
}

async function startServer(): Promise<void> {
  app.use(
    cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'habit-tracker-api' });
  });

  app.get('/api/auth/exists', async (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email : '';

    if (!email) {
      res.status(400).json({ error: 'Email requis.' });
      return;
    }

    try {
      const user = await findUserByEmail(email);
      res.json({ exists: Boolean(user) });
    } catch (error) {
      console.error('[AUTH] exists', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    const { email, password, firstName, lastName, id } = req.body ?? {};

    if (!email || !password) {
      res.status(400).json({ error: 'Email et mot de passe requis.' });
      return;
    }

    try {
      const normalizedEmail = normalizeEmail(email);
      const existing = await findUserByEmail(normalizedEmail);

      if (existing) {
        res.status(400).json({ error: 'Un compte existe deja avec cet email.' });
        return;
      }

      const userId = typeof id === 'string' && id.trim() ? id.trim() : createId('user');
      const passwordHash = await bcrypt.hash(password, 10);

      const inserted = await pool.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, first_name, last_name, created_at`,
        [
          userId,
          normalizedEmail,
          passwordHash,
          firstName?.trim() || null,
          lastName?.trim() || null,
        ]
      );

      const user = mapUser(inserted.rows[0]);
      const token = signToken({ userId: user.id, email: user.email });

      res.status(201).json({ user, token });
    } catch (error: unknown) {
      console.error('[AUTH] register', error);
      res.status(500).json({ error: 'Erreur lors de l inscription.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      res.status(400).json({ error: 'Email et mot de passe requis.' });
      return;
    }

    try {
      const user = await findUserByEmail(email);

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        res.status(401).json({ error: 'Identifiants incorrects.' });
        return;
      }

      const mappedUser = mapUser(user);
      const token = signToken({ userId: mappedUser.id, email: mappedUser.email });

      res.json({ user: mappedUser, token });
    } catch (error) {
      console.error('[AUTH] login', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body ?? {};

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email requis.' });
      return;
    }

    if (!isMailConfigured()) {
      res.status(503).json({ error: 'Service email indisponible.' });
      return;
    }

    const normalizedEmail = normalizeEmail(email);

    try {
      const user = await findUserByEmail(normalizedEmail);

      if (user) {
        const resetToken = createResetToken();
        const tokenHash = hashResetToken(resetToken);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_MS);

        await pool.query(
          `UPDATE password_reset_tokens
           SET used_at = NOW()
           WHERE user_id = $1 AND used_at IS NULL`,
          [user.id]
        );

        await pool.query(
          `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [createId('reset'), user.id, tokenHash, expiresAt]
        );

        try {
          await sendPasswordResetEmail(
            normalizedEmail,
            resetToken,
            user.first_name
          );
        } catch (mailError) {
          console.error('[AUTH] forgot-password mail', mailError);
          res.status(500).json({ error: 'Impossible d envoyer l email.' });
          return;
        }
      }

      res.json({
        sent: Boolean(user),
        message:
          'Si votre email est enregistre, un lien de reinitialisation vient de vous etre envoye.',
      });
    } catch (error) {
      console.error('[AUTH] forgot-password', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.get('/api/auth/reset-password/validate', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';

    if (!token) {
      res.status(400).json({ valid: false, error: 'Token requis.' });
      return;
    }

    try {
      const tokenHash = hashResetToken(token);
      const result = await pool.query(
        `SELECT id FROM password_reset_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [tokenHash]
      );

      res.json({ valid: result.rows.length > 0 });
    } catch (error) {
      console.error('[AUTH] reset-password validate', error);
      res.status(500).json({ valid: false, error: 'Erreur serveur.' });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const { token, password } = req.body ?? {};

    if (!token || !password) {
      res.status(400).json({ error: 'Token et mot de passe requis.' });
      return;
    }

    if (!isStrongPassword(String(password))) {
      res.status(400).json({
        error:
          'Le mot de passe doit contenir au moins 8 caracteres, dont une lettre et un chiffre.',
      });
      return;
    }

    try {
      const tokenHash = hashResetToken(String(token));
      const resetResult = await pool.query(
        `SELECT id, user_id
         FROM password_reset_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [tokenHash]
      );

      if (resetResult.rows.length === 0) {
        res.status(400).json({ error: 'Lien invalide ou expire.' });
        return;
      }

      const resetRow = resetResult.rows[0];
      const passwordHash = await bcrypt.hash(String(password), 10);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [passwordHash, resetRow.user_id]
        );
        await client.query(
          'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
          [resetRow.id]
        );
        await client.query('COMMIT');
      } catch (transactionError) {
        await client.query('ROLLBACK');
        throw transactionError;
      } finally {
        client.release();
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[AUTH] reset-password', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.get('/api/auth/me', authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await findUserById(req.auth!.userId);

      if (!user) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }

      res.json({ user: mapUser(user) });
    } catch (error) {
      console.error('[AUTH] me', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.get('/api/quotes/weekly', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth!.userId;

    try {
      const user = await findUserById(userId);

      if (!user) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }

      const aiSettings = await getUserAiSettings(pool, userId);
      const quotes = await ensureWeeklyQuotesForUser(
        pool,
        userId,
        user.first_name
      );

      res.json({
        weekKey: quotes[0]?.weekKey ?? null,
        quotes: quotes.map((entry) => ({
          dayOfWeek: entry.dayOfWeek,
          quote: entry.quote,
        })),
        aiSettings,
      });
    } catch (error) {
      console.error('[QUOTES] weekly', error);
      res.status(500).json({ error: 'Erreur lors de la generation des citations.' });
    }
  });

  app.get('/api/ai/settings', authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const settings = await getUserAiSettings(pool, req.auth!.userId);
      res.json({ settings });
    } catch (error) {
      console.error('[AI] settings get', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.put('/api/ai/settings', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth!.userId;
    const { enabled, tone, intensity, spontaneousEnabled } = req.body ?? {};
    const validTones: AiTone[] = [
      'gentle',
      'motivating',
      'direct',
      'sarcastic',
      'strict',
    ];

    try {
      const previous = await getUserAiSettings(pool, userId);
      const settings = await updateUserAiSettings(pool, userId, {
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        tone:
          typeof tone === 'string' &&
          validTones.includes(tone as AiTone)
            ? (tone as AiTone)
            : undefined,
        intensity: typeof intensity === 'number' ? intensity : undefined,
        spontaneousEnabled:
          typeof spontaneousEnabled === 'boolean'
            ? spontaneousEnabled
            : undefined,
      });

      const settingsChanged =
        previous.enabled !== settings.enabled ||
        previous.tone !== settings.tone ||
        previous.intensity !== settings.intensity ||
        previous.spontaneousEnabled !== settings.spontaneousEnabled;

      if (settingsChanged) {
        const weekKey = getWeekKey();
        await invalidateUserAiContent(pool, userId, weekKey);
      }

      res.json({ settings, invalidated: settingsChanged });
    } catch (error) {
      console.error('[AI] settings update', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.get('/api/ai/habit-messages', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth!.userId;

    try {
      const user = await findUserById(userId);

      if (!user) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }

      const aiSettings = await getUserAiSettings(pool, userId);
      const weekKey = getWeekKey();
      const messages = await ensureHabitAiMessages(
        pool,
        userId,
        weekKey,
        aiSettings,
        user.first_name
      );

      res.json({ weekKey, messages });
    } catch (error) {
      console.error('[AI] habit messages', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.get('/api/ai/spontaneous-plan', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth!.userId;

    try {
      const user = await findUserById(userId);

      if (!user) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }

      const aiSettings = await getUserAiSettings(pool, userId);
      const weekKey = getWeekKey();
      const notifications = await ensureSpontaneousPlan(
        pool,
        userId,
        weekKey,
        aiSettings,
        user.first_name
      );

      res.json({ weekKey, notifications });
    } catch (error) {
      console.error('[AI] spontaneous plan', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.put('/api/users/:id', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const { email, firstName, lastName } = req.body ?? {};

    if (req.auth!.userId !== id) {
      res.status(403).json({ error: 'Acces refuse.' });
      return;
    }

    try {
      const normalizedEmail = normalizeEmail(email);
      const conflict = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id <> $2',
        [normalizedEmail, id]
      );

      if (conflict.rows.length > 0) {
        res.status(400).json({ error: 'Un compte existe deja avec cet email.' });
        return;
      }

      const updated = await pool.query(
        `UPDATE users
         SET email = $1, first_name = $2, last_name = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING id, email, first_name, last_name, created_at`,
        [normalizedEmail, firstName?.trim() || null, lastName?.trim() || null, id]
      );

      res.json({ user: mapUser(updated.rows[0]) });
    } catch (error) {
      console.error('[USERS] update', error);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.put(
    '/api/users/:id/password',
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
      const { id } = req.params;
      const { currentPassword, nextPassword } = req.body ?? {};

      if (req.auth!.userId !== id) {
        res.status(403).json({ error: 'Acces refuse.' });
        return;
      }

      try {
        const user = await pool.query(
          'SELECT password_hash FROM users WHERE id = $1',
          [id]
        );

        if (user.rows.length === 0) {
          res.status(404).json({ error: 'Utilisateur introuvable.' });
          return;
        }

        const matches = await bcrypt.compare(
          currentPassword,
          user.rows[0].password_hash
        );

        if (!matches) {
          res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
          return;
        }

        const passwordHash = await bcrypt.hash(nextPassword, 10);
        await pool.query(
          'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [passwordHash, id]
        );

        res.json({ success: true });
      } catch (error) {
        console.error('[USERS] password', error);
        res.status(500).json({ error: 'Erreur serveur.' });
      }
    }
  );

  app.get('/api/sync', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth!.userId;

    try {
      const [userResult, habitsResult, checksResult] = await Promise.all([
        pool.query(
          `SELECT id, email, first_name, last_name, created_at
           FROM users WHERE id = $1`,
          [userId]
        ),
        pool.query(
          `SELECT id, user_id, name, description, frequency, schedule_days, notification_time, deadline, color, created_at, ai_personalized_reminders, ai_spontaneous_reminders
           FROM habits WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT dc.id, dc.habit_id, dc.date_key, dc.completed
           FROM daily_checks dc
           INNER JOIN habits h ON h.id = dc.habit_id
           WHERE h.user_id = $1
           ORDER BY dc.date_key ASC`,
          [userId]
        ),
      ]);

      if (userResult.rows.length === 0) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }

      res.json({
        user: mapUser(userResult.rows[0]),
        habits: habitsResult.rows.map(mapHabit),
        dailyChecks: checksResult.rows.map(mapDailyCheck),
        syncedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[SYNC] pull', error);
      res.status(500).json({ error: 'Erreur lors de la synchronisation.' });
    }
  });

  app.post('/api/sync', authMiddleware, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth!.userId;
    const { habits = [], dailyChecks = [], deletedHabitIds = [] } = req.body ?? {};
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const habitId of deletedHabitIds as string[]) {
        await client.query(
          'DELETE FROM habits WHERE id = $1 AND user_id = $2',
          [habitId, userId]
        );
      }

      for (const habit of habits as Array<Record<string, unknown>>) {
        if (!habit?.id || habit.userId !== userId) {
          continue;
        }

        const oldHabitResult = await client.query(
          'SELECT name, frequency, notification_time FROM habits WHERE id = $1 AND user_id = $2',
          [habit.id, userId]
        );
        const oldHabit = oldHabitResult.rows[0];

        await client.query(
          `INSERT INTO habits (id, user_id, name, description, frequency, schedule_days, notification_time, deadline, color, ai_personalized_reminders, ai_spontaneous_reminders, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             frequency = EXCLUDED.frequency,
             schedule_days = EXCLUDED.schedule_days,
             notification_time = EXCLUDED.notification_time,
             deadline = EXCLUDED.deadline,
             color = EXCLUDED.color,
             ai_personalized_reminders = EXCLUDED.ai_personalized_reminders,
             ai_spontaneous_reminders = EXCLUDED.ai_spontaneous_reminders,
             updated_at = NOW()`,
          [
            habit.id,
            userId,
            habit.name,
            habit.description ?? null,
            habit.frequency,
            JSON.stringify(
              Array.isArray(habit.scheduleDays) ? habit.scheduleDays : []
            ),
            habit.notificationTime,
            habit.deadline ? new Date(String(habit.deadline)) : null,
            habit.color,
            habit.aiPersonalizedReminders !== false,
            habit.aiSpontaneousReminders !== false,
            habit.createdAt ? new Date(String(habit.createdAt)) : new Date(),
          ]
        );

        if (
          oldHabit &&
          (oldHabit.name !== habit.name ||
            oldHabit.frequency !== habit.frequency ||
            oldHabit.notification_time !== habit.notificationTime)
        ) {
          await client.query(
            'DELETE FROM habit_ai_messages WHERE habit_id = $1 AND user_id = $2',
            [habit.id, userId]
          );
          await client.query(
            'DELETE FROM spontaneous_notifications WHERE habit_id = $1 AND user_id = $2',
            [habit.id, userId]
          );
        }
      }

      for (const check of dailyChecks as Array<Record<string, unknown>>) {
        if (!check?.id || !check?.habitId) {
          continue;
        }

        const owned = await client.query(
          'SELECT id FROM habits WHERE id = $1 AND user_id = $2',
          [check.habitId, userId]
        );

        if (owned.rows.length === 0) {
          continue;
        }

        await client.query(
          `INSERT INTO daily_checks (id, habit_id, date_key, completed, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (habit_id, date_key) DO UPDATE SET
             id = EXCLUDED.id,
             completed = EXCLUDED.completed,
             updated_at = NOW()`,
          [
            check.id,
            check.habitId,
            check.date,
            Boolean(check.completed),
          ]
        );
      }

      await client.query('COMMIT');

      const [habitsResult, checksResult] = await Promise.all([
        pool.query(
          `SELECT id, user_id, name, description, frequency, schedule_days, notification_time, deadline, color, created_at, ai_personalized_reminders, ai_spontaneous_reminders
           FROM habits WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT dc.id, dc.habit_id, dc.date_key, dc.completed
           FROM daily_checks dc
           INNER JOIN habits h ON h.id = dc.habit_id
           WHERE h.user_id = $1
           ORDER BY dc.date_key ASC`,
          [userId]
        ),
      ]);

      res.json({
        habits: habitsResult.rows.map(mapHabit),
        dailyChecks: checksResult.rows.map(mapDailyCheck),
        syncedAt: new Date().toISOString(),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[SYNC] push', error);
      res.status(500).json({ error: 'Erreur lors de l envoi des donnees.' });
    } finally {
      client.release();
    }
  });

  let retries = 0;

  while (retries < 20) {
    try {
      await initDb();
      break;
    } catch (error) {
      retries += 1;
      console.log(`[DB] En attente de PostgreSQL (${retries}/20)...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  app.listen(PORT, () => {
    console.log(`[API] Habit Tracker API ecoute sur le port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('[API] Echec demarrage', error);
  process.exit(1);
});
