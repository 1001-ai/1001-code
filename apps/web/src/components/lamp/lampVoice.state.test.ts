import { describe, expect, it } from "vite-plus/test";

import { LAMP_VOICE_SILENT } from "./lampSpeech.logic";
import { lampVoice } from "./lampVoice.state";

describe("lamp voice session", () => {
  it("keeps an exchange while the layer closes, and nothing of it once the layer has gone", () => {
    lampVoice.queue("Nothing new to report.");
    lampVoice.began();
    lampVoice.interrupted();
    lampVoice.heard("Stop");

    // The text stays on the layer while it fades out.
    lampVoice.silenced();
    expect(lampVoice.session().speaking).toBe(false);
    expect(lampVoice.session().heard).toBe("Stop");

    lampVoice.ended();
    expect(lampVoice.session()).toEqual(LAMP_VOICE_SILENT);
  });
});
