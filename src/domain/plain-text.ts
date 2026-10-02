import { DRAFT_LIMITS } from './research';

export const PLAIN_TEXT_LIMITS = Object.freeze({ maxCharacters: DRAFT_LIMITS.maxTextCharacters, maxLines: DRAFT_LIMITS.maxParagraphs - 1 });

/** A pasted text is a new source; no uploaded objects or formatting are extracted. */
export function isPlainTextInput(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > PLAIN_TEXT_LIMITS.maxCharacters) return false;
  let lines = 1;
  for (const character of value) if (character === '\n' && ++lines > PLAIN_TEXT_LIMITS.maxLines) return false;
  return true;
}
