import type { MutationMode } from './safety';

export function assertLocalWriteAllowed(mode: MutationMode): void {
  if (mode === 'readonly' || process.env.LINEAR_READONLY === '1') {
    throw new Error('Local Linear credential writes are disabled by read-only mode.');
  }
}
