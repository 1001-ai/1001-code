import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { DraftId } from "~/composerDraftStore";
import {
  addReplyAnnotation,
  appendReplyAnnotations,
  clearReplyAnnotations,
  readReplyAnnotations,
  restoreReplyAnnotations,
} from "./replyAnnotations";
import { splitReplyAnnotations } from "./replyAnnotations.logic";

const citation = (start: number, comment?: string): AssistantCitation => ({
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  text: `quoted ${start}`,
  start,
  end: start + 8,
  prefix: "",
  suffix: "",
  ...(comment === undefined ? {} : { comment }),
});

describe("reply annotations", () => {
  it("sends annotations after the text and splits them back off a failed send", () => {
    const target = DraftId.make("draft-roundtrip");
    addReplyAnnotation(target, citation(0, "Is this verified?"));
    addReplyAnnotation(target, citation(20));
    addReplyAnnotation(target, citation(0));

    const sent = appendReplyAnnotations(target, "Fix these.\n");
    expect(sent).toBe(
      `Fix these.\n\n${serializeAssistantCitation(citation(0, "Is this verified?"))}\n${serializeAssistantCitation(citation(20))}`,
    );
    expect(splitReplyAnnotations(sent)).toEqual({
      text: "Fix these.",
      citations: [citation(0, "Is this verified?"), citation(20)],
    });

    clearReplyAnnotations(target);
    restoreReplyAnnotations(target, sent);
    expect(readReplyAnnotations(target).map((annotation) => annotation.citation)).toEqual([
      citation(0, "Is this verified?"),
      citation(20),
    ]);
  });

  it("sends annotations alone and leaves a quote inside the text in place", () => {
    const target = DraftId.make("draft-alone");
    addReplyAnnotation(target, citation(0));
    const sent = appendReplyAnnotations(target, "  ");
    expect(splitReplyAnnotations(sent)).toEqual({ text: "", citations: [citation(0)] });

    const inline = `See ${serializeAssistantCitation(citation(0))}`;
    expect(splitReplyAnnotations(inline)).toEqual({ text: inline, citations: [] });
  });
});
