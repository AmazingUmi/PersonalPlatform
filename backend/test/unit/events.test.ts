import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EventBus,
  eventVersion,
  isValidEventType,
  type EventEnvelope,
} from "../../src/core/events/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("eventVersion", () => {
  it("parses the trailing .vN suffix", () => {
    assert.equal(eventVersion("tasks.task.completed.v1"), 1);
    assert.equal(eventVersion("a.b.c.v12"), 12);
  });

  it("defaults to 1 when the type has no version suffix", () => {
    assert.equal(eventVersion("tasks.task.completed"), 1);
  });
});

describe("isValidEventType", () => {
  it("accepts namespaced types with a version suffix", () => {
    assert.equal(isValidEventType("a.b.c.v1"), true);
    assert.equal(isValidEventType("a.b.c.v12"), true);
    assert.equal(isValidEventType("assets.item.created.v1"), true);
  });

  it("rejects types without a version suffix", () => {
    assert.equal(isValidEventType("a.b"), false);
    assert.equal(isValidEventType("a.b.c"), false);
  });

  it("rejects types with too few segments or empty names", () => {
    assert.equal(isValidEventType("no-dots.v1"), false);
    assert.equal(isValidEventType(""), false);
  });
});

describe("EventBus", () => {
  it("publishing with no subscribers does not throw", () => {
    const bus = new EventBus();
    assert.doesNotThrow(() => bus.publish("a.b.c.v1", { ok: true }, "unit-test"));
  });

  it("subscribers receive a complete envelope", async () => {
    const bus = new EventBus();
    const seen: Array<EventEnvelope<{ k: number }>> = [];
    bus.subscribe<{ k: number }>("app.entity.action.v3", (event) => {
      seen.push(event);
    });

    bus.publish("app.entity.action.v3", { k: 1 }, "unit-test");
    await tick();

    assert.equal(seen.length, 1);
    const envelope = seen[0]!;
    assert.match(envelope.id, UUID_RE, "envelope.id must be a UUID");
    assert.equal(envelope.type, "app.entity.action.v3");
    assert.equal(envelope.version, 3, "version is parsed from the trailing .vN");
    assert.ok(!Number.isNaN(Date.parse(envelope.occurredAt)), "occurredAt must parse as a date");
    assert.equal(
      new Date(envelope.occurredAt).toISOString(),
      envelope.occurredAt,
      "occurredAt must be an ISO string",
    );
    assert.equal(envelope.source, "unit-test");
    assert.deepEqual(envelope.payload, { k: 1 });
  });

  it("does not deliver to subscribers of other event types", async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe("a.b.c.v1", (event) => {
      seen.push(event.payload);
    });

    bus.publish("x.y.z.v1", { ok: true }, "unit-test");
    await tick();

    assert.equal(seen.length, 0);
  });

  it("publishing an invalid event type throws TypeError", () => {
    const bus = new EventBus();
    assert.throws(() => bus.publish("tasks.completed", { ok: true }, "unit-test"), TypeError);
  });

  it("a throwing subscriber does not affect the publisher or other subscribers", async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe("a.b.c.v1", () => {
      throw new Error("subscriber boom");
    });
    bus.subscribe("a.b.c.v1", (event) => {
      seen.push(event.payload);
    });

    assert.doesNotThrow(() => bus.publish("a.b.c.v1", { ok: true }, "unit-test"));
    await tick(10);

    assert.equal(seen.length, 1, "the healthy subscriber must still receive the event");
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    const unsubscribe = bus.subscribe("a.b.c.v1", (event) => {
      seen.push(event.payload);
    });

    unsubscribe();
    bus.publish("a.b.c.v1", { ok: true }, "unit-test");
    await tick();

    assert.equal(seen.length, 0);
  });

  it("close() clears all handlers", () => {
    const bus = new EventBus();
    bus.subscribe("a.b.c.v1", () => undefined);
    bus.subscribe("a.b.c.v1", () => undefined);
    assert.equal(bus.subscriberCount("a.b.c.v1"), 2);

    bus.close();
    assert.equal(bus.subscriberCount("a.b.c.v1"), 0);
  });
});
