export interface PreflightReport {
  entryCount: number;
  uncompressedBytes: number;
  xmlCount: number;
  sectionPaths: string[];
  formatVersion: string;
  supportLevel: 'INSPECT_ONLY';
}
