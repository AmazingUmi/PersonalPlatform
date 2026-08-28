import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus, isValidEventType } from "../../src/core/events/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("EventBus", () => {
  it("delivers published events to matching subscribers", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe("assets.item.created.v1", (event) => {
      received.push(event.payload);
    });
    bus.publish("assets.item.created.v1", { id: "1" }, "assets");
    await tick();
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { id: "1" });
  });

  it("does not deliver to other event types", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe("assets.item.created.v1", (event) => {
      received.push(event.payload);
    });
    bus.publish("tasks.task.completed.v1", { id: "2" }, "tasks");
    await tick();
    assert.equal(received.length, 0);
  });

  it("unsubscribe stops future delivery", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe("a.b.c.v1", (event) => {
      received.push(event.payload);
    });
    unsubscribe();
    bus.publish("a.b.c.v1", { id: "1" }, "a");
    await tick();
    assert.equal(received.length, 0);
  });

  it("isolates a throwing subscriber from other subscribers", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe("a.b.c.v1", () => {
      throw new Error("boom");
    });
    bus.subscribe("a.b.c.v1", (event) => {
      received.push(event.payload);
    });
    bus.publish("a.b.c.v1", { ok: true }, "a");
    await tick();
    assert.equal(received.length, 1);
  });
});

describe("isValidEventType", () => {
  it("requires a namespace and a version suffix", () => {
    assert.equal(isValidEventType("assets.item.created.v1"), true);
    assert.equal(isValidEventType("created.v1"), false);
    assert.equal(isValidEventType("assets.item.created"), false);
  });
});
