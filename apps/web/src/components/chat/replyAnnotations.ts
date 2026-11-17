import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AssistantCitation, type ScopedThreadRef } from "@t3tools/contracts";
import { withAssistantCitationComment } from "@t3tools/shared/assistantCitations";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { DraftId } from "~/composerDraftStore";
import { resolveStorage } from "~/lib/storage";
import { randomUUID } from "~/lib/utils";
import { appendAnnotationCitations, sentAnnotationCitations } from "./replyAnnotations.logic";

export interface ReplyAnnotation {
  readonly id: string;
  readonly citation: AssistantCitation;
}

type Target = ScopedThreadRef | DraftId;

// Same key as `composerTargetKey`; importing it would make composerDraftStore and this module a cycle.
const targetKey = (target: Target) =>
  typeof target === "string" ? target.trim() : scopedThreadKey(target);

interface ReplyAnnotationsState {
  byTarget: Record<string, ReadonlyArray<ReplyAnnotation>>;
  /** The annotation whose comment box is open; not persisted. */
  editingId: string | null;
}

const isCitation = Schema.is(AssistantCitation);
const isAnnotation = (value: unknown): value is ReplyAnnotation => {
  const annotation = value as ReplyAnnotation | null;
  return typeof annotation?.id === "string" && isCitation(annotation.citation);
};

const useReplyAnnotationsStore = create<ReplyAnnotationsState>()(
  persist((): ReplyAnnotationsState => ({ byTarget: {}, editingId: null }), {
    name: "1001code:reply-annotations:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    version: 1,
    migrate: (persisted) => {
      const byTarget: Record<string, ReadonlyArray<ReplyAnnotation>> = {};
      const stored = (persisted as Partial<ReplyAnnotationsState> | null)?.byTarget ?? {};
      for (const [key, annotations] of Object.entries(stored)) {
        const valid = Array.isArray(annotations) ? annotations.filter(isAnnotation) : [];
        if (valid.length > 0) byTarget[key] = valid;
      }
      return { byTarget, editingId: null };
    },
    partialize: ({ byTarget }) => ({ byTarget }),
  }),
);

const EMPTY: ReadonlyArray<ReplyAnnotation> = [];

function write(
  target: Target,
  update: (current: ReadonlyArray<ReplyAnnotation>) => ReadonlyArray<ReplyAnnotation>,
) {
  const key = targetKey(target);
  useReplyAnnotationsStore.setState((state) => {
    const current = state.byTarget[key] ?? EMPTY;
    const next = update(current);
    if (next === current) return state;
    const { [key]: _previous, ...rest } = state.byTarget;
    return { byTarget: next.length > 0 ? { ...rest, [key]: next } : rest };
  });
}

const sameRange = (left: AssistantCitation, right: AssistantCitation) =>
  left.messageId === right.messageId && left.start === right.start && left.end === right.end;

export function useReplyAnnotations(target: Target): ReadonlyArray<ReplyAnnotation> {
  return useReplyAnnotationsStore((state) => state.byTarget[targetKey(target)] ?? EMPTY);
}

export function readReplyAnnotations(target: Target): ReadonlyArray<ReplyAnnotation> {
  return useReplyAnnotationsStore.getState().byTarget[targetKey(target)] ?? EMPTY;
}

/** Citing the same range again returns the existing annotation instead of adding a copy. */
export function addReplyAnnotation(target: Target, citation: AssistantCitation): string {
  const existing = readReplyAnnotations(target).find((annotation) =>
    sameRange(annotation.citation, citation),
  );
  if (existing) return existing.id;
  const id = randomUUID();
  write(target, (current) => [...current, { id, citation }]);
  return id;
}

function writeById(
  id: string,
  update: (current: ReadonlyArray<ReplyAnnotation>) => ReadonlyArray<ReplyAnnotation>,
) {
  useReplyAnnotationsStore.setState((state) => {
    const key = Object.keys(state.byTarget).find((candidate) =>
      state.byTarget[candidate]!.some((annotation) => annotation.id === id),
    );
    if (key === undefined) return state;
    const { [key]: current, ...rest } = state.byTarget;
    const next = update(current!);
    return { byTarget: next.length > 0 ? { ...rest, [key]: next } : rest };
  });
}

export function removeReplyAnnotation(id: string): void {
  writeById(id, (current) => current.filter((annotation) => annotation.id !== id));
  if (useReplyAnnotationsStore.getState().editingId === id) editReplyAnnotation(null);
}

export function setReplyAnnotationComment(id: string, comment: string): void {
  writeById(id, (current) =>
    current.map((annotation) =>
      annotation.id === id
        ? { ...annotation, citation: withAssistantCitationComment(annotation.citation, comment) }
        : annotation,
    ),
  );
}

export function editReplyAnnotation(id: string | null): void {
  useReplyAnnotationsStore.setState({ editingId: id });
}

export function useEditingReplyAnnotationId(): string | null {
  return useReplyAnnotationsStore((state) => state.editingId);
}

export interface NumberedReplyAnnotation extends ReplyAnnotation {
  readonly number: number;
}

/** Every drafted annotation on this thread's replies, numbered as its composer lists it. */
export function useThreadReplyAnnotations(
  threadRef: ScopedThreadRef,
): ReadonlyArray<NumberedReplyAnnotation> {
  const byTarget = useReplyAnnotationsStore((state) => state.byTarget);
  return Object.values(byTarget).flatMap((annotations) =>
    annotations.flatMap((annotation, index) =>
      annotation.citation.environmentId === threadRef.environmentId &&
      annotation.citation.threadId === threadRef.threadId
        ? [{ ...annotation, number: index + 1 }]
        : [],
    ),
  );
}

export function clearReplyAnnotations(target: Target): void {
  write(target, (current) => (current.length === 0 ? current : EMPTY));
}

export function appendReplyAnnotations(target: Target, prompt: string): string {
  return appendAnnotationCitations(
    prompt,
    readReplyAnnotations(target).map((annotation) => annotation.citation),
  );
}

/** Puts the annotations a failed send carried back into the store. */
export function restoreReplyAnnotations(
  target: Target,
  snapshot: { readonly messageText: string; readonly draftText: string },
): void {
  for (const citation of sentAnnotationCitations(snapshot)) addReplyAnnotation(target, citation);
}
