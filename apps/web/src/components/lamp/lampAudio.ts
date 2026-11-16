import { pcm16ToFloat32 } from "../settings/VoiceOutputSettings.logic";
import type { LampAudioOutput } from "./lampVoiceSpeaker";

// The downloaded voice plays through this one context, every time the layer opens.
let context: AudioContext | undefined;

/**
 * Call inside the gesture that opens the layer: a browser leaves a context suspended when it is
 * first resumed later, when the audio arrives and the gesture is long over.
 */
export function openLampAudio(): void {
  if (typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  void context.resume().catch(() => undefined);
}

/** No voice plays through the context for now: a running context keeps the audio device awake. */
export function suspendLampAudio(): void {
  void context?.suspend().catch(() => undefined);
}

export const lampAudioOutput: LampAudioOutput = {
  now: () => context?.currentTime ?? 0,
  play(pcm, sampleRate, at) {
    // A suspended context would play nothing while the captions moved on.
    if (context?.state !== "running") throw new Error("The audio output is not running.");
    const samples = pcm16ToFloat32(pcm);
    const buffer = context.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    let ended = false;
    source.addEventListener("ended", () => {
      ended = true;
    });
    source.start(at);
    return () => {
      // Some browsers throw on stopping a source that has finished, which would leave later ones playing.
      if (ended) return;
      try {
        source.stop();
      } catch {
        ended = true;
      }
    };
  },
  at(at, run) {
    const timer = setTimeout(run, Math.max(0, (at - (context?.currentTime ?? 0)) * 1000));
    return () => clearTimeout(timer);
  },
};
