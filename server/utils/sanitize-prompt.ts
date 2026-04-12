/**
 * Sanitize user-supplied text before embedding in AI prompts.
 * Prevents prompt injection by:
 * 1. Removing prompt boundary markers (--- FILE:, --- END, [SYSTEM], [INST], etc.)
 * 2. Escaping newlines in single-line fields (names, descriptions)
 * 3. Truncating to max length
 */

/** Strip known prompt injection patterns from text */
function stripInjectionPatterns(text: string): string {
  return text
    // Remove common prompt boundary markers
    .replace(/---\s*(FILE|END|SYSTEM|USER|ASSISTANT|INSTRUCTION)[:\s]*/gi, '')
    // Remove role-play injection attempts
    .replace(/\[(SYSTEM|INST|USER|ASSISTANT)\]/gi, '')
    // Remove XML-style injection
    .replace(/<\/?(?:system|user|assistant|instruction)[^>]*>/gi, '')
    // Remove "ignore previous instructions" patterns
    .replace(/ignore\s+(all\s+)?previous\s+instructions?/gi, '[filtered]')
    .replace(/disregard\s+(all\s+)?(?:previous|above)\s+/gi, '[filtered]');
}

/**
 * Sanitize a single-line field (name, title, etc.)
 * Strips newlines, injection patterns, and truncates.
 */
export function sanitizeField(input: string, maxLength = 200): string {
  if (!input || typeof input !== 'string') return '';
  const cleaned = stripInjectionPatterns(input)
    .replace(/[\r\n]+/g, ' ')  // collapse newlines to spaces
    .trim()
    .substring(0, maxLength);
  return cleaned;
}

/**
 * Sanitize a multi-line content block (file content, descriptions, code).
 * Keeps newlines but strips injection patterns and truncates.
 */
export function sanitizeContent(input: string, maxLength = 8000): string {
  if (!input || typeof input !== 'string') return '';
  return stripInjectionPatterns(input).substring(0, maxLength);
}

/**
 * Sanitize a JSON-stringified object for embedding in prompts.
 * Applies field sanitization to all string values recursively.
 */
export function sanitizeJsonForPrompt(obj: unknown, maxDepth = 5): unknown {
  if (maxDepth <= 0) return '[truncated]';
  if (typeof obj === 'string') return sanitizeField(obj, 500);
  if (Array.isArray(obj)) return obj.slice(0, 100).map(item => sanitizeJsonForPrompt(item, maxDepth - 1));
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeJsonForPrompt(value, maxDepth - 1);
    }
    return result;
  }
  return obj;
}
