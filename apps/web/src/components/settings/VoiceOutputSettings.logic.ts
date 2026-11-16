import type { VoiceOutputModel } from "@t3tools/contracts";

/** Little-endian 16-bit PCM as the samples Web Audio plays. The bytes may start at an odd offset. */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  return samples;
}

export type VoiceModelCardState = {
  readonly state: VoiceOutputModel["install"]["state"];
  /** 0 to 100, while a transfer runs. */
  readonly progress: number;
  /** Why the last install stopped, shown until the next one starts. */
  readonly problem: string | null;
};

/**
 * What a model's card shows. A download this client just asked for reads as downloading before
 * the environment's catalog says so.
 */
export function voiceModelCardState(
  model: VoiceOutputModel,
  requestedDownload: string | null,
): VoiceModelCardState {
  const { install } = model;
  const requested = requestedDownload === model.id && install.state === "downloadable";
  const state = requested ? "downloading" : install.state;
  const transferring = state === "downloading" || state === "verifying";
  return {
    state,
    progress:
      transferring && install.size > 0
        ? Math.min(100, ((install.downloaded ?? 0) / install.size) * 100)
        : 0,
    problem: transferring
      ? null
      : install.failure === "verification"
        ? "Verification failed: the download did not match its checksum, so nothing was installed."
        : install.failure === "download"
          ? "The download failed. Check the connection and try again."
          : null,
  };
}
