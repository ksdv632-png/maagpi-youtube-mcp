import { randomToken } from "../remote/crypto.js";

/**
 * Out-of-band human approval for anything that makes a video visible to other people.
 *
 * The assistant can only *request* approval. The owner approves by opening a one-time link
 * (served by this same server) and pressing a button — something a model, or text injected
 * into a prompt, cannot do from inside the MCP connection. Only after that will the
 * publishing tool run. Approvals live in memory (single instance) and expire quickly.
 */

export type PublishAction =
  | { kind: "set_privacy"; videoId: string; privacyStatus: "public" | "unlisted" }
  | { kind: "schedule"; videoId: string; publishAt: string };

export interface ApprovalSnapshot {
  videoTitle?: string;
  thumbnailUrl?: string;
  currentPrivacy?: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface Approval {
  id: string;
  principalSub: string;
  action: PublishAction;
  snapshot: ApprovalSnapshot;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_approved" | "rejected" | "expired" | "mismatch" | "consumed" };

export function sameAction(a: PublishAction, b: PublishAction): boolean {
  if (a.kind !== b.kind || a.videoId !== b.videoId) return false;
  if (a.kind === "set_privacy" && b.kind === "set_privacy") return a.privacyStatus === b.privacyStatus;
  if (a.kind === "schedule" && b.kind === "schedule") {
    return new Date(a.publishAt).getTime() === new Date(b.publishAt).getTime();
  }
  return false;
}

export class ApprovalStore {
  private readonly items = new Map<string, Approval>();

  constructor(
    private readonly opts: { ttlMs?: number; maxPerPrincipal?: number; now?: () => number } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private purge(): void {
    const t = this.now();
    for (const [id, a] of this.items) if (a.expiresAt <= t) this.items.delete(id);
  }

  create(principalSub: string, action: PublishAction, snapshot: ApprovalSnapshot): Approval {
    this.purge();
    const max = this.opts.maxPerPrincipal ?? 20;
    const mine = [...this.items.values()].filter((a) => a.principalSub === principalSub);
    if (mine.length >= max) {
      const oldest = mine.sort((x, y) => x.createdAt - y.createdAt)[0];
      if (oldest) this.items.delete(oldest.id);
    }
    const createdAt = this.now();
    const approval: Approval = {
      id: randomToken(32),
      principalSub,
      action,
      snapshot,
      status: "pending",
      createdAt,
      expiresAt: createdAt + (this.opts.ttlMs ?? 30 * 60_000),
    };
    this.items.set(approval.id, approval);
    return approval;
  }

  get(id: string): Approval | undefined {
    this.purge();
    return this.items.get(id);
  }

  /** Called by the approval web page. Only a pending approval can be decided. */
  decide(id: string, decision: "approve" | "reject"): Approval | undefined {
    const a = this.get(id);
    if (!a || a.status !== "pending") return undefined;
    a.status = decision === "approve" ? "approved" : "rejected";
    return a;
  }

  /** Called by the publishing tool: atomically uses up an approved approval. */
  claim(id: string, principalSub: string, action: PublishAction): ClaimResult {
    const a = this.items.get(id);
    if (!a) return { ok: false, reason: "not_found" };
    if (a.expiresAt <= this.now()) {
      this.items.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (a.principalSub !== principalSub || !sameAction(a.action, action)) return { ok: false, reason: "mismatch" };
    if (a.status === "pending") return { ok: false, reason: "not_approved" };
    if (a.status === "rejected") return { ok: false, reason: "rejected" };
    if (a.status === "consumed") return { ok: false, reason: "consumed" };
    a.status = "consumed";
    return { ok: true };
  }

  /** Re-open a claimed approval when the YouTube call failed, so the owner need not approve twice. */
  release(id: string): void {
    const a = this.items.get(id);
    if (a && a.status === "consumed" && a.expiresAt > this.now()) a.status = "approved";
  }

  size(): number {
    this.purge();
    return this.items.size;
  }
}

export const approvals = new ApprovalStore();
