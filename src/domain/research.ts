export type ResearchDraftKind = 'competition' | 'paper';
export const DRAFT_ROLES = ['summary', 'need', 'design', 'practice', 'results', 'reflection', 'references', 'appendix'] as const;
export type DraftRole = typeof DRAFT_ROLES[number];

export const DRAFT_LIMITS = Object.freeze({ maxParagraphs: 2000, maxTextCharacters: 2_000_000, maxTitleCharacters: 160 });
export const DRAFT_SOURCE_ID_BASE = 1000;

export interface DraftAssignment {
  paragraphId: string;
  /** Bind a recommendation to its exact source text, including whitespace. */
  sourceText: string;
  role: DraftRole;
}

export interface ResearchDraftOptions {
  kind: ResearchDraftKind;
  title: string;
  subject: string;
  grade: string;
  studentCount: string;
  researchType?: 'individual' | 'joint';
  assignments: DraftAssignment[];
}

export interface ResearchDraftResult {
  bytes: Uint8Array<ArrayBuffer>;
  kind: ResearchDraftKind;
  sourceParagraphCount: number;
  outputParagraphCount: number;
  packageVerified: true;
  originalTextVerified: true;
  manualValidation: 'NOT_RUN';
}

export interface DraftParagraph {
  paragraphId: string;
  text: string;
  role: DraftRole;
  evidence: string;
}

export interface DraftRecommendation {
  eligible: boolean;
  blockers: string[];
  paragraphs: DraftParagraph[];
  warnings: string[];
}

export interface DraftPage {
  fontFace: string;
  fontSizePt: number;
  lineSpacingPercent: number;
  width: number;
  height: number;
  /** HWPUNIT, interpreted from the source's unspecified margin units as mm. */
  margins: { top: number; bottom: number; left: number; right: number; header: number; footer: number; gutter: number };
  indent: number;
  beforeSpacing: number;
  afterSpacing: number;
}

export function isDraftRole(value: unknown): value is DraftRole {
  return typeof value === 'string' && (DRAFT_ROLES as readonly string[]).includes(value);
}

export function isResearchDraftOptions(value: unknown): value is ResearchDraftOptions {
  if (typeof value !== 'object' || value === null) return false;
  const options = value as Record<string, unknown>;
  if (options.kind !== 'competition' && options.kind !== 'paper') return false;
  if (typeof options.title !== 'string' || !options.title.trim() || options.title.length > DRAFT_LIMITS.maxTitleCharacters
    || typeof options.subject !== 'string' || options.subject.length > 100
    || typeof options.grade !== 'string' || options.grade.length > 50
    || typeof options.studentCount !== 'string' || !/^(?:[1-9][0-9]{0,3})?$/u.test(options.studentCount)
    || options.researchType !== undefined && options.researchType !== 'individual' && options.researchType !== 'joint') return false;
  if (!Array.isArray(options.assignments) || options.assignments.length === 0 || options.assignments.length > DRAFT_LIMITS.maxParagraphs) return false;
  let characters = 0;
  const ids = new Set<string>();
  for (const value of options.assignments) {
    if (typeof value !== 'object' || value === null) return false;
    const assignment = value as Record<string, unknown>;
    if (typeof assignment.paragraphId !== 'string' || assignment.paragraphId.length === 0 || assignment.paragraphId.length > 384
      || ids.has(assignment.paragraphId) || !isDraftRole(assignment.role) || typeof assignment.sourceText !== 'string') return false;
    ids.add(assignment.paragraphId);
    characters += assignment.sourceText.length;
    if (characters > DRAFT_LIMITS.maxTextCharacters) return false;
  }
  return true;
}
