// Vitest setup: register jest-dom matchers for DOM assertions.
import '@testing-library/jest-dom/vitest';

// jsdom lacks ResizeObserver (used by PriceChart for responsive width).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error assign stub onto global
globalThis.ResizeObserver = ResizeObserverStub;

// jsdom getBoundingClientRect returns zeros; give elements a default width so
// chart components can derive a sane SVG width in tests.
if (!Element.prototype.getBoundingClientRect) {
  // @ts-expect-error assign shim
  Element.prototype.getBoundingClientRect = () => ({ width: 800, height: 360, top: 0, left: 0, right: 800, bottom: 360, x: 0, y: 0, toJSON: () => ({}) });
}
