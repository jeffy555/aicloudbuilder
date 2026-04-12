import OpenAI from 'openai';
import { createLogger } from './logger.js';

const log = createLogger('AI');

/** Shared OpenAI client instance — validated at import time */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface AICallOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Max retries on transient failures (default: 2) */
  maxRetries?: number;
  /** Base delay between retries in ms (default: 1000, doubles each retry) */
  retryDelayMs?: number;
}

/**
 * Call OpenAI chat completion with timeout and retry.
 * Retries on: rate limit (429), server errors (500+), network errors.
 * Does NOT retry on: 400 Bad Request, 401 Unauthorized, 403 Forbidden.
 */
export async function aiChatCompletion(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options: AICallOptions = {}
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { timeout = 30000, maxRetries = 2, retryDelayMs = 1000 } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const result = await openai.chat.completions.create(params, {
          signal: controller.signal as any,
        });
        clearTimeout(timer);
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (error: unknown) {
      lastError = error;

      // Don't retry on client errors (except 429 rate limit)
      if (error instanceof OpenAI.APIError) {
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw error; // 400, 401, 403 — don't retry
        }
      }

      // Don't retry on abort if it's the last attempt
      if (attempt === maxRetries) break;

      // Exponential backoff
      const delay = retryDelayMs * Math.pow(2, attempt);
      log.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, { attempt: attempt + 1, delay });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Convenience: call AI and parse JSON response.
 * Returns parsed object or null on failure (safe for fallback patterns).
 */
export async function aiJsonCompletion<T = unknown>(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options: AICallOptions = {}
): Promise<T | null> {
  try {
    const completion = await aiChatCompletion(
      { ...params, response_format: { type: 'json_object' } },
      options
    );
    const content = completion.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch (error) {
    log.warn('JSON completion failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export { openai };
