import { randomToken } from "../remote/crypto.js";
import { YouTubeMcpError } from "../errors/types.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import { sanitizeMessage } from "../errors/sanitize.js";

/**
 * Background upload jobs. Uploading a large video can take longer than a chat tool call is
 * allowed to run, so `youtube_video_upload` returns a job id immediately and the chat polls
 * `youtube_upload_status`. Jobs are kept in memory (single instance); a restart drops them.
 */

export type JobStatus = "queued" | "downloading" | "uploading" | "done" | "failed";

export interface UploadJob {
  id: string;
  owner: string;
  title: string;
  sourceHost: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  bytesTransferred: number;
  bytesTotal?: number;
  video?: Record<string, unknown>;
  warnings: string[];
  error?: { code: string; message: string };
}

export interface JobControl {
  setStatus(status: JobStatus): void;
  setTotal(bytes: number | undefined): void;
  setBytes(bytes: number): void;
  warn(message: string): void;
}

export type JobRunner = (ctl: JobControl) => Promise<Record<string, unknown>>;

export class UploadJobManager {
  private readonly jobs = new Map<string, UploadJob>();
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;

  constructor(
    private readonly opts: { maxConcurrent?: number; retainMs?: number; maxPerOwner?: number } = {}
  ) {}

  submit(owner: string, meta: { title: string; sourceHost: string }, runner: JobRunner): UploadJob {
    this.purge();
    const active = [...this.jobs.values()].filter(
      (j) => j.owner === owner && (j.status === "queued" || j.status === "downloading" || j.status === "uploading")
    );
    if (active.length >= (this.opts.maxPerOwner ?? 5)) {
      throw new YouTubeMcpError(
        YouTubeMcpErrorCode.RATE_LIMITED,
        "Too many uploads are already in progress. Wait for them to finish (youtube_upload_status).",
        { retryable: true }
      );
    }
    const now = Date.now();
    const job: UploadJob = {
      id: randomToken(9),
      owner,
      title: meta.title,
      sourceHost: meta.sourceHost,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      bytesTransferred: 0,
      warnings: [],
    };
    this.jobs.set(job.id, job);

    const touch = (): void => {
      job.updatedAt = Date.now();
    };
    const ctl: JobControl = {
      setStatus: (s) => {
        job.status = s;
        touch();
      },
      setTotal: (b) => {
        job.bytesTotal = b;
        touch();
      },
      setBytes: (b) => {
        job.bytesTransferred = b;
        touch();
      },
      warn: (m) => {
        job.warnings.push(m);
        touch();
      },
    };

    this.queue.push(async () => {
      try {
        job.video = await runner(ctl);
        job.status = "done";
      } catch (err) {
        job.status = "failed";
        const e = err instanceof YouTubeMcpError ? err : undefined;
        job.error = {
          code: e?.code ?? YouTubeMcpErrorCode.VIDEO_UPLOAD_FAILED,
          message: sanitizeMessage(err instanceof Error ? err.message : String(err)),
        };
      } finally {
        touch();
      }
    });
    this.pump();
    return job;
  }

  get(owner: string, id: string): UploadJob | undefined {
    const job = this.jobs.get(id);
    return job && job.owner === owner ? job : undefined;
  }

  list(owner: string): UploadJob[] {
    this.purge();
    return [...this.jobs.values()]
      .filter((j) => j.owner === owner)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);
  }

  private pump(): void {
    const max = this.opts.maxConcurrent ?? 2;
    while (this.running < max && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running++;
      void next().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private purge(): void {
    const cutoff = Date.now() - (this.opts.retainMs ?? 24 * 3600_000);
    for (const [id, j] of this.jobs) {
      if ((j.status === "done" || j.status === "failed") && j.updatedAt < cutoff) this.jobs.delete(id);
    }
  }
}

export const uploadJobs = new UploadJobManager();
