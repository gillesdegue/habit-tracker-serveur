import { buildToneInstruction, type AiSettings } from './aiTypes.js';
import {
  extraNotificationsPerDay,
  normalizeAiReminderLevel,
  requiredPersonalizedVariants,
} from './habitAiFrequency.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_QUOTES = [
  'Un petit effort repete chaque jour finit toujours par compter.',
  'La constance transforme les intentions en resultats visibles.',
  'Un check de plus aujourd hui, une habitude solide demain.',
  'La motivation commence, la discipline termine le travail.',
  'Faire simple chaque jour est souvent la meilleure strategie.',
  'Une routine stable vaut mieux qu un elan rare.',
  'Chaque habitude cochee renforce votre identite.',
];

function getModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || 'google/gemini-2.5-flash';
}

function getReferer(): string {
  return (
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    'https://habits-api.digitalelevate.info'
  );
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export { maxSpontaneousFromFrequency, extraNotificationsPerDay, notificationsPerApplicableDay, normalizeAiReminderLevel } from './habitAiFrequency.js';

async function openRouterRequest(body: Record<string, unknown>): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY manquante');
  }

  return fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': getReferer(),
      'X-Title': 'Habit Tracker',
    },
    body: JSON.stringify(body),
  });
}

function extractJsonText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textPart = content.find(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        (part as { type?: string }).type === 'text'
    ) as { text?: string } | undefined;

    return textPart?.text?.trim() ?? null;
  }

  return null;
}

