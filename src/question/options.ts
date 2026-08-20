export const answerThinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type AnswerThinkingLevel = (typeof answerThinkingLevels)[number];

export interface AnswerSelection {
  model?: string;
  thinking?: AnswerThinkingLevel;
}

export function isAnswerThinkingLevel(value: string): value is AnswerThinkingLevel {
  return answerThinkingLevels.includes(value as AnswerThinkingLevel);
}

export function validateModelName(value: string): string {
  const model = value.trim();
  if (model.length === 0 || model.length > 160 || /[\u0000-\u001f\u007f\s]/.test(model)) {
    throw new Error('A model name must be a non-empty identifier without whitespace.');
  }
  return model;
}
