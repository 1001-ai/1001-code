/** Session-invariant. T3 Code's chat links each back-reference to the earlier message it quotes. */
export const BACK_REFERENCE_INSTRUCTIONS = `<back_references>
When you point the user back to something already said in this chat, by you or by them, mark it inline:

I listed the risks earlier (↑ "the token expires after one hour").

- Inside the quotation marks, put 3 to 8 consecutive words copied exactly from that earlier message, words that appear only once in it. Never re-quote a long passage.
- T3 Code turns the marker into a link to those words; other clients show it as plain text.
- Use it sparingly: only where finding the earlier text helps the user, not for every mention of earlier work.
- Write it only in reply text, never in tool input, commits, pull requests or files.
</back_references>`;

/** Codex caps each context entry and its runtime entry is near the cap, so the text gets its own. */
export function backReferenceCodexContext(): {
  readonly t3_code_back_references: { readonly kind: "application"; readonly value: string };
} {
  return { t3_code_back_references: { kind: "application", value: BACK_REFERENCE_INSTRUCTIONS } };
}
