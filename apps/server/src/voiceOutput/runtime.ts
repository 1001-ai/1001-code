import * as Context from "effect/Context";

import { isSpeechPlatformSupported } from "../speech/platform.ts";

/**
 * The speech runtime is executable code, so its builds are pinned here and reviewed like code:
 * a release of github.com/pingdotgg/audio.cpp, by URL, size and SHA-256. The version, URLs,
 * hashes and library paths are the ones upstream T3 Code's local read-aloud pins, so both
 * install to the same folder.
 */
export const AUDIO_CPP_VERSION = "t3-2026.11.15";

export type AudioCppRuntime = {
  readonly filename: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  /** The real library file inside the archive, not a version symlink. */
  readonly library: string;
  /** The session backend the build accelerates; every build can also run on the CPU. */
  readonly backend: "metal" | "vulkan" | "cpu";
  /** The oldest glibc the build loads on, from the versions its symbols require. */
  readonly minimumGlibc?: string;
};

const runtime = (
  name: string,
  size: number,
  sha256: string,
  library: string,
  backend: AudioCppRuntime["backend"],
  minimumGlibc?: string,
): AudioCppRuntime => {
  const filename = `audio-${AUDIO_CPP_VERSION}-lib-${name}`;
  return {
    filename,
    url: `https://github.com/pingdotgg/audio.cpp/releases/download/${AUDIO_CPP_VERSION}/${filename}`,
    size,
    sha256,
    library,
    backend,
    ...(minimumGlibc ? { minimumGlibc } : {}),
  };
};

// Linux and Windows load Vulkan as a plugin and otherwise run on the CPU.
const RUNTIMES: Readonly<Record<string, AudioCppRuntime>> = {
  "darwin-arm64": runtime(
    "macos-arm64-metal.tar.gz",
    15_050_502,
    "d310a03ec334c9eca108afddc155285d415c4a9de7de6f1f11852792dea4ef40",
    "libs/libaudiocpp.0.1.0.dylib",
    "metal",
  ),
  "darwin-x64": runtime(
    "macos-x64-cpu.tar.gz",
    16_205_264,
    "e28f38d904ca2f62582e30b66daf223a102c49d72dfc4de6652ebc49d560b497",
    "libs/libaudiocpp.0.1.0.dylib",
    "cpu",
  ),
  "linux-x64": runtime(
    "linux-x64-vulkan.tar.gz",
    46_480_833,
    "bfb156d9803a9d72321edf2618132f5c253d62774d87b8a84404c908bcb14c8d",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "linux-arm64": runtime(
    "linux-arm64-vulkan.tar.gz",
    40_185_095,
    "5dcf0ca69930cb326228379d21c357a9474e5fb414b7fbbdbad8d59dc6be9eb8",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "win32-x64": runtime(
    "windows-x64-vulkan.zip",
    34_389_751,
    "80c98ef7ccb2ebdb343838727cfce20cceefbf35eeeda6a0ffae4a344f06a613",
    "libs/audiocpp.dll",
    "vulkan",
  ),
};

/** The pinned builds by `<platform>-<architecture>`; a reference so tests install a fixture archive. */
export const RuntimeBuilds = Context.Reference<Readonly<Record<string, AudioCppRuntime>>>(
  "t3/voiceOutput/runtime/RuntimeBuilds",
  { defaultValue: () => RUNTIMES },
);

/** The running glibc, such as `2.39`; undefined off glibc. */
export const GlibcVersion = Context.Reference<string | undefined>(
  "t3/voiceOutput/runtime/GlibcVersion",
  {
    defaultValue: () => {
      try {
        const report = process.report?.getReport() as
          | { header?: { glibcVersionRuntime?: unknown } }
          | undefined;
        const version = report?.header?.glibcVersionRuntime;
        return typeof version === "string" ? version : undefined;
      } catch {
        return undefined;
      }
    },
  },
);

const atLeast = (version: string, minimum: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [wantedMajor = 0, wantedMinor = 0] = minimum.split(".").map(Number);
  return major > wantedMajor || (major === wantedMajor && minor >= wantedMinor);
};

/** The runtime build a host installs, or why it cannot run voice models. */
export function voiceOutputRuntime(
  host: {
    readonly platform: string;
    readonly architecture: string;
    readonly libc: "gnu" | "musl" | undefined;
    readonly glibc: string | undefined;
  },
  builds: Readonly<Record<string, AudioCppRuntime>>,
): { readonly runtime?: AudioCppRuntime; readonly error?: string } {
  const build = isSpeechPlatformSupported(host.platform, host.architecture, host.libc)
    ? builds[`${host.platform}-${host.architecture}`]
    : undefined;
  if (!build)
    return {
      error: `Voice models are not available on ${host.platform}-${host.architecture}.`,
    };
  if (build.minimumGlibc && !(host.glibc && atLeast(host.glibc, build.minimumGlibc)))
    return {
      error: `Voice models need glibc ${build.minimumGlibc} or newer. This environment has glibc ${host.glibc ?? "unknown"}.`,
    };
  return { runtime: build };
}
