import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../../src/core/scheduler/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Scheduler", () => {
  it("runs a one-shot job after start", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({ id: "test.once", schedule: { onceAfterMs: 10 }, run: async () => { ran += 1; } });
    scheduler.start();
    await delay(30);
    assert.equal(ran, 1);
    scheduler.stopAll();
  });

  it("runs an interval job repeatedly and stop() removes it", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({ id: "test.interval", schedule: { intervalMs: 10 }, run: async () => { ran += 1; } });
    scheduler.start();
    await delay(45);
    scheduler.stop("test.interval");
    const afterStop = ran;
    assert.ok(afterStop >= 2, "interval ran at least twice");
    await delay(30);
    assert.equal(ran, afterStop, "no further runs after stop");
    scheduler.stopAll();
  });

  it("does not run registered jobs before start()", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({ id: "test.once", schedule: { onceAfterMs: 5 }, run: async () => { ran += 1; } });
    await delay(20);
    assert.equal(ran, 0, "job must not run until started");
    scheduler.start();
    await delay(20);
    assert.equal(ran, 1);
    scheduler.stopAll();
  });

  it("tracks running job ids", () => {
    const scheduler = new Scheduler();
    scheduler.register({ id: "tasks.overdue_check", schedule: { cron: "0 0 * * *" }, run: async () => undefined });
    assert.deepEqual(scheduler.runningJobIds(), ["tasks.overdue_check"]);
    scheduler.stop("tasks.overdue_check");
    assert.deepEqual(scheduler.runningJobIds(), []);
  });
});
