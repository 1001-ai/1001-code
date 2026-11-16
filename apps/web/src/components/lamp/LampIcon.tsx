import { AgentGlyph, type AgentGlyphProps } from "@1001-private/lamp";

/**
 * The voice agent's icon, from `@1001-private/lamp`: the private build when T3CODE_PRIVATE_DIR
 * names a private checkout, otherwise a public microphone icon.
 */
export function LampIcon({
  thinking = false,
  ...props
}: Omit<AgentGlyphProps, "state"> & { readonly thinking?: boolean }) {
  return <AgentGlyph strokeWidth={1.5} state={thinking ? "thinking" : "idle"} {...props} />;
}
