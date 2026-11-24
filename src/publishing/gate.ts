import { config } from "../config.js";
import { getPrincipal } from "../auth/context.js";
import { approvals, type ApprovalSnapshot, type PublishAction } from "./approvals.js";

/**
 * The single choke point for "make a video visible" operations.
 *
 *  - Remote mode: requires an approval that the owner granted on the approval web page.
 *  - Local stdio mode (no web server): requires `confirmPublish: true`, which the tool
 *    description tells the assistant to pass only after the user said yes.
 */

export interface GateInput {
  action: PublishAction;
  approvalId?: string;
  confirmPublish?: boolean;
  /** Looked up lazily, only when a new approval has to be created. */
  snapshot: () => Promise<ApprovalSnapshot>;
}

export type GateResult =
  | { allowed: true; onFailure: () => void }
  | { allowed: false; response: Record<string, unknown> };

export function approvalUrl(id: string): string {
  return `${config.publicUrl ?? ""}/approve/${id}`;
}

function describe(action: PublishAction, title?: string): string {
  const name = title ? `"${title}" (${action.videoId})` : action.videoId;
  if (action.kind === "schedule") return `Schedule video ${name} to become PUBLIC at ${action.publishAt}`;
  return action.privacyStatus === "public"
    ? `Make video ${name} PUBLIC`
    : `Make video ${name} UNLISTED (anyone with the link can watch)`;
}

export async function evaluatePublishGate(input: GateInput): Promise<GateResult> {
  const principal = getPrincipal();

  if (!principal) {
    if (input.confirmPublish === true) return { allowed: true, onFailure: () => undefined };
    return {
      allowed: false,
      response: {
        success: false,
        status: "confirmation_required",
        summary: describe(input.action),
        message:
          "Nothing was changed. Publishing requires the user's explicit confirmation. Ask the user; if they agree, repeat this call with confirmPublish: true.",
      },
    };
  }

  if (!input.approvalId) {
    const snapshot = await input.snapshot();
    const approval = approvals.create(principal.sub, input.action, snapshot);
    return {
      allowed: false,
      response: {
        success: true,
        status: "approval_required",
        approvalId: approval.id,
        approvalUrl: approvalUrl(approval.id),
        expiresAt: new Date(approval.expiresAt).toISOString(),
        summary: describe(input.action, snapshot.videoTitle),
        instructionsForAssistant:
          "STOP. Nothing has been published or changed. Show the user the summary and the approvalUrl link, and ask them to open the link and tap 'Approve'. Do NOT call this tool again until the user tells you they approved. After that, call this tool again with exactly the same parameters plus approvalId.",
      },
    };
  }

  const claim = approvals.claim(input.approvalId, principal.sub, input.action);
  if (claim.ok) {
    const id = input.approvalId;
    return { allowed: true, onFailure: () => approvals.release(id) };
  }

  const existing = approvals.get(input.approvalId);
  switch (claim.reason) {
    case "not_approved":
      return {
        allowed: false,
        response: {
          success: false,
          status: "awaiting_user_approval",
          approvalUrl: approvalUrl(input.approvalId),
          message:
            "The user has not approved yet. Nothing was changed. Ask the user to open the approvalUrl link and tap 'Approve', then try again.",
        },
      };
    case "rejected":
      return {
        allowed: false,
        response: { success: false, status: "rejected_by_user", message: "The user cancelled this action. Nothing was changed." },
      };
    case "mismatch":
      return {
        allowed: false,
        response: {
          success: false,
          status: "approval_mismatch",
          message:
            "This approval was granted for a different action (or video). Nothing was changed. Request a new approval for the action the user wants.",
        },
      };
    default:
      return {
        allowed: false,
        response: {
          success: false,
          status: existing ? "approval_used" : "approval_expired",
          message:
            "This approval is expired, unknown or already used. Nothing was changed. Call this tool without approvalId to request a new one.",
        },
      };
  }
}
