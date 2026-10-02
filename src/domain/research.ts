export type ResearchDraftKind = 'competition' | 'paper';
export const DRAFT_ROLES = ['summary', 'need', 'design', 'practice', 'results', 'reflection', 'references', 'appendix'] as const;
export type DraftRole = typeof DRAFT_ROLES[number];
export const DRAFT_STAGES = ['planning', 'regional', 'national'] as const;
export type DraftStage = typeof DRAFT_STAGES[number];
export const DRAFT_SCHOOL_LEVELS = ['elementary', 'middle', 'high', 'kindergarten', 'special'] as const;
export type DraftSchoolLevel = typeof DRAFT_SCHOOL_LEVELS[number];
export const DRAFT_SUPPLEMENT_ID_BASE = 10_000;

export interface DraftSupplement { role: DraftRole; text: string }
export interface CustomDraftSettings {
  name: string;
  fontFace: string;
  fontSizePt: number;
  lineSpacingPercent: number;
  marginMm: { top: number; bottom: number; left: number; right: number; header: number; footer: number; gutter: number };
  labels?: Partial<Record<DraftRole, string>>;
}

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
  /** Omitted selections retain the original 2026 innovation draft behavior. */
  profileId?: string;
  year?: number;
  stage?: DraftStage;
  supplements?: DraftSupplement[];
  custom?: CustomDraftSettings;
  schoolLevel?: DraftSchoolLevel;
  /** Only summary documents may explicitly include a reviewed subset. */
  summaryParagraphIds?: string[];
  summarySelectionConfirmed?: boolean;
}

export interface ResearchDraftResult {
  bytes: Uint8Array<ArrayBuffer>;
  kind: ResearchDraftKind;
  sourceParagraphCount: number;
  outputParagraphCount: number;
  packageVerified: true;
  originalTextVerified: true;
  manualValidation: 'NOT_RUN';
  profileId?: string;
  profileLabel?: string;
  profileYear?: number;
  profileVersion?: string;
  addedParagraphCount?: number;
  includedParagraphCount?: number;
  excludedParagraphCount?: number;
  sourceSelection?: 'all' | 'summary-selection';
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
  fontSizes?: Partial<Record<'title' | 'heading' | 'cover' | 'toc' | 'references', number>>;
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
  if (options.profileId !== undefined && (typeof options.profileId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(options.profileId))
    || options.year !== undefined && (!Number.isInteger(options.year) || Number(options.year) < 2000 || Number(options.year) > 2100)
    || options.stage !== undefined && !(DRAFT_STAGES as readonly unknown[]).includes(options.stage)) return false;
  if (options.schoolLevel !== undefined && !(DRAFT_SCHOOL_LEVELS as readonly unknown[]).includes(options.schoolLevel)) return false;
  if (options.supplements !== undefined) {
    if (!Array.isArray(options.supplements) || options.supplements.length > DRAFT_ROLES.length) return false;
    const roles = new Set<DraftRole>();
    for (const supplement of options.supplements) {
      if (typeof supplement !== 'object' || supplement === null || !isDraftRole(supplement.role)
        || typeof supplement.text !== 'string' || !supplement.text.trim() || supplement.text.length > 20_000 || roles.has(supplement.role)) return false;
      roles.add(supplement.role);
    }
  }
  if (options.custom !== undefined && !isCustomDraftSettings(options.custom)) return false;
  if (options.summarySelectionConfirmed !== undefined && typeof options.summarySelectionConfirmed !== 'boolean') return false;
  if (options.summaryParagraphIds !== undefined) {
    if (!Array.isArray(options.summaryParagraphIds) || options.summaryParagraphIds.length === 0 || options.summaryParagraphIds.length > DRAFT_LIMITS.maxParagraphs
      || options.summarySelectionConfirmed !== true || new Set(options.summaryParagraphIds).size !== options.summaryParagraphIds.length
      || options.summaryParagraphIds.some((id: unknown) => typeof id !== 'string' || id.length === 0 || id.length > 500)) return false;
  }
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

export function isCustomDraftSettings(value: unknown): value is CustomDraftSettings {
  if (typeof value !== 'object' || value === null) return false;
  const custom = value as Record<string, unknown>;
  if (typeof custom.name !== 'string' || !custom.name.trim() || custom.name.length > 100
    || typeof custom.fontFace !== 'string' || !custom.fontFace.trim() || custom.fontFace.length > 128 || /[\u0000-\u001f\u007f]/u.test(custom.fontFace)
    || typeof custom.fontSizePt !== 'number' || !Number.isFinite(custom.fontSizePt) || custom.fontSizePt < 6 || custom.fontSizePt > 72
    || Math.abs(Math.round(custom.fontSizePt * 100) - custom.fontSizePt * 100) > Number.EPSILON * Math.max(1, Math.abs(custom.fontSizePt * 100)) * 4
    || !Number.isInteger(custom.lineSpacingPercent) || Number(custom.lineSpacingPercent) < 80 || Number(custom.lineSpacingPercent) > 300
    || typeof custom.marginMm !== 'object' || custom.marginMm === null) return false;
  const margins = custom.marginMm as Record<string, unknown>;
  for (const key of ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter']) {
    const number = margins[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 80) return false;
  }
  if (Number(margins.left) + Number(margins.right) + Number(margins.gutter) >= 210
    || Number(margins.top) + Number(margins.bottom) >= 297) return false;
  if (custom.labels !== undefined) {
    if (typeof custom.labels !== 'object' || custom.labels === null || Array.isArray(custom.labels)) return false;
    for (const [key, label] of Object.entries(custom.labels)) if (!isDraftRole(key) || typeof label !== 'string' || !label.trim() || label.length > 100) return false;
  }
  return true;
}
