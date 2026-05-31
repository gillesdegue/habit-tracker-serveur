export function normalizeAiReminderLevel(value: unknown): number {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(10, Math.max(0, Math.round(parsed)));
}

export function extraNotificationsPerDay(level: number): number {
  return normalizeAiReminderLevel(level);
}

/** @deprecated Use extraNotificationsPerDay */
export function notificationsPerApplicableDay(level: number): number {
  return extraNotificationsPerDay(level);
}

/** @deprecated Use extraNotificationsPerDay */
export function maxSpontaneousFromFrequency(frequency: number): number {
  return extraNotificationsPerDay(frequency);
}

/** Nombre de messages IA distincts requis par habitude (horaire principal + extras). */
export function requiredPersonalizedVariants(level: number): number {
  return 1 + extraNotificationsPerDay(level);
}
