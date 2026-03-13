const PANWATCH_JSON_BLOCK = /<!--PANWATCH_JSON-->[\s\S]*?<!--\/PANWATCH_JSON-->/gi
const LEGACY_STRUCTURED_BLOCK = /<STRUCTURED_OUTPUT>[\s\S]*?<\/STRUCTURED_OUTPUT>/gi

export function sanitizeReportContent(content: string | null | undefined): string {
  const raw = String(content || '')
  return raw
    .replace(PANWATCH_JSON_BLOCK, '')
    .replace(LEGACY_STRUCTURED_BLOCK, '')
    .trim()
}
