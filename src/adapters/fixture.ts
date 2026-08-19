import { deriveTrustClass, ghostEventTypes, parseGhostEvent } from '../core/events.js';
import type { GhostEvent, GhostEventType } from '../core/events.js';

import type { SourceAdapter } from './source.js';

/** Replays canonical event fixtures without requiring a live agent installation. */
export class FixtureAdapter implements SourceAdapter<unknown> {
  public readonly name = 'fixture';

  public normalize(rawEvent: unknown): GhostEvent[] {
    if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) {
      return [parseGhostEvent(rawEvent)];
    }

    const record = rawEvent as Record<string, unknown>;
    if (record['trustClass'] !== undefined) {
      return [parseGhostEvent(record)];
    }

    const type = record['type'];
    if (typeof type !== 'string' || !ghostEventTypes.includes(type as GhostEventType)) {
      return [parseGhostEvent(record)];
    }

    return [parseGhostEvent({ ...record, trustClass: deriveTrustClass(type as GhostEventType) })];
  }

  public replay(rawEvents: Iterable<unknown>): GhostEvent[] {
    return [...rawEvents].flatMap((rawEvent) => this.normalize(rawEvent));
  }
}
