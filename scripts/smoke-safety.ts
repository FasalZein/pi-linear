import { parseJson } from '../extensions/json';

export function assertNoCredentialLeak(cause: unknown, activeSecret: string): void {
  const text = JSON.stringify(parseJson(cause) ?? null);
  if (
    (activeSecret && text.includes(activeSecret))
    || /lin_(?:api|oauth)_[A-Za-z0-9_-]+/.test(text)
  ) {
    throw new Error('model-visible output contained an active secret or known token form');
  }
}
