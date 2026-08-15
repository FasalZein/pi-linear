import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerLinearExtension } from './index';

export default function readonlyLinearExtension(pi: ExtensionAPI) {
  registerLinearExtension(pi, 'readonly');
}
