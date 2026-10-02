export interface ResourceLimits {
  maxInputBytes: number;
  maxUncompressedBytes: number;
  maxXmlBytes: number;
  maxEntries: number;
  maxXmlDepth: number;
  maxAttributes: number;
  maxXmlTextLength: number;
  /** Conservative cap on XML inspection metadata retained in memory. */
  maxXmlElements: number;
}

export const RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxInputBytes: 25 * 1024 * 1024,
  maxUncompressedBytes: 150 * 1024 * 1024,
  maxXmlBytes: 20 * 1024 * 1024,
  maxEntries: 2000,
  maxXmlDepth: 64,
  maxAttributes: 128,
  maxXmlTextLength: 20 * 1024 * 1024,
  maxXmlElements: 100_000,
});
