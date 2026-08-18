/**
 * Credential redaction at the data boundary.
 *
 * Everything that can carry a token towards the model, the transcript, or disk passes
 * through here: result data, spill files, artifact indexes, resolution metadata, local
 * results, and every external error message. TUI rendering redacts as well, but it is
 * the last line, never the only one.
 */

export const REDACTED = '[REDACTED]';

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Linear personal API keys and OAuth tokens.
  /lin_(?:api|oauth)_[A-Za-z0-9_-]{4,}/g,
  // Authorization header values, however they were quoted.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  /\bAuthorization["'\s:=]+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `secrets` carries exact values — normally the active API key — so a credential in an
 * unknown format is still removed. Known prefixes stay as defence in depth for tokens
 * that are not the active key.
 */
export function redactText(value: string, secrets: readonly string[] = []): string {
  const exact = secrets
    .filter((secret) => typeof secret === 'string' && secret.length >= 8)
    .reduce((text, secret) => text.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED), value);
  return CREDENTIAL_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), exact);
}

export function containsCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/** Deep copy with every string value redacted. Non-string leaves pass through. */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactText(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, redactDeep(child, secrets)]),
    ) as T;
  }
  return value;
}

/**
 * Redact an error in place, keeping its type and stack so callers can still branch on
 * it, while the public message carries no credential.
 */
export function redactError(error: unknown, secrets: readonly string[] = []): unknown {
  if (error instanceof Error) {
    error.message = redactText(error.message, secrets);
    if (typeof error.stack === 'string') error.stack = redactText(error.stack, secrets);
    return error;
  }
  return new Error(redactText(typeof error === 'string' ? error : String(error), secrets));
}

/** Run `work`, redacting anything it throws before the failure leaves this package. */
export async function withRedactedErrors<T>(
  work: () => Promise<T>,
  /** Read when a failure happens, so a key discovered mid-call still applies. */
  secrets: readonly string[] = [],
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw redactError(error, secrets);
  }
}
