import type { DraftPage, DraftRole, DraftSchoolLevel, DraftStage } from './research';

export interface CompetitionSource {
  label: string;
  url: string;
  location: string;
  scope: 'national' | 'national-notice' | 'previous-year';
  checkedOn: string;
}
export interface CompetitionDefinition {
  id: string;
  label: string;
  aliases: readonly string[];
  organizer: string;
  schoolLevels: readonly DraftSchoolLevel[];
  eligibility: readonly string[];
}
export interface PreparationItem { id: string; label: string }
export interface DraftProfile {
  id: string;
  competitionId: string;
  year: number;
  version: string;
  label: string;
  documentType: 'report' | 'summary' | 'plan' | 'application' | 'description' | 'paper' | 'custom';
  policy: 'draft' | 'format-only' | 'reference' | 'guide-only';
  source: CompetitionSource | null;
  page: DraftPage;
  roles: readonly DraftRole[];
  labels: Readonly<Record<DraftRole, string>>;
  coverHeading: string;
  coverFields: readonly ('schoolLevel' | 'subject' | 'researchType' | 'grade' | 'studentCount')[];
  includeToc: boolean;
  allowedStages: readonly DraftStage[];
  formatSummary: readonly string[];
  interpretationNotes: readonly string[];
  checks: readonly string[];
  requirements: readonly PreparationItem[];
  prompts: Partial<Readonly<Record<DraftRole, string>>>;
}
