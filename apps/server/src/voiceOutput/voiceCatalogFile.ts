import {
  parseVoiceOutputFileUrl,
  VoiceOutputCatalogFile,
  type VoiceOutputCatalogModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { ModelFile } from "../speech/SpeechModelStore.ts";

export type VoiceModel = Omit<VoiceOutputCatalogModel, "file"> & {
  /** The catalog's pinned file, as the model store downloads and verifies it. */
  readonly file: ModelFile;
};

const decodeFile = Schema.decodeUnknownExit(Schema.fromJsonString(VoiceOutputCatalogFile), {
  onExcessProperty: "error",
});

const REASON_LIMIT = 400;
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Decodes the team's voice list strictly. Returns the models, or the reason the whole file is
 * refused: one bad entry refuses the file, so a download never starts from a half-read list.
 * `reservedFilenames` are names other speech models already use in the shared model folder.
 */
export function decodeVoiceCatalogFile(
  text: string,
  reservedFilenames: ReadonlySet<string>,
): ReadonlyArray<VoiceModel> | string {
  const decoded = decodeFile(text);
  if (Exit.isFailure(decoded)) {
    const error = Cause.squash(decoded.cause);
    return Schema.isSchemaError(error)
      ? error.message.replace(/\s*\n\s*/g, " ").slice(0, REASON_LIMIT)
      : "Not valid JSON.";
  }
  const ids = new Set<string>();
  const filenames = new Set<string>();
  const models: Array<VoiceModel> = [];
  for (const { file, ...model } of decoded.value.models) {
    if (ids.has(model.id)) return `The model "${model.id}" is listed more than once.`;
    ids.add(model.id);
    const voices = new Set(model.voices.map((voice) => voice.id));
    if (voices.size !== model.voices.length)
      return `The model "${model.id}" lists a voice more than once.`;
    // The schema already refused any URL this cannot parse.
    const source = parseVoiceOutputFileUrl(file.url);
    if (!source) return `The model "${model.id}" has an invalid file URL.`;
    const filename = basename(source.path);
    if (filenames.has(filename) || reservedFilenames.has(filename))
      return `The file name "${filename}" of the model "${model.id}" is already in use.`;
    filenames.add(filename);
    models.push({
      ...model,
      file: {
        id: source.repository,
        revision: source.revision,
        filename: source.path,
        size: file.size,
        sha256: file.sha256,
      },
    });
  }
  return models;
}
