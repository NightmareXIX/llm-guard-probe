import { create as createMockAdapter } from './mock.js';

// http and anthropic ship in Phase 4. Their names are still valid config
// values (see src/config.js) — only the factory is missing until then.
const registry = {
  mock: createMockAdapter,
};

export function createAdapter(config) {
  const factory = registry[config.adapter];
  if (!factory) {
    const available = Object.keys(registry).join(', ');
    throw new Error(`Adapter "${config.adapter}" is not available yet. Available now: ${available}.`);
  }
  return factory(config);
}
