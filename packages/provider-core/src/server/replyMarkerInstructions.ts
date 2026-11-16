/** Session-invariant. T3 Code's chat links each Re: line that follows this format to its message. */
export const REPLY_MARKER_INSTRUCTIONS = `<reply_markers>
Open a reply with Re: lines in only two cases:
- It answers more than one of the user's messages.
- The user sent a message after you began this turn, such as a steer or a queued message, so the reply may land under a later message.
In every other reply, write no Re: lines.

Format, exactly; T3 Code links each line to its message, and other clients show it as plain text:

**Re:** "a few words copied exactly from one message"
**Re:** "a few words copied exactly from another"

- Write one line per message answered, in the order the user sent them.
- Inside the quotation marks, put 3 to 8 consecutive words copied exactly from that message, words only that message has. Do not paraphrase, shorten with an ellipsis, or add punctuation.
- Put nothing else on the line: no bullet, no blockquote, no other markdown, no text after the closing quotation mark.
- The lines are the reply's first lines, then one blank line, then the body. Never write them anywhere else: not later in the reply, and not in tool input, commits, pull requests or files.
</reply_markers>`;

/** Codex caps each context entry and its runtime entry is near the cap, so the text gets its own. */
export function replyMarkerCodexContext(): {
  readonly t3_code_reply_markers: { readonly kind: "application"; readonly value: string };
} {
  return { t3_code_reply_markers: { kind: "application", value: REPLY_MARKER_INSTRUCTIONS } };
}
