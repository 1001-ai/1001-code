import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  isOrchestrationV2WorkActive,
  type ModelSelection,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { resolveSelectableModel } from "@t3tools/shared/model";

import { getAppModelOptionsForInstance } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

export interface SubagentSelectableModel {
  readonly slug: string;
  readonly label: string;
  readonly isCurrent: boolean;
}

/**
 * Running (or idle/resumable) subagents can be switched, plus delegated subagents whose child
 * thread can still take messages. Finished provider-native subagents show a static model label.
 */
export function canSwitchSubagentModel(input: {
  readonly status: OrchestrationV2Subagent["status"];
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
  readonly remote?: OrchestrationV2RemoteTaskChild | undefined;
}): boolean {
  if (isOrchestrationV2WorkActive(input.status) || input.status === "idle") {
    return true;
  }
  return (
    input.origin === "app_owned" && (input.childThreadId !== null || input.remote !== undefined)
  );
}

/** Resolves a subagent's display model label and slug, or nulls when no model has been reported. */
export function resolveSubagentModelLabel(input: {
  readonly model: string | null;
  readonly executedModel?: string | undefined;
  readonly modelSelection?: Pick<ModelSelection, "model"> | undefined;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
}): { readonly modelLabel: string | null; readonly modelSlug: string | null } {
  const reportedModel = input.executedModel?.trim() || input.model?.trim() || null;
  const fallbackModel = input.modelSelection?.model.trim() || null;
  if (reportedModel === null && fallbackModel === null) {
    return { modelLabel: null, modelSlug: null };
  }
  const { modelLabel, modelSlug } = resolveSubagentMetadata({
    model: reportedModel,
    modelSelection: input.modelSelection,
    provider: input.provider,
  });
  return {
    modelLabel: modelSlug === null ? null : modelLabel,
    modelSlug,
  };
}

/** Lists selectable models from the subagent's own provider instance, marking the current model. */
export function subagentSelectableModels(input: {
  readonly provider: ServerProvider | undefined;
  readonly settings: UnifiedSettings | null | undefined;
  readonly currentModelSlug: string | null;
}): ReadonlyArray<SubagentSelectableModel> {
  const { provider, settings, currentModelSlug } = input;
  if (provider === undefined) return [];

  const resolvedCurrentSlug =
    currentModelSlug && currentModelSlug.trim().length > 0
      ? (resolveSelectableModel(provider.driver, currentModelSlug, provider.models) ??
        currentModelSlug.trim())
      : null;

  const entry = deriveProviderInstanceEntries([provider])[0];
  const rawOptions: ReadonlyArray<ModelEsque> =
    settings && entry
      ? getAppModelOptionsForInstance(settings, entry, resolvedCurrentSlug)
      : provider.models;

  const available = rawOptions.filter(
    (option) =>
      !(provider.driver === "antigravity" && option.slug === ANTIGRAVITY_DEFAULT_MODEL) &&
      option.isUnavailable !== true,
  );
  const nonLegacy = available.filter(
    (option) => option.isLegacy !== true || option.slug === resolvedCurrentSlug,
  );
  const candidates = nonLegacy.length > 0 ? nonLegacy : available;

  const seen = new Set<string>();
  const items: SubagentSelectableModel[] = [];
  for (const option of candidates) {
    if (seen.has(option.slug)) continue;
    seen.add(option.slug);
    items.push({
      slug: option.slug,
      label: getTriggerDisplayModelName(option, provider.driver),
      isCurrent: resolvedCurrentSlug !== null && option.slug === resolvedCurrentSlug,
    });
  }
  return items;
}

export interface SubagentModelSwitchMessageInput {
  readonly title: string;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
  readonly remote?: OrchestrationV2RemoteTaskChild | undefined;
  readonly targetModelLabel: string;
  readonly targetModelSlug: string;
}

/** Builds a plain-text message asking the parent agent to switch a subagent to another model. */
export function subagentModelSwitchMessage(input: SubagentModelSwitchMessageInput): string {
  const title = input.title.replace(/\s+/gu, " ").trim() || "Subagent";
  const label = input.targetModelLabel.trim();
  const slug = input.targetModelSlug.trim();
  const target = label.length > 0 && label !== slug ? `${label} (model ${slug})` : slug;

  if (input.origin === "app_owned") {
    if (input.remote !== undefined) {
      return `Switch the subagent "${title}" (thread ${input.remote.threadId} on ${input.remote.label}, environment ${input.remote.environmentId}) to ${target} using t3_thread_configure.`;
    }
    if (input.childThreadId !== null) {
      return `Switch the subagent "${title}" (thread ${input.childThreadId}) to ${target} using t3_thread_configure.`;
    }
  }

  return `Switch the subagent "${title}" to ${target}. If it cannot change model while it runs, stop it and start it again on that model with the same task.`;
}

/** Appends a standalone message to any existing draft text without losing what the user typed. */
export function appendMessageToDraft(draft: string, message: string): string {
  const trimmed = draft.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${message}` : message;
}
