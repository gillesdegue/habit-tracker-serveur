import { GoogleGenAI, Type } from '@google/genai';

import { buildToneInstruction, type AiSettings } from './aiTypes.js';

const DEFAULT_QUOTES = [
  'Un petit effort repete chaque jour finit toujours par compter.',
  'La constance transforme les intentions en resultats visibles.',
  'Un check de plus aujourd hui, une habitude solide demain.',
  'La motivation commence, la discipline termine le travail.',
  'Faire simple chaque jour est souvent la meilleure strategie.',
  'Une routine stable vaut mieux qu un elan rare.',
  'Chaque habitude cochee renforce votre identite.',
];

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;

  if (!apiKey) {
    return null;
  }

  return new GoogleGenAI({ apiKey });
}

async function generateJson<T>(
  prompt: string,
  schema: Record<string, unknown>
): Promise<T | null> {
  const ai = getGeminiClient();

  if (!ai) {
    return null;
  }

  try {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });

    const rawText = response.text?.trim();

    if (!rawText) {
      return null;
    }

    return JSON.parse(rawText) as T;
  } catch (error) {
    console.error('[GEMINI] JSON generation failed', error);
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

  const parsed = await generateJson<{ quotes?: unknown }>(prompt, {
    type: Type.OBJECT,
    properties: {
      quotes: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
    },
    required: ['quotes'],
  });

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

export async function generateHabitReminderMessages(input: {
  aiSettings: AiSettings;
  firstName?: string | null;
  habits: Array<{
    id: string;
    name: string;
    frequency: string;
    notificationTime: string;
  }>;
}): Promise<Record<string, string>> {
  if (!input.aiSettings.enabled || input.habits.length === 0) {
    return {};
  }

  const greeting = input.firstName?.trim()
    ? `Utilisateur: ${input.firstName.trim()}.`
    : '';

  const habitsText = input.habits
    .map(
      (habit) =>
        `- id=${habit.id}, nom="${habit.name}", frequence=${habit.frequency}, heure=${habit.notificationTime}`
    )
    .join('\n');

  const prompt = `${greeting}
Genere un message de rappel court pour chaque habitude ci-dessous.
${buildToneInstruction(input.aiSettings)}
Maximum 14 mots par message, en francais, sans guillemets.
${habitsText}
Retourne un JSON {"messages":[{"habitId":"...","message":"..."}]}.`;

  const parsed = await generateJson<{
    messages?: Array<{ habitId?: string; message?: string }>;
  }>(prompt, {
    type: Type.OBJECT,
    properties: {
      messages: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            habitId: { type: Type.STRING },
            message: { type: Type.STRING },
          },
          required: ['habitId', 'message'],
        },
      },
    },
    required: ['messages'],
  });

  const result: Record<string, string> = {};

  for (const entry of parsed?.messages ?? []) {
    if (entry.habitId && entry.message?.trim()) {
      result[entry.habitId] = entry.message.trim();
    }
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

  const eligibleHabits = input.habits.filter((habit) => habit.completionRate14d < 1);

  if (eligibleHabits.length === 0) {
    return [];
  }

  const greeting = input.firstName?.trim()
    ? `Utilisateur: ${input.firstName.trim()}.`
    : '';

  const habitsText = eligibleHabits
    .map(
      (habit) =>
        `- id=${habit.id}, nom="${habit.name}", frequence=${habit.frequency}, heure_habituelle=${habit.notificationTime}, taux_14j=${Math.round(habit.completionRate14d * 100)}%, jours_manques=${habit.missedDays14d}, plutot_matin=${habit.usuallyCompletesMorning ? 'oui' : 'non'}`
    )
    .join('\n');

  const prompt = `${greeting}
Semaine commencant le ${input.weekKey}.
Propose des notifications spontanées PERSONNALISEES pour aider l'utilisateur a tenir ses habitudes.
${buildToneInstruction(input.aiSettings)}
Regles:
- 1 a 3 notifications max par habitude sur la semaine
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
  }>(prompt, {
    type: Type.OBJECT,
    properties: {
      notifications: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            habitId: { type: Type.STRING },
            scheduledAt: { type: Type.STRING },
            title: { type: Type.STRING },
            message: { type: Type.STRING },
          },
          required: ['habitId', 'scheduledAt', 'title', 'message'],
        },
      },
    },
    required: ['notifications'],
  });

  const now = Date.now();

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
      return !Number.isNaN(scheduledAt) && scheduledAt > now;
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

  const parsed = await generateJson<{ message?: string }>(prompt, {
    type: Type.OBJECT,
    properties: {
      message: { type: Type.STRING },
    },
    required: ['message'],
  });

  return parsed?.message?.trim() ?? null;
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.API_KEY);
}
