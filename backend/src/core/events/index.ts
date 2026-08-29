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

/** The event surface an App receives: publishing and own subscriptions. */
export interface AppEventBus {
  publish<T>(type: string, payload: T, source: string): void;
  subscribe<T = unknown>(type: string, handler: EventHandler<T>): Unsubscribe;
}

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

interface Registration {
  handler: EventHandler;
  /** Owning app id; Core uses it to reclaim subscriptions (FP-9.1). */
  owner?: string;
}

/**
 * In-process typed pub/sub. Handlers run asynchronously and their errors are
 * isolated and logged; a failing subscriber never affects the publisher.
 *
 * Subscriptions registered through `subscribeFor(owner, ...)` are tracked by
 * owner so Core can reclaim them even when an app's registerEvents() threw
 * after subscribing and never returned its unsubscribe handles.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<Registration>>();

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

    for (const registration of [...subscribers]) {
      Promise.resolve()
        .then(() => registration.handler(envelope))
        .catch((error: unknown) => {
          this.log?.error({ error, eventType: type }, "event subscriber failed");
        });
    }
  }

  subscribe<T = unknown>(type: string, handler: EventHandler<T>): Unsubscribe {
    return this.subscribeFor(undefined, type, handler);
  }

  /** Subscribe with owner tracking; the App-scoped facade calls this. */
  subscribeFor<T = unknown>(owner: string | undefined, type: string, handler: EventHandler<T>): Unsubscribe {
    let subscribers = this.handlers.get(type);
    if (!subscribers) {
      subscribers = new Set<Registration>();
      this.handlers.set(type, subscribers);
    }
    const registration: Registration = { handler: handler as EventHandler, owner };
    subscribers.add(registration);
    return () => {
      subscribers.delete(registration);
    };
  }

  /** Remove every subscription owned by `owner`; returns how many were removed. */
  unsubscribeByOwner(owner: string): number {
    let removed = 0;
    for (const [type, subscribers] of this.handlers) {
      for (const registration of [...subscribers]) {
        if (registration.owner !== owner) continue;
        subscribers.delete(registration);
        removed += 1;
      }
      if (subscribers.size === 0) this.handlers.delete(type);
    }
    return removed;
  }

  subscriberCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  /** App-scoped facade: subscriptions are owner-tagged automatically (FP-9.1). */
  forApp(owner: string): AppEventBus {
    return {
      publish: (type, payload, source) => this.publish(type, payload, source),
      subscribe: (type, handler) => this.subscribeFor(owner, type, handler),
    };
  }

  close(): void {
    this.handlers.clear();
  }
}
