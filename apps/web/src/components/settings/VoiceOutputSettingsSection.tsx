import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  cancelVoiceOutputModelDownload,
  downloadVoiceOutputModel,
  getVoiceOutputCatalog,
  removeVoiceOutputModel,
  selectVoiceOutputVoice,
  speakVoiceOutputText,
} from "@t3tools/client-runtime/voice-output";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type VoiceOutputCatalog,
  type VoiceOutputModel,
  type VoiceOutputSpeech,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CheckIcon, DownloadIcon, PlayIcon, SquareIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { pcm16ToFloat32, voiceModelCardState } from "./VoiceOutputSettings.logic";

const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Every sample plays through this one context; browsers cap how many a page may open.
let audioContext: AudioContext | undefined;

/** Starts playback and returns how to stop it. `onEnded` runs only when the audio ends by itself. */
function playSpeech(speech: VoiceOutputSpeech, onEnded: () => void): () => void {
  audioContext ??= new AudioContext();
  void audioContext.resume();
  const samples = pcm16ToFloat32(speech.pcm);
  const buffer = audioContext.createBuffer(1, Math.max(1, samples.length), speech.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = onEnded;
  source.start();
  return () => {
    source.onended = null;
    source.stop();
  };
}

function useVoiceOutputCatalog(prepared: PreparedConnection | null, canManage: boolean) {
  const [catalog, setCatalog] = useState<VoiceOutputCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [connection, setConnection] = useState(prepared);
  if (connection !== prepared) {
    setConnection(prepared);
    setCatalog(null);
    setLoadError(null);
    setBusy(false);
    setRequestedDownload(null);
  }
  const epoch = useRef(0);
  const revision = useRef(0);
  const refresh = useStableCallback(async (target: PreparedConnection, quiet: boolean) => {
    const current = epoch.current;
    const request = ++revision.current;
    try {
      const next = await runEnvironmentSpeech(getVoiceOutputCatalog(target));
      if (current !== epoch.current || request !== revision.current) return;
      setCatalog(next);
      setLoadError(null);
    } catch (error) {
      if (quiet || current !== epoch.current || request !== revision.current) return;
      setLoadError(errorText(error));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's voice catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared, false);
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const transferring =
    requestedDownload !== null ||
    (catalog?.models.some(
      (model) => model.install.state === "downloading" || model.install.state === "verifying",
    ) ??
      false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls progress while a local request or the environment reports an active download
  useEffect(() => {
    if (!prepared || !transferring) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared, true);
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [transferring, prepared, refresh]);

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      if (current === epoch.current)
        toastManager.add({ type: "error", title: label, description: errorText(error) });
    }
    if (current !== epoch.current) return;
    if (downloadId) setRequestedDownload(null);
    else setBusy(false);
    await refresh(prepared, false);
  };
  return {
    catalog,
    loadError,
    run,
    requestedDownload,
    controlsDisabled: busy || transferring || !canManage,
    canCancel: canManage && !busy,
  };
}

type Sample = { readonly key: string; readonly phase: "preparing" | "playing" };

/** One sample at a time: starting another, or leaving the page, stops the one in progress. */
function useVoiceSample(prepared: PreparedConnection | null) {
  const [sample, setSample] = useState<Sample | null>(null);
  const stopCurrent = useRef<(() => void) | null>(null);
  const stop = useStableCallback(() => {
    stopCurrent.current?.();
    stopCurrent.current = null;
    setSample(null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops audio and the pending request when the section unmounts or its environment changes
  useEffect(() => (prepared ? stop : undefined), [prepared, stop]);
  const hear = (model: VoiceOutputModel, voiceId: string) => {
    if (!prepared) return;
    stop();
    const key = `${model.id}/${voiceId}`;
    const request = new AbortController();
    let active = true;
    // Aborting interrupts the request in flight and, through its finalizer, the audio playing.
    stopCurrent.current = () => {
      active = false;
      request.abort();
    };
    setSample({ key, phase: "preparing" });
    runEnvironmentSpeech(
      speakVoiceOutputText(prepared, model.sampleText, { modelId: model.id, voiceId }).pipe(
        // The next sentence is made while this one plays.
        Stream.buffer({ capacity: 1 }),
        Stream.runForEach((sentence) =>
          Effect.callback<void>((resume) => {
            setSample({ key, phase: "playing" });
            return Effect.sync(playSpeech(sentence, () => resume(Effect.void)));
          }),
        ),
      ),
      { signal: request.signal },
    ).then(
      () => {
        if (!active) return;
        stopCurrent.current = null;
        setSample(null);
      },
      (error: unknown) => {
        if (!active) return;
        stopCurrent.current = null;
        setSample(null);
        toastManager.add({
          type: "error",
          title: "Could not play the sample",
          description: errorText(error),
        });
      },
    );
  };
  return { sample, hear, stop };
}

function VoiceModelCard(props: {
  readonly model: VoiceOutputModel;
  readonly prepared: PreparedConnection;
  readonly voices: ReturnType<typeof useVoiceOutputCatalog>;
  readonly samples: ReturnType<typeof useVoiceSample>;
  readonly selection: VoiceOutputCatalog["selection"];
  readonly canHear: boolean;
}) {
  const { model, prepared, voices, samples } = props;
  const card = voiceModelCardState(model, voices.requestedDownload);
  const transferring = card.state === "downloading" || card.state === "verifying";
  return (
    <div className="@container/model px-3 py-3">
      <div className="flex flex-col gap-2.5 @min-[28rem]/model:flex-row @min-[28rem]/model:items-start @min-[28rem]/model:gap-4">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium leading-5">{model.name}</span>
          <p className="mt-0.5 text-xs leading-normal text-muted-foreground">
            {formatSize(model.install.size)} · License:{" "}
            {model.licenseUrl.startsWith("https://") ? (
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={model.licenseUrl}
                target="_blank"
                rel="noreferrer"
              >
                {model.license}
              </a>
            ) : (
              model.license
            )}
          </p>
          {transferring ? (
            <div className="mt-2">
              <div
                role="progressbar"
                aria-label={`${model.name} download progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(card.progress)}
                className="h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{ width: `${card.progress}%` }}
                />
              </div>
              <p className="mt-1 text-2xs text-muted-foreground">
                {card.state === "verifying"
                  ? "Verifying download…"
                  : `${Math.round(card.progress)}% downloaded`}
              </p>
            </div>
          ) : null}
          {card.problem ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {card.problem}
            </p>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
          {transferring ? (
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={`Cancel ${model.name} download`}
              disabled={!voices.canCancel}
              onClick={() =>
                void voices.run("Could not cancel the download", () =>
                  runEnvironmentSpeech(cancelVoiceOutputModelDownload(prepared, model.id)),
                )
              }
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : card.state === "downloadable" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={voices.controlsDisabled}
              onClick={() =>
                void voices.run(
                  "Could not download the voice model",
                  () => runEnvironmentSpeech(downloadVoiceOutputModel(prepared, model.id)),
                  model.id,
                )
              }
            >
              <DownloadIcon />
              Download
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="outline"
              disabled={voices.controlsDisabled}
              aria-label={`Delete ${model.name}`}
              onClick={() => {
                samples.stop();
                void voices.run("Could not delete the voice model", () =>
                  runEnvironmentSpeech(removeVoiceOutputModel(prepared, model.id)),
                );
              }}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </div>
      {card.state === "installed" ? (
        <ul className="mt-2 space-y-1.5" aria-label={`${model.name} voices`}>
          {model.voices.map((voice) => {
            const key = `${model.id}/${voice.id}`;
            const phase = samples.sample?.key === key ? samples.sample.phase : null;
            const selected =
              props.selection?.modelId === model.id && props.selection.voiceId === voice.id;
            return (
              <li key={voice.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm">{voice.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!props.canHear}
                    aria-label={
                      phase === null
                        ? `Hear a sample of ${voice.name}`
                        : `Stop the sample of ${voice.name}`
                    }
                    onClick={() =>
                      phase === null ? samples.hear(model, voice.id) : samples.stop()
                    }
                  >
                    {phase === null ? <PlayIcon /> : <SquareIcon />}
                    {phase === "preparing"
                      ? "Preparing…"
                      : phase === "playing"
                        ? "Stop"
                        : "Hear a sample"}
                  </Button>
                  {selected ? (
                    <Button size="sm" variant="secondary" disabled>
                      <CheckIcon />
                      Selected
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={voices.controlsDisabled}
                      onClick={() =>
                        void voices.run("Could not choose the voice", () =>
                          runEnvironmentSpeech(
                            selectVoiceOutputVoice(prepared, {
                              modelId: model.id,
                              voiceId: voice.id,
                            }),
                          ),
                        )
                      }
                    >
                      Use voice
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function EnvironmentVoices(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(props.environmentId));
  const canManage = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const canHear = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const voices = useVoiceOutputCatalog(canHear ? prepared : null, canManage);
  const samples = useVoiceSample(prepared);
  const { catalog } = voices;
  const selected = catalog?.selection
    ? catalog.models
        .find((model) => model.id === catalog.selection?.modelId)
        ?.voices.find((voice) => voice.id === catalog.selection?.voiceId)
    : undefined;
  const notice = !prepared
    ? "Connect to this environment to see its voices."
    : !canHear
      ? "This session may not use voices on this environment."
      : (voices.loadError ??
        catalog?.unavailable?.message ??
        (catalog && catalog.models.length === 0 ? "The team's voice list is empty." : null));
  return (
    <SettingsRow
      title={props.label === null ? "Voices" : `Voices · ${props.label}`}
      description="Voice models from your team's list, downloaded to this environment. Speech is made on the environment itself: nothing spoken leaves it, and the only network traffic is the download you start."
      status={
        catalog === null || notice !== null
          ? null
          : selected
            ? `Speaking with ${selected.name}.`
            : "No voice chosen yet. Download a model, hear its voices, then choose one."
      }
    >
      {notice !== null ? (
        <p className="pb-2 text-xs text-muted-foreground">{notice}</p>
      ) : catalog && prepared ? (
        <div
          className="mt-2 mb-2 divide-y divide-border/60 rounded-lg border border-border/60"
          role="region"
          aria-label="Voice models"
        >
          {catalog.models.map((model) => (
            <VoiceModelCard
              key={model.id}
              model={model}
              prepared={prepared}
              voices={voices}
              samples={samples}
              selection={catalog.selection}
              canHear={canHear}
            />
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** Speech output: the voice models each environment in scope has, and the voice that speaks. */
export function VoiceOutputSettingsSection() {
  const scope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scoped = [...new Map(scope?.targets.map((target) => [target.environmentId, target.label]))];
  const environments: ReadonlyArray<readonly [EnvironmentId, string | null]> =
    scoped.length > 0
      ? scoped.map(([environmentId, label]) => [environmentId, scoped.length > 1 ? label : null])
      : primaryEnvironmentId
        ? [[primaryEnvironmentId, null]]
        : [];
  if (environments.length === 0) return null;
  return (
    <SettingsSection id="voice-output" title="Speech output">
      {environments.map(([environmentId, label]) => (
        <EnvironmentVoices key={environmentId} environmentId={environmentId} label={label} />
      ))}
    </SettingsSection>
  );
}
