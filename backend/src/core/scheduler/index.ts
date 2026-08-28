import cron from "node-cron";
import type { Logger } from "../logging/index.js";

export type JobSchedule =
  | { cron: string }
  | { intervalMs: number }
  | { onceAt: Date }
  | { onceAfterMs: number };

export interface JobSpec {
  /** Stable id, conventionally `<app_id>.<job>`. */
  id: string;
  schedule: JobSchedule;
  run: () => Promise<void>;
}

export interface JobHandle {
  id: string;
  stop(): void;
}

interface InternalHandle {
  id: string;
  started: boolean;
  start(): void;
  stop(): void;
}

/**
 * Single-process scheduler supporting cron, fixed intervals and one-shot jobs.
 * v0.1 runs inside one backend process so it needs no distributed lock.
 */
export class Scheduler {
  private readonly jobs = new Map<string, InternalHandle>();
  private started = false;

  constructor(private readonly log?: Logger) {}

  register(spec: JobSpec): JobHandle {
    const handle = this.createHandle(spec);
    this.jobs.set(spec.id, handle);
    if (this.started) handle.start();
    return { id: spec.id, stop: () => this.stop(spec.id) };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const handle of this.jobs.values()) handle.start();
  }

  stop(id: string): void {
    const handle = this.jobs.get(id);
    if (handle) {
      handle.stop();
      this.jobs.delete(id);
    }
  }

  stopAll(): void {
    for (const handle of this.jobs.values()) handle.stop();
    this.jobs.clear();
    this.started = false;
  }

  runningJobIds(): string[] {
    return [...this.jobs.keys()];
  }

  private createHandle(spec: JobSpec): InternalHandle {
    const run = () => {
      Promise.resolve()
        .then(() => spec.run())
        .catch((error: unknown) => {
          this.log?.error({ error, jobId: spec.id }, "scheduled job failed");
        });
    };

    const schedule = spec.schedule;
    if ("cron" in schedule) {
      const task = cron.createTask(schedule.cron, () => run(), { name: spec.id });
      return {
        id: spec.id,
        started: false,
        start: () => {
          void task.start();
        },
        stop: () => {
          void task.stop();
          task.destroy();
        },
      };
    }

    if ("intervalMs" in schedule) {
      let timer: NodeJS.Timeout | undefined;
      return {
        id: spec.id,
        started: false,
        start: () => {
          if (!timer) timer = setInterval(run, schedule.intervalMs);
        },
        stop: () => {
          if (timer) clearInterval(timer);
          timer = undefined;
        },
      };
    }

    if ("onceAt" in schedule) {
      const delay = Math.max(0, schedule.onceAt.getTime() - Date.now());
      let timer: NodeJS.Timeout | undefined;
      return {
        id: spec.id,
        started: false,
        start: () => {
          if (!timer) timer = setTimeout(run, delay);
        },
        stop: () => {
          if (timer) clearTimeout(timer);
          timer = undefined;
        },
      };
    }

    let timer: NodeJS.Timeout | undefined;
    return {
      id: spec.id,
      started: false,
      start: () => {
        if (!timer) timer = setTimeout(run, schedule.onceAfterMs);
      },
      stop: () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      },
    };
  }
}
