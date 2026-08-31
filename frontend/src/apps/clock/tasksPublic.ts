import { ApiError, api } from "../../shared/api";

/**
 * Typed client for the Tasks public status contract
 * (`GET /api/apps/tasks/public/status`, see apps/tasks/README.md). This is the
 * only sanctioned cross-app data path: an HTTP contract, never table access
 * or imports from the Tasks app. The Tasks app being disabled surfaces as a
 * 404 from the platform lifecycle guard — mapped here to `null` so callers
 * can hide the task zone without an error state.
 */
export interface PublicTaskView {
  id: string;
  title: string;
  startAt: string;
}

export interface TasksPublicStatus {
  current: PublicTaskView | null;
  next: PublicTaskView | null;
  today: { remainingCount: number };
}

export const TASKS_STATUS_URL = "/api/apps/tasks/public/status";

/** null = Tasks app unavailable (disabled); other failures still throw. */
export async function fetchTasksPublicStatus(): Promise<TasksPublicStatus | null> {
  try {
    return await api<TasksPublicStatus>(TASKS_STATUS_URL);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
