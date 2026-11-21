import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2Subagent,
  ProviderInstanceId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { use } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { TimelineMessageSendContext } from "./questionBlockScope";
import {
  canSwitchSubagentModel,
  resolveSubagentModelLabel,
  subagentModelSwitchMessage,
  subagentSelectableModels,
} from "./subagentModelSwitch.logic";

export interface SubagentModelPickerProps {
  readonly parentRef: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly status: OrchestrationV2Subagent["status"];
  readonly title: string;
  readonly model: string | null;
  readonly executedModel?: string | undefined;
  readonly modelSelection?: OrchestrationV2Subagent["modelSelection"];
  readonly threadId: ThreadId | null;
  readonly remote?: OrchestrationV2RemoteTaskChild | undefined;
}

/**
 * Displays a subagent's model on its timeline card, and offers a same-provider model switcher
 * that asks the parent agent to switch the subagent via a plain chat message.
 */
export function SubagentModelPicker(props: SubagentModelPickerProps) {
  const sendMessage = use(TimelineMessageSendContext);
  const childSelection = useThreadShell(
    props.origin === "app_owned" && props.threadId !== null
      ? scopeThreadRef(props.parentRef.environmentId, props.threadId)
      : null,
  )?.source?.modelSelection;
  const effectiveSelection = props.modelSelection ?? childSelection;

  const providerEnvironmentId = props.remote?.environmentId ?? props.parentRef.environmentId;
  const providersAtom = serverEnvironment.providersValueAtom(providerEnvironmentId);
  const settings = useEnvironmentSettings(providerEnvironmentId);

  // Select primitives so provider status pushes do not re-render every subagent row.
  const modelLabel = useAtomValue(
    providersAtom,
    (providers) =>
      resolveSubagentModelLabel({
        model: props.model,
        executedModel: props.executedModel,
        modelSelection: effectiveSelection,
        provider: providers?.find((candidate) => candidate.instanceId === props.providerInstanceId),
      }).modelLabel,
  );
  const modelSlug = useAtomValue(
    providersAtom,
    (providers) =>
      resolveSubagentModelLabel({
        model: props.model,
        executedModel: props.executedModel,
        modelSelection: effectiveSelection,
        provider: providers?.find((candidate) => candidate.instanceId === props.providerInstanceId),
      }).modelSlug,
  );
  const hasMultipleModels = useAtomValue(providersAtom, (providers) => {
    const provider = providers?.find(
      (candidate) => candidate.instanceId === props.providerInstanceId,
    );
    return (
      subagentSelectableModels({
        provider,
        settings,
        currentModelSlug: modelSlug,
      }).length > 1
    );
  });

  const interactive =
    sendMessage !== null &&
    hasMultipleModels &&
    canSwitchSubagentModel({
      status: props.status,
      origin: props.origin,
      childThreadId: props.threadId,
      remote: props.remote,
    });

  if (!interactive) {
    if (modelLabel === null) return null;
    return (
      <span
        data-slot="subagent-model-label"
        className="max-w-32 shrink-0 truncate text-2xs text-muted-foreground"
      >
        {modelLabel}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            data-slot="subagent-model-picker"
            aria-label={
              modelLabel
                ? `Switch model for ${props.title} (currently ${modelLabel})`
                : `Switch model for ${props.title}`
            }
            onClick={(event) => event.stopPropagation()}
            className="relative z-10 inline-flex max-w-36 shrink-0 cursor-pointer items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-2xs text-foreground/70 transition-colors hover:border-border hover:bg-secondary/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 data-popup-open:border-border data-popup-open:bg-secondary data-popup-open:text-foreground"
          />
        }
      >
        <span className="min-w-0 truncate">{modelLabel ?? "Model"}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="max-w-64">
        <SubagentModelMenuContent
          providerEnvironmentId={providerEnvironmentId}
          providerInstanceId={props.providerInstanceId}
          currentModelSlug={modelSlug}
          title={props.title}
          origin={props.origin}
          childThreadId={props.threadId}
          remote={props.remote}
          sendMessage={sendMessage}
        />
      </MenuPopup>
    </Menu>
  );
}

function SubagentModelMenuContent(props: {
  readonly providerEnvironmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly currentModelSlug: string | null;
  readonly title: string;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
  readonly remote?: OrchestrationV2RemoteTaskChild | undefined;
  readonly sendMessage: (text: string) => boolean;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.providerEnvironmentId));
  const settings = useEnvironmentSettings(props.providerEnvironmentId);
  const provider = providers?.find(
    (candidate) => candidate.instanceId === props.providerInstanceId,
  );
  const options = subagentSelectableModels({
    provider,
    settings,
    currentModelSlug: props.currentModelSlug,
  });

  const currentSlug = options.find((option) => option.isCurrent)?.slug ?? "";

  return (
    <MenuGroup>
      <MenuGroupLabel>Ask the parent agent to switch this subagent to:</MenuGroupLabel>
      <MenuRadioGroup
        value={currentSlug}
        onValueChange={(nextSlug: string) => {
          const chosen = options.find((option) => option.slug === nextSlug);
          if (!chosen || chosen.isCurrent) return;
          const message = subagentModelSwitchMessage({
            title: props.title,
            origin: props.origin,
            childThreadId: props.childThreadId,
            remote: props.remote,
            targetModelLabel: chosen.label,
            targetModelSlug: chosen.slug,
          });
          props.sendMessage(message);
        }}
      >
        {options.map((option) => (
          <MenuRadioItem key={option.slug} value={option.slug} closeOnClick>
            <span className="flex items-center gap-3">
              <MenuItemLabel className="flex-1">{option.label}</MenuItemLabel>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}
