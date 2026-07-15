// frontend/src/visualizations/Visualization.ts
// Abstract base class for all client-side visualizations. Concrete subclasses
// (e.g. D3 RelationsGraph) implement the lifecycle: mount into a container,
// update with data, and destroy/teardown. This gives a uniform seam so the
// app can swap visualization implementations behind the registry.

import type { VisualizationOptions } from './types';

export interface VisualizationContainer {
  /** The host element the visualization renders into. */
  el: HTMLElement;
}

export abstract class Visualization<TData = unknown> {
  protected container: HTMLElement;
  protected options: VisualizationOptions;
  protected disposed = false;

  constructor(container: HTMLElement, options: VisualizationOptions = {}) {
    this.container = container;
    this.options = {
      width: options.width ?? (container.clientWidth || 600),
      height: options.height ?? 360,
      background: options.background ?? '#0b1220',
    };
  }

  /** Mount the visualization shell (e.g. create the SVG) into the container. */
  abstract mount(): void;

  /** Render/update with the given data model. */
  abstract update(data: TData): void;

  /** Tear down any DOM/listeners and mark disposed. Idempotent. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getOptions(): VisualizationOptions {
    return { ...this.options };
  }
}
