import { create as createMockAdapter } from './mock.js';
import { create as createHttpAdapter } from './http.js';
import { create as createAnthropicAdapter } from './anthropic.js';

const registry = {
  mock: createMockAdapter,
  http: createHttpAdapter,
  anthropic: createAnthropicAdapter,
};

export function createAdapter(config) {
  const factory = registry[config.adapter];
  if (!factory) {
    const available = Object.keys(registry).join(', ');
    throw new Error(`Adapter "${config.adapter}" is not available yet. Available now: ${available}.`);
  }
  return factory(config);
}
