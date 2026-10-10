/**
 * The state of the organize dialog (OrganizeDialog.tsx), kept apart from the dialog so that it outlives
 * it: closing the dialog does not stop the job that makes a proposal, and the proposal (with what the
 * user changed in it) is there when the dialog is opened again, from the toast that tells it is ready
 * or from another entry point. Not saved: a proposal is only good until the library changes.
 */
import { create } from "zustand";
import type { Usage } from "@/lib/usage";
import type { OrganizeDraft } from "./organizePlan";

/** What to organize: the papers directly in folder `source` ("" for 未分類), or the papers `paperIds`. */
export type OrganizeTarget = {
  source: string;
  /** Null: the folder's own papers. */
  paperIds: string[] | null;
};

export type OrganizeOutcome = { kind: "failed" | "cancelled"; message: string };

export type OrganizeState = {
  open: boolean;
  /** What the user chose, which the folder menu of the first step changes. */
  target: OrganizeTarget;
  /** The instruction of the proposal (the first step's text), sent again with each revision. */
  instruction: string;
  /** The additional instruction of the next revision (「作り直す」). */
  feedback: string;
  /** What the proposal in `draft` was made for (the source resolved for a selection of papers). */
  requested: OrganizeTarget | null;
  draft: OrganizeDraft | null;
  usage: Usage | null;
  /** From the request that starts the job until it ends. */
  busy: boolean;
  /** The job making a proposal, once the request that started it was answered. */
  jobId: string | null;
  applying: boolean;
  /** Applying was refused because a paper's folder had changed (collection_changed): the proposal is stale. */
  conflict: boolean;
  /** How the last job ended, when it made no proposal. */
  outcome: OrganizeOutcome | null;
};

export const INITIAL_TARGET: OrganizeTarget = { source: "", paperIds: null };

export const useOrganize = create<OrganizeState>(() => ({
  open: false,
  target: INITIAL_TARGET,
  instruction: "",
  feedback: "",
  requested: null,
  draft: null,
  usage: null,
  busy: false,
  jobId: null,
  applying: false,
  conflict: false,
  outcome: null,
}));
