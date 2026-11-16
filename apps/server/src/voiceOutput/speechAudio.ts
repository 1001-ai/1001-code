import type { VoiceOutputWord } from "@t3tools/contracts";

/**
 * Downmixes to mono 16-bit PCM, clipping out-of-range and non-finite samples.
 * Self-contained so the worker can inline it with `toString()`.
 */
export function pcm16Mono(samples: Float32Array, channels: number) {
  const pcm = new Int16Array(Math.floor(samples.length / channels));
  for (let frame = 0; frame < pcm.length; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++)
      sum += samples[frame * channels + channel]!;
    const sample = Math.max(-1, Math.min(1, sum / channels || 0));
    pcm[frame] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

/**
 * The runtime reports no word timings for most models, so the audio's length is spread over the
 * text's words by character count. Offsets are UTF-16 indexes into `text`.
 */
export function estimateWordTimings(
  text: string,
  durationMs: number,
): ReadonlyArray<VoiceOutputWord> {
  const words = [...text.matchAll(/\S+/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const total = words.reduce((sum, word) => sum + word.end - word.start, 0);
  let spoken = 0;
  return words.map((word) => {
    const t0Ms = (spoken / total) * durationMs;
    spoken += word.end - word.start;
    return { ...word, t0Ms, t1Ms: (spoken / total) * durationMs };
  });
}
