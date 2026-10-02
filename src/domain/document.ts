/** Read models only. These values never enable editing or serialize a document. */
export const INSPECTION_MAX_ENTRY_PATH_LENGTH = 256;

export interface SourceSpan {
  entryPath: string;
  startByte: number;
  endByte: number;
}

export type InspectionReason =
  | 'MISSING_FORMAT_REFERENCE' | 'AMBIGUOUS_FORMAT_REFERENCE'
  | 'MISSING_FORMAT_VALUE' | 'INVALID_FORMAT_VALUE' | 'UNSUPPORTED_FORMAT'
  | 'COMPATIBILITY_BRANCH' | 'UNKNOWN_NAMESPACE' | 'UNKNOWN_ELEMENT'
  | 'FIELD_CONTROL' | 'HEADER_FOOTER' | 'NOTE_CONTEXT' | 'UNSUPPORTED_CONTROL'
  | 'NON_TEXT_OBJECT' | 'MERGED_TABLE' | 'NESTED_TABLE' | 'INVALID_TABLE_STRUCTURE'
  | 'SUPERSCRIPT_OR_SUBSCRIPT' | 'UNSUPPORTED_CONTEXT';

export interface InspectionNode {
  nodeId: string;
  /** The source XML id is descriptive and never used as the unique node key. */
  sourceId: string | null;
  structurePath: string;
  sourceSpan: SourceSpan;
  supportLevel: 'INSPECT_ONLY';
  /** A possible future validation target, never permission to edit. */
  correctionCandidate: boolean;
  reasons: InspectionReason[];
}

export type FormatKind = 'FONT' | 'CHARACTER_SHAPE' | 'PARAGRAPH_SHAPE' | 'STYLE';
export interface FormatSource {
  kind: FormatKind;
  definitionId: string | null;
  nodeId: string;
  sourceSpan: SourceSpan;
  viaStyleId: string | null;
}

export interface FormatReference {
  kind: FormatKind;
  requestedId: string | null;
  resolved: boolean;
  definitionNodeId: string | null;
  sourceSpan: SourceSpan;
  viaStyleId: string | null;
  reasons: InspectionReason[];
}

export interface FormatValue<T> {
  value: T | null;
  rawValue: string | null;
  rawUnit: string | null;
  unit: string | null;
  source: FormatSource | null;
  reasons: InspectionReason[];
}

export const FONT_LANGUAGES = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'] as const;
export type FontLanguage = typeof FONT_LANGUAGES[number];
export interface CharacterFormat {
  reference: FormatReference;
  fontSize: FormatValue<number>;
  fonts: Record<FontLanguage, FormatValue<string>>;
  ratio: Record<FontLanguage, FormatValue<number>>;
  spacing: Record<FontLanguage, FormatValue<number>>;
  relativeSize: Record<FontLanguage, FormatValue<number>>;
  offset: Record<FontLanguage, FormatValue<number>>;
  superscript: boolean;
  subscript: boolean;
  reasons: InspectionReason[];
}

export interface ParagraphFormat {
  reference: FormatReference;
  alignment: FormatValue<string>;
  lineSpacingType: FormatValue<string>;
  lineSpacing: FormatValue<number>;
  leftMargin: FormatValue<number>;
  rightMargin: FormatValue<number>;
  indent: FormatValue<number>;
  beforeSpacing: FormatValue<number>;
  afterSpacing: FormatValue<number>;
  reasons: InspectionReason[];
}

export interface FormatDefinition {
  nodeId: string;
  id: string | null;
  kind: FormatKind;
  sourceSpan: SourceSpan;
  attributes: Record<string, string>;
  reasons: InspectionReason[];
}
export interface FontDefinition extends FormatDefinition {
  language: string | null;
  face: string | null;
}
export interface FormatCatalog {
  fonts: FontDefinition[];
  characterShapes: FormatDefinition[];
  paragraphShapes: FormatDefinition[];
  styles: FormatDefinition[];
}

export interface InspectionSection extends InspectionNode {
  entryPath: string;
  order: number;
  paragraphIds: string[];
  tableIds: string[];
}
export interface InspectionTextSegment {
  kind: 'TEXT' | 'CDATA' | 'TAB' | 'LINE_BREAK' | 'UNKNOWN_CONTROL';
  text: string;
  elementName: string | null;
  sourceSpan: SourceSpan;
  /** A strictly recognized layout-only control, never text or editing permission. */
  layoutControl?: true;
}
export interface InspectionRun extends InspectionNode {
  paragraphId: string;
  text: string;
  segments: InspectionTextSegment[];
  characterFormat: CharacterFormat;
}
export type ParagraphContext = 'BODY' | 'TABLE_CELL' | 'HEADER' | 'FOOTER' | 'NOTE' | 'UNKNOWN';
export interface InspectionParagraph extends InspectionNode {
  sectionId: string;
  context: ParagraphContext;
  parentCellId: string | null;
  runIds: string[];
  text: string;
  styleReference: FormatReference;
  paragraphFormat: ParagraphFormat;
}
export interface InspectionTable extends InspectionNode {
  sectionId: string;
  parentTableId: string | null;
  rows: number | null;
  columns: number | null;
  rowIds: string[];
  cellIds: string[];
  paragraphIds: string[];
}
export interface InspectionRow extends InspectionNode {
  tableId: string;
  order: number;
  cellIds: string[];
}
export interface InspectionCell extends InspectionNode {
  tableId: string;
  rowId: string;
  rowAddress: number | null;
  columnAddress: number | null;
  rowSpan: number | null;
  columnSpan: number | null;
  paragraphIds: string[];
  text: string;
}
export interface DocumentInspection {
  supportLevel: 'INSPECT_ONLY';
  editingEnabled: false;
  sections: InspectionSection[];
  paragraphs: InspectionParagraph[];
  runs: InspectionRun[];
  tables: InspectionTable[];
  rows: InspectionRow[];
  cells: InspectionCell[];
  formats: FormatCatalog;
  summary: {
    sectionCount: number;
    paragraphCount: number;
    runCount: number;
    tableCount: number;
    cellCount: number;
    correctionCandidateParagraphCount: number;
  };
}
