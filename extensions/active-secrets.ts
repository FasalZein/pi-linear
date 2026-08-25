/**
 * Active Linear secrets, collected without prompting and without network access.
 * Reading stays synchronous because renderers redact synchronously.
 */
import { credentialStore } from './credential-store';

/** Environment key plus every saved Workspace key. Never prompts, writes, locks, or throws. */
export function activeSecrets(): string[] {
  return credentialStore.secrets();
}
