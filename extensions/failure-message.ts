/**
 * The shape of a Linear failure the caller reads.
 *
 * `renderResult` reaches the human only, so guidance placed there never arrives where the
 * correction has to happen. A failure therefore carries its recovery sentence on the line
 * after the message, and this module is the single definition of that split — the thrower,
 * the renderer, the smoke command, and the tests all read the format from here.
 */
import type { TLocalizedValidationError } from 'typebox/error';

const SEPARATOR = '\n';

/** Compose a failure a caller can act on: what failed, then what to do about it. */
export function withRecovery(message: string, recovery: string): string {
  return `${message}${SEPARATOR}${recovery}`;
}

/** The failure itself, with any appended recovery sentence removed. */
export function failureLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const split = message.lastIndexOf(SEPARATOR);
  return split < 0 ? message : message.slice(0, split);
}

/**
 * Summarise schema failures, naming the field each one came from.
 *
 * The validator reports AJV-shaped errors that carry their location in `instancePath`
 * (`/reads`, `/operations/0/operation`). Both guards read a `path` key instead, which no
 * error has, so every failure named a broken constraint and never the field that broke it —
 * a caller reading "must be array" had no way to know which field was meant.
 */
export function schemaProblems(errors: Iterable<SchemaError>, limit = 3): string {
  return [...errors]
    .slice(0, limit)
    .map((error) => {
      const field = [fieldName(error.instancePath), offendingProperties(error)].filter(Boolean).join('.');
      return field ? `${field}: ${error.message}` : error.message;
    })
    .join('; ');
}

/** Exactly what a compiled TypeBox validator reports, so no shape is invented here. */
export type SchemaError = TLocalizedValidationError;

/**
 * "must not have additional properties" names no property, and the caller cannot guess
 * which of the ones it sent is unwanted. The validator knows; report it.
 *
 * `keyword` discriminates the error union, so the property list is typed once selected.
 */
function offendingProperties(error: SchemaError): string {
  return error.keyword === 'additionalProperties' ? error.params.additionalProperties.join(', ') : '';
}

/** `/operations/0/operation` reads back as `operations[0].operation`. */
function fieldName(instancePath: string): string {
  return instancePath
    .split('/')
    .filter(Boolean)
    .reduce((path, part) => (/^\d+$/.test(part) ? `${path}[${part}]` : path ? `${path}.${part}` : part), '');
}

/** The appended recovery sentence, or an empty string when the failure carries none. */
export function recoveryLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const split = message.lastIndexOf(SEPARATOR);
  return split < 0 ? '' : message.slice(split + 1).trim();
}
