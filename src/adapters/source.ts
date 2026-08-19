import type { GhostEvent } from '../core/events.js';

/** Internal boundary for source integrations; public SDK stability comes later. */
export interface SourceAdapter<RawEvent> {
  readonly name: string;
  normalize(rawEvent: RawEvent): GhostEvent[];
}
