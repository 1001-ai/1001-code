import { expect, it } from "vite-plus/test";

import { VoiceAgentError, voiceAgentOpenFailureMessage } from "./voiceAgent.ts";

it("says in plain words why the voice agent could not be opened", () => {
  expect(voiceAgentOpenFailureMessage(new VoiceAgentError({ reason: "thread-not-found" }))).toBe(
    "This chat no longer exists, so the voice agent has nothing to open over.",
  );
  expect(voiceAgentOpenFailureMessage(new VoiceAgentError({ reason: "not-delivered" }))).toBe(
    "The server could not start the voice agent's answer. Check that Claude answers in a chat, then open this again.",
  );
  expect(
    voiceAgentOpenFailureMessage({ _tag: "EnvironmentAuthorizationError", message: "Denied." }),
  ).toBe("This connection is not allowed to use the voice agent on this server.");
  // A closed socket, a timeout or a defect carries no reason of the voice agent's.
  for (const transport of [new Error("socket closed"), { reason: "elsewhere" }, null, undefined]) {
    expect(voiceAgentOpenFailureMessage(transport)).toBe(
      "The server did not answer. Check the connection to this environment, then open the voice agent again.",
    );
  }
});
