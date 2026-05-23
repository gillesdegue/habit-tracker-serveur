export type AiTone = 'gentle' | 'motivating' | 'direct' | 'sarcastic' | 'strict';

export type AiSettings = {
  enabled: boolean;
  tone: AiTone;
  intensity: number;
  spontaneousEnabled: boolean;
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  tone: 'motivating',
  intensity: 3,
  spontaneousEnabled: false,
};

export function buildToneInstruction(settings: AiSettings): string {
  const intensityLabel =
    settings.intensity <= 2
      ? 'tres leger'
      : settings.intensity === 3
        ? 'modere'
        : settings.intensity === 4
          ? 'marque'
          : 'tres marque';

  switch (settings.tone) {
    case 'gentle':
      return 'Ton bienveillant, chaleureux, rassurant, jamais culpabilisant.';
    case 'direct':
      return `Ton direct et concret, sans blabla, intensite ${intensityLabel}.`;
    case 'sarcastic':
      return `Ton sarcastique mais bienveillant, humour leger, intensite ${intensityLabel}.`;
    case 'strict':
      return `Ton strict, exigeant, discipline, intensite ${intensityLabel}.`;
    case 'motivating':
    default:
      return 'Ton motivant, positif, energique, oriente action.';
  }
}