async function generateJson<T>(prompt: string): Promise<T | null> {
  if (!isGeminiConfigured()) {
    return null;
  }

  try {
    const response = await openRouterRequest({
      model: getModel(),
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error('[OPENROUTER] Request failed', response.status, errorBody);
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const rawText = extractJsonText(payload.choices?.[0]?.message?.content);

    if (!rawText) {
      return null;
    }

    return JSON.parse(rawText) as T;
  } catch (error) {
    console.error('[OPENROUTER] JSON generation failed', error);
    return null;
  }
}

export async function generateWeeklyQuotes(input: {
  aiSettings: AiSettings;
  firstName?: string | null;
}): Promise<string[]> {
  if (!input.aiSettings.enabled) {
    return [...DEFAULT_QUOTES];
  }

  const greeting = input.firstName?.trim()
    ? `L'utilisateur s'appelle ${input.firstName.trim()}.`
    : '';

  const prompt = `${greeting}
Genere exactement 7 citations courtes en francais pour une application de suivi d'habitudes.
Une citation par jour de la semaine, du lundi au dimanche.
${buildToneInstruction(input.aiSettings)}
Longueur: 8 a 18 mots maximum par citation.
Pas de numerotation, pas de guillemets autour des citations.
Retourne uniquement un JSON valide avec la forme {"quotes":["...","...","...","...","...","...","..."]}.`;

  const parsed = await generateJson<{ quotes?: unknown }>(prompt);

  if (!parsed?.quotes || !Array.isArray(parsed.quotes)) {
    return [...DEFAULT_QUOTES];
  }

  const quotes = parsed.quotes
    .map((quote) => String(quote).trim())
    .filter((quote) => quote.length > 0)
    .slice(0, 7);

  while (quotes.length < 7) {
    quotes.push(DEFAULT_QUOTES[quotes.length % DEFAULT_QUOTES.length]);
  }

  return quotes;
}

function fallbackReminderVariants(
  habitName: string,
  count: number
): string[] {
  const templates = [
    `C'est le moment pour ${habitName}.`,
    `Pensez a ${habitName} maintenant.`,
    `${habitName} vous attend, allez-y !`,
    `Un pas de plus : ${habitName}.`,
    `Gardez le rythme avec ${habitName}.`,
    `N'oubliez pas ${habitName} aujourd'hui.`,
    `Votre habitude ${habitName} compte.`,
    `Faites ${habitName} maintenant.`,
    `Encore un effort pour ${habitName}.`,
    `Continuez avec ${habitName}.`,
    `Place a ${habitName} !`,
  ];

  return Array.from({ length: count }, (_, index) =>
    templates[index % templates.length]
  );
}

export async function generateHabitReminderMessages(input: {
  aiSettings: AiSettings;
  firstName?: string | null;
  habits: Array<{
    id: string;
    name: string;
    frequency: string;
    notificationTime: string;
    aiReminderFrequency?: number;
  }>;
}): Promise<Record<string, string[]>> {
  if (!input.aiSettings.enabled || input.habits.length === 0) {
    return {};
  }

  const greeting = input.firstName?.trim()
    ? `Utilisateur: ${input.firstName.trim()}.`
    : '';

  const habitsText = input.habits
    .map((habit) => {
      const variantCount = requiredPersonalizedVariants(
        habit.aiReminderFrequency ?? 0
      );

      return `- id=${habit.id}, nom="${habit.name}", frequence=${habit.frequency}, heure=${habit.notificationTime}, messages_distincts_requis=${variantCount}`;
    })
    .join('\n');

  const prompt = `${greeting}
Genere des messages de rappel PERSONNALISES pour chaque habitude ci-dessous.
${buildToneInstruction(input.aiSettings)}
Pour chaque habitude, genere EXACTEMENT le nombre indique par messages_distincts_requis.
Chaque message doit etre DISTINCT (angle, formulation, energie) mais rester coherent avec le ton.
Maximum 14 mots par message, en francais, sans guillemets.
Habitudes:
${habitsText}
Retourne un JSON {"messages":[{"habitId":"...","variants":["...","..."]}]}.`;

  const parsed = await generateJson<{
    messages?: Array<{ habitId?: string; variants?: unknown; message?: string }>;
  }>(prompt);

  const result: Record<string, string[]> = {};

  for (const habit of input.habits) {
    const required = requiredPersonalizedVariants(habit.aiReminderFrequency ?? 0);
    const entry = (parsed?.messages ?? []).find(
      (item) => item.habitId === habit.id
    );
    const fromVariants = Array.isArray(entry?.variants)
      ? entry!.variants
          .map((variant) => String(variant).trim())
          .filter((variant) => variant.length > 0)
      : [];
    const fromLegacy =
      typeof entry?.message === 'string' && entry.message.trim()
        ? [entry.message.trim()]
        : [];

    const collected = [...fromVariants, ...fromLegacy].slice(0, required);

    while (collected.length < required) {
      const fallbacks = fallbackReminderVariants(habit.name, required);
      collected.push(fallbacks[collected.length] ?? fallbacks[0]);
    }

    result[habit.id] = collected;
  }

  return result;
}

export async function generateSpontaneousPlan(input: {
  aiSettings: AiSettings;
  firstName?: string | null;
  weekKey: string;
  habits: Array<{
    id: string;
    name: string;
    frequency: string;
    notificationTime: string;
    completionRate14d: number;
    missedDays14d: number;
    usuallyCompletesMorning: boolean;
    aiReminderFrequency?: number;
  }>;
}): Promise<
  Array<{
    habitId: string;
    scheduledAt: string;
    title: string;
    message: string;
  }>
> {
  if (!input.aiSettings.enabled || !input.aiSettings.spontaneousEnabled) {
    return [];
  }

  const eligibleHabits = input.habits.filter(
    (habit) =>
      habit.completionRate14d < 1 &&
      extraNotificationsPerDay(habit.aiReminderFrequency ?? 0) > 0
  );

  if (eligibleHabits.length === 0) {
    return [];
  }

  const greeting = input.firstName?.trim()
    ? `Utilisateur: ${input.firstName.trim()}.`
    : '';

  const habitsText = eligibleHabits
    .map((habit) => {
      const maxNotifications = extraNotificationsPerDay(
        habit.aiReminderFrequency ?? 0
      );

      return `- id=${habit.id}, nom="${habit.name}", frequence=${habit.frequency}, heure_habituelle=${habit.notificationTime}, taux_14j=${Math.round(habit.completionRate14d * 100)}%, jours_manques=${habit.missedDays14d}, plutot_matin=${habit.usuallyCompletesMorning ? 'oui' : 'non'}, max_notifications_par_jour_concerne=${maxNotifications}`;
    })
    .join('\n');

  const prompt = `${greeting}
Semaine commencant le ${input.weekKey}.
Propose des notifications spontanees PERSONNALISEES pour aider l'utilisateur a tenir ses habitudes.
${buildToneInstruction(input.aiSettings)}
Regles:
- Respecte max_notifications_par_jour_concerne uniquement les jours prevus par la frequence de l'habitude
- Ne programme jamais une notification a moins de 90 minutes de l'heure habituelle de l'habitude
- Choisis des heures pertinentes (ISO 8601) entre 07:00 et 21:00, timezone Europe/Paris implicite
- Si l'utilisateur manque souvent, rappel plus tot ou en fin de journee selon son historique
- Si l'utilisateur valide le matin, evite les rappels du soir inutiles
- Messages courts (max 16 mots), titres courts (max 5 mots)
Habitudes:
${habitsText}
Retourne {"notifications":[{"habitId":"...","scheduledAt":"2026-05-23T18:30:00","title":"...","message":"..."}]}.`;

  const parsed = await generateJson<{
    notifications?: Array<{
      habitId?: string;
      scheduledAt?: string;
      title?: string;
      message?: string;
    }>;
  }>(prompt);

  const now = Date.now();
  const maxByHabit = new Map(
    eligibleHabits.map((habit) => [
      habit.id,
      extraNotificationsPerDay(habit.aiReminderFrequency ?? 0),
    ])
  );
  const countsByHabitDay = new Map<string, number>();

  return (parsed?.notifications ?? [])
    .filter(
      (entry) =>
        entry.habitId &&
        entry.scheduledAt &&
        entry.title?.trim() &&
        entry.message?.trim()
    )
    .map((entry) => ({
      habitId: entry.habitId as string,
      scheduledAt: entry.scheduledAt as string,
      title: entry.title!.trim(),
      message: entry.message!.trim(),
    }))
    .filter((entry) => {
      const scheduledAt = new Date(entry.scheduledAt).getTime();

      if (Number.isNaN(scheduledAt) || scheduledAt <= now) {
        return false;
      }

      const maxForHabit = maxByHabit.get(entry.habitId) ?? 0;
      const dayKey = entry.scheduledAt.slice(0, 10);
      const countKey = `${entry.habitId}:${dayKey}`;
      const currentCount = countsByHabitDay.get(countKey) ?? 0;

      if (currentCount >= maxForHabit) {
        return false;
      }

      countsByHabitDay.set(countKey, currentCount + 1);
      return true;
    })
    .slice(0, 21);
}

export async function generateInAppMessage(input: {
  aiSettings: AiSettings;
  habitName: string;
  completed: boolean;
  streak: number;
}): Promise<string | null> {
  if (!input.aiSettings.enabled) {
    return null;
  }

  const action = input.completed
    ? `L'utilisateur vient de valider l'habitude "${input.habitName}" (serie: ${input.streak}).`
    : `L'utilisateur vient de decocher l'habitude "${input.habitName}".`;

  const prompt = `${action}
${buildToneInstruction(input.aiSettings)}
Genere UNE phrase courte (max 14 mots) pour une banniere in-app en francais.
Retourne {"message":"..."}.`;

  const parsed = await generateJson<{ message?: string }>(prompt);

  return parsed?.message?.trim() ?? null;
}
