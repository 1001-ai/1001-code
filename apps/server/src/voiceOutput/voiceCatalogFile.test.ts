import { expect, it } from "vite-plus/test";

import { decodeVoiceCatalogFile } from "./voiceCatalogFile.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const model = (overrides: Record<string, unknown> = {}) => ({
  id: "lantern",
  name: "Lantern",
  license: "Apache-2.0",
  licenseUrl: "https://example.com/licenses/apache-2.0",
  file: {
    url: `https://huggingface.co/example/lantern-gguf/resolve/${REVISION}/weights/lantern-f16.gguf`,
    size: 1_024,
    sha256: "ab".repeat(32),
  },
  voices: [
    { id: "amber", name: "Amber" },
    { id: "slate", name: "Slate" },
  ],
  sampleText: "This is how I sound.",
  ...overrides,
});
const file = (...models: unknown[]) => JSON.stringify({ version: 1, models });
const decode = (text: string, reserved: string[] = []) =>
  decodeVoiceCatalogFile(text, new Set(reserved));

it("reads a model as the pinned Hugging Face file the store downloads", () => {
  expect(decode(file(model({ language: "en", requestOptions: { speed: "1.1" } })))).toEqual([
    {
      id: "lantern",
      name: "Lantern",
      license: "Apache-2.0",
      licenseUrl: "https://example.com/licenses/apache-2.0",
      voices: [
        { id: "amber", name: "Amber" },
        { id: "slate", name: "Slate" },
      ],
      sampleText: "This is how I sound.",
      language: "en",
      requestOptions: { speed: "1.1" },
      file: {
        id: "example/lantern-gguf",
        revision: REVISION,
        filename: "weights/lantern-f16.gguf",
        size: 1_024,
        sha256: "ab".repeat(32),
      },
    },
  ]);
});

it.each([
  [
    "a host other than Hugging Face",
    `https://example.com/example/lantern-gguf/resolve/${REVISION}/lantern.gguf`,
  ],
  [
    "a look-alike host",
    `https://huggingface.co.example.com/example/lantern-gguf/resolve/${REVISION}/lantern.gguf`,
  ],
  ["plain http", `http://huggingface.co/example/lantern-gguf/resolve/${REVISION}/lantern.gguf`],
  [
    "a branch instead of a commit",
    "https://huggingface.co/example/lantern-gguf/resolve/main/lantern.gguf",
  ],
  ["a short commit", "https://huggingface.co/example/lantern-gguf/resolve/0123456/lantern.gguf"],
  [
    "a path that climbs out",
    `https://huggingface.co/example/lantern-gguf/resolve/${REVISION}/../lantern.gguf`,
  ],
  [
    "a query string",
    `https://huggingface.co/example/lantern-gguf/resolve/${REVISION}/lantern.gguf?download=true`,
  ],
  [
    "a file that is not a model",
    `https://huggingface.co/example/lantern-gguf/resolve/${REVISION}/install.sh`,
  ],
])("refuses a file URL with %s", (_, url) => {
  const reason = decode(file(model({ file: { url, size: 1, sha256: "ab".repeat(32) } })));
  expect(reason).toEqual(expect.stringContaining("huggingface.co"));
});

it.each([
  ["a hash that is not SHA-256", { file: { ...model().file, sha256: "ab".repeat(20) } }],
  ["an uppercase hash", { file: { ...model().file, sha256: "AB".repeat(32) } }],
  ["no size", { file: { url: model().file.url, sha256: "ab".repeat(32) } }],
  ["a license link that is not https", { licenseUrl: "javascript:alert(1)" }],
  ["no voices", { voices: [] }],
  ["an unknown field", { postInstall: "curl example.com | sh" }],
  ["a voice listed twice", { voices: [model().voices[0], model().voices[0]] }],
  ["a request option with an odd name", { requestOptions: { "--load-option": "x" } }],
])("refuses a model with %s", (_, overrides) => {
  expect(typeof decode(file(model(overrides)))).toBe("string");
});

it("refuses the whole file for one bad entry, a repeated model, or a file name already in use", () => {
  expect(typeof decode(file(model(), model({ id: "bad", file: { url: "x" } })))).toBe("string");
  expect(decode(file(model(), model()))).toBe('The model "lantern" is listed more than once.');
  const sameFile = decode(file(model(), model({ id: "lantern-2" })));
  expect(sameFile).toBe(
    'The file name "lantern-f16.gguf" of the model "lantern-2" is already in use.',
  );
  expect(decode(file(model()), ["lantern-f16.gguf"])).toBe(
    'The file name "lantern-f16.gguf" of the model "lantern" is already in use.',
  );
  expect(typeof decode("{")).toBe("string");
  expect(typeof decode(JSON.stringify({ version: 2, models: [] }))).toBe("string");
  expect(decode(file())).toEqual([]);
});
