/**
 * The shape of a Linear failure the caller reads.
 *
 * `renderResult` reaches the human only, so guidance placed there never arrives where the
 * correction has to happen. A failure therefore carries its recovery sentence on the line
 * after the message, and this module is the single definition of that split — the thrower,
 * the renderer, the smoke command, and the tests all read the format from here.
 */
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

/** The appended recovery sentence, or an empty string when the failure carries none. */
export function recoveryLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const split = message.lastIndexOf(SEPARATOR);
  return split < 0 ? '' : message.slice(split + 1).trim();
}
