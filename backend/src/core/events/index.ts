import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/index.js";

export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  source: string;
  payload: T;
}

export type EventHandler<T = unknown> = (event: EventEnvelope<T>) => void | Promise<void>;
export type Unsubscribe = () => void;

const VERSION_PATTERN = /\.v(\d+)$/;

export function eventVersion(type: string): number {
  const match = VERSION_PATTERN.exec(type);
  return match ? Number(match[1]) : 1;
}

/**
 * Event names must be namespaced (`<app_id>.<entity>.<action>.v<N>`).
 */
export function isValidEventType(type: string): boolean {
  return VERSION_PATTERN.test(type) && type.split(".").length >= 3;
}

/**
 * In-process typed pub/sub. Handlers run asynchronously and their errors are
 * isolated and logged; a failing subscriber never affects the publisher.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(private readonly log?: Logger) {}

  publish<T>(type: string, payload: T, source: string): void {
    if (!isValidEventType(type)) {
      // Programming error: fail fast so bad event names never spread.
      throw new TypeError(`invalid event type '${type}': expected <app_id>.<entity>.<action>.v<N>`);
    }
    const envelope: EventEnvelope<T> = {
      id: randomUUID(),
      type,
      version: eventVersion(type),
      occurredAt: new Date().toISOString(),
      source,
      payload,
    };

    const subscribers = this.handlers.get(type);
    if (!subscribers || subscribers.size === 0) return;

    for (const handler of [...subscribers]) {
      Promise.resolve()
        .then(() => handler(envelope))
        .catch((error: unknown) => {
          this.log?.error({ error, eventType: type }, "event subscriber failed");
        });
    }
  }

  subscribe<T = unknown>(type: string, handler: EventHandler<T>): Unsubscribe {
    let subscribers = this.handlers.get(type);
    if (!subscribers) {
      subscribers = new Set<EventHandler>();
      this.handlers.set(type, subscribers);
    }
    const typed = handler as EventHandler;
    subscribers.add(typed);
    return () => {
      subscribers.delete(typed);
    };
  }

  subscriberCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  close(): void {
    this.handlers.clear();
  }
}
