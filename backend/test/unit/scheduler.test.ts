import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../../src/core/scheduler/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Scheduler", () => {
  it("runs interval jobs repeatedly after start() and stop(id) halts them", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({
      id: "unit.interval",
      schedule: { intervalMs: 20 },
      run: async () => {
        ran += 1;
      },
    });

    scheduler.start();
    await delay(100);
    assert.ok(ran >= 3, `expected at least 3 runs within 100ms, got ${ran}`);

    scheduler.stop("unit.interval");
    const afterStop = ran;
    await delay(60);
    assert.equal(ran, afterStop, "interval job must not run after stop(id)");
  });

  it("runs a onceAfterMs job exactly once", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({
      id: "unit.once",
      schedule: { onceAfterMs: 30 },
      run: async () => {
        ran += 1;
      },
    });

    scheduler.start();
    await delay(100);
    assert.equal(ran, 1, "one-shot job must run exactly once");
  });

  it("does not run a onceAfterMs job that is stopped before it fires", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    const handle = scheduler.register({
      id: "unit.once.stopped",
      schedule: { onceAfterMs: 40 },
      run: async () => {
        ran += 1;
      },
    });

    scheduler.start();
    await delay(10);
    handle.stop();
    await delay(90);
    assert.equal(ran, 0, "a stopped one-shot job must never run");
  });

  it("keeps jobs idle until start() is called", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({
      id: "unit.lazy",
      schedule: { intervalMs: 20 },
      run: async () => {
        ran += 1;
      },
    });

    await delay(60);
    assert.equal(ran, 0, "job must not run before start()");

    scheduler.start();
    await delay(70);
    assert.ok(ran >= 2, `expected runs after start(), got ${ran}`);
    scheduler.stopAll();
  });

  it("reports running job ids and clears them on stopAll()", () => {
    const scheduler = new Scheduler();
    scheduler.register({
      id: "unit.a",
      schedule: { intervalMs: 1000 },
      run: async () => undefined,
    });
    scheduler.register({
      id: "unit.b",
      schedule: { onceAfterMs: 1000 },
      run: async () => undefined,
    });

    scheduler.start();
    assert.deepEqual([...scheduler.runningJobIds()].sort(), ["unit.a", "unit.b"]);

    scheduler.stopAll();
    assert.deepEqual(scheduler.runningJobIds(), []);
  });

  it("a throwing job does not crash the scheduler or block other jobs", async () => {
    const scheduler = new Scheduler();
    let good = 0;
    scheduler.register({
      id: "unit.bad",
      schedule: { intervalMs: 20 },
      run: async () => {
        throw new Error("job exploded");
      },
    });
    scheduler.register({
      id: "unit.good",
      schedule: { intervalMs: 20 },
      run: async () => {
        good += 1;
      },
    });

    scheduler.start();
    await delay(80);
    scheduler.stopAll();

    assert.ok(good >= 2, `healthy job must keep running, ran ${good} times`);
  });

  it("fires a seconds-based cron job within 1.2s and handle.stop() stops it", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    const handle = scheduler.register({
      id: "unit.cron",
      schedule: { cron: "* * * * * *" },
      run: async () => {
        ran += 1;
      },
    });

    scheduler.start();
    await delay(1200);
    assert.ok(ran >= 1, `cron job should fire at least once within 1.2s, got ${ran}`);

    handle.stop();
    const afterStop = ran;
    await delay(1300);
    assert.equal(ran, afterStop, "cron job must not run after handle.stop()");
  });

  it("scheduler.stop(id) stops a cron job as well", async () => {
    const scheduler = new Scheduler();
    let ran = 0;
    scheduler.register({
      id: "unit.cron.stop",
      schedule: { cron: "* * * * * *" },
      run: async () => {
        ran += 1;
      },
    });

    scheduler.start();
    await delay(1200);
    assert.ok(ran >= 1, `cron job should fire at least once within 1.2s, got ${ran}`);

    scheduler.stop("unit.cron.stop");
    const afterStop = ran;
    await delay(1300);
    assert.equal(ran, afterStop, "cron job must not run after scheduler.stop(id)");
  });
});
