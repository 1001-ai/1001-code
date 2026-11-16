import { getVoiceOutputCatalog, speakVoiceOutputText } from "@t3tools/client-runtime/voice-output";
import type { EnvironmentId, VoiceOutputCatalog } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { useEffect, useState } from "react";

import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { readPreparedConnection } from "../../state/session";
import { lampAudioOutput, suspendLampAudio } from "./lampAudio";
import { lampSpeaker } from "./lampSpeaker";
import { lampVoiceChoice, type LampSpeaker } from "./lampSpeech.logic";
import { createLampVoiceSpeaker } from "./lampVoiceSpeaker";

// The agent's first words wait for the catalog; an environment that does not answer costs this much.
const CATALOG_WAIT_MS = 5_000;

interface LampSpeakerChoice {
  readonly speaker: LampSpeaker;
  readonly offerSettings: boolean;
}

/**
 * The voice one conversation speaks with. Opening the layer reads the environment's voice
 * catalog: the voice the user picked speaks when its model is installed, and the system voice
 * otherwise, and from the first request to the downloaded voice that fails.
 */
export function useLampSpeaker(input: {
  readonly environmentId: EnvironmentId;
  readonly closing: boolean;
}): {
  /** Null until the catalog has answered. */
  readonly speaker: LampSpeaker | null;
  /** There are voices to pick from and the user has picked none. */
  readonly offerSettings: boolean;
  /** The downloaded voice could not be used in this conversation. */
  readonly failed: boolean;
} {
  const { environmentId, closing } = input;
  const [choice, setChoice] = useState<LampSpeakerChoice | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's voice catalog when the layer opens, and drops the conversation's voice when it closes
  useEffect(() => {
    if (closing) return;
    let live = true;
    const reading = new AbortController();
    const waited = setTimeout(() => reading.abort(), CATALOG_WAIT_MS);
    const choose = (catalog: VoiceOutputCatalog | null) => {
      clearTimeout(waited);
      if (!live) return;
      const { voice, offerSettings } = lampVoiceChoice(catalog);
      if (voice === "system") {
        suspendLampAudio();
        return setChoice({ speaker: lampSpeaker, offerSettings });
      }
      setChoice({
        offerSettings,
        speaker: createLampVoiceSpeaker({
          // No voice is named: the one chosen in settings speaks, as the catalog said.
          source: (sentence, signal) => {
            const connection = readPreparedConnection(environmentId);
            if (connection === null) return Promise.reject(new Error("Not connected."));
            return runEnvironmentSpeech(
              speakVoiceOutputText(connection, sentence).pipe(Stream.runCollect),
              { signal },
            );
          },
          audio: lampAudioOutput,
          fallback: lampSpeaker,
          onFailure: () => {
            if (live) setFailed(true);
          },
        }),
      });
    };
    const connection = readPreparedConnection(environmentId);
    if (connection === null) choose(null);
    else {
      runEnvironmentSpeech(getVoiceOutputCatalog(connection), { signal: reading.signal }).then(
        choose,
        () => choose(null),
      );
    }
    return () => {
      live = false;
      clearTimeout(waited);
      reading.abort();
      setChoice(null);
      setFailed(false);
    };
  }, [closing, environmentId]);

  return {
    speaker: choice?.speaker ?? null,
    offerSettings: choice?.offerSettings ?? false,
    failed,
  };
}
