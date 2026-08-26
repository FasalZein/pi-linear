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
    .filter((secret) => secret.length >= 8)
    .reduce((text, secret) => text.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED), value);
  return CREDENTIAL_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), exact);
}

export function containsCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function redactEntries<T extends object>(value: T, secrets: readonly string[]): Record<string, T[keyof T]> {
  const used = new Set<string>();
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const redactedKey = redactText(key, secrets);
    let outputKey = redactedKey;
    for (let suffix = 2; used.has(outputKey); suffix++) outputKey = `${redactedKey}#${suffix}`;
    used.add(outputKey);
    return [outputKey, redactDeep(child, secrets)];
  })) as Record<string, T[keyof T]>;
}

/** Deep copy with every string key and value redacted. Non-string leaves pass through. */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (Object.prototype.toString.call(value) === '[object String]') return redactText(value as string, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as T;
  if (value instanceof Error) {
    const copy = Object.create(Object.getPrototypeOf(value)) as Error;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (Object.prototype.toString.call(key) === '[object String]' && descriptor.enumerable) continue;
      if (key === 'stack') {
        Object.defineProperty(copy, key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          value: value.stack === undefined ? undefined : redactText(value.stack, secrets),
          writable: true,
        });
      } else {
        if ('value' in descriptor) descriptor.value = redactDeep(descriptor.value, secrets);
        Object.defineProperty(copy, key, descriptor);
      }
    }
    Object.defineProperties(copy, Object.getOwnPropertyDescriptors(redactEntries(value, secrets)));
    return copy as T;
  }
  if (value !== null && value !== undefined && Object(value) === value) return redactEntries(value, secrets) as T;
  return value;
}

/** Redact an error without changing its type, stack, or source object. */
export function redactError(cause: unknown, secrets: readonly string[] = []): Error {
  if (cause instanceof Error) return redactDeep(cause, secrets);
  return new Error(redactText(String(cause), secrets));
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
