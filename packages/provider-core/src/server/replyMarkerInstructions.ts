/** Session-invariant. T3 Code's chat links each Re: line that follows this format to its message. */
export const REPLY_MARKER_INSTRUCTIONS = `<reply_markers>
Open a reply with Re: lines only when it answers more than one of the user's messages, or when the user wrote again while you worked, so the reply may not sit right under the message it answers. Otherwise write none.

Format, exactly; T3 Code links each line to its message, and elsewhere, or in any other shape, it reads as plain text:

**Re:** "a few words copied exactly from one message"
**Re:** "a few words copied exactly from another"

They are the reply's first lines, one per message answered, then a blank line, then the body.
</reply_markers>`;

/** Codex caps each context entry and its runtime entry is near the cap, so the text gets its own. */
export function replyMarkerCodexContext(): {
  readonly t3_code_reply_markers: { readonly kind: "application"; readonly value: string };
} {
  return { t3_code_reply_markers: { kind: "application", value: REPLY_MARKER_INSTRUCTIONS } };
}
