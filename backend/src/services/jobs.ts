/**
 * Observable background job runner. Jobs are idempotent, retryable up to a
 * bounded number of attempts, and visible through /api/system/jobs. When Redis
 * + BullMQ credentials are configured the same API surface can be backed by
 * BullMQ; this in-process runner keeps development and small deployments
 * dependency-free.
 */
import { createJob, updateJob, getJob, listJobs } from '../data/system';

type JobFn = (params: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

const handlers: Record<string, JobFn> = {};

export function registerJob(type: string, fn: JobFn): void {
  handlers[type] = fn;
}

export async function enqueueJob(type: string, params: Record<string, unknown>, opts?: { fieldId?: string; maxAttempts?: number }): Promise<string> {
  const job = await createJob({ type, fieldId: opts?.fieldId, params, maxAttempts: opts?.maxAttempts || 3 });
  runJob(job.id).catch((e) => console.error(`Job ${job.id} runner error:`, e.message));
  return job.id;
}

async function runJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job || !['PENDING', 'FAILED'].includes(job.status)) return;
  const handler = handlers[job.type];
  if (!handler) {
    await updateJob(jobId, { status: 'FAILED', error: `No handler registered for job type "${job.type}"` });
    return;
  }
  await updateJob(jobId, { status: 'RUNNING', attempts: job.attempts + 1 });
  try {
    const result = await handler(job.params || {});
    await updateJob(jobId, { status: 'COMPLETED', result: (result as Record<string, unknown>) || {} });
  } catch (e: any) {
    const attempts = job.attempts + 1;
    if (attempts >= (job.max_attempts || 3)) {
      await updateJob(jobId, { status: 'FAILED', error: e.message });
    } else {
      await updateJob(jobId, { status: 'FAILED', error: e.message });
      // bounded retry with backoff
      const delay = Math.min(500 * 2 ** attempts, 8000);
      setTimeout(() => runJob(jobId).catch(() => {}), delay);
    }
  }
}

export function jobList(limit?: number): Promise<any[]> {
  return listJobs(limit);
}

export function jobById(id: string): Promise<any | null> {
  return getJob(id);
}
