import { Mic } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * The public build's `@1001-private/lamp`: a microphone icon with the private module's props, so
 * `LampIcon` builds without the private checkout that T3CODE_PRIVATE_DIR names (see fork/README.md).
 */
export type AgentGlyphState = "idle" | "hover" | "thinking";

export interface AgentGlyphProps extends Omit<ComponentProps<"svg">, "children"> {
  /** Read only by the private build. */
  readonly state?: AgentGlyphState | undefined;
  /** @default 24 */
  readonly size?: number | string | undefined;
  /** @default 2 */
  readonly strokeWidth?: number | undefined;
  /** Read only by the private build. */
  readonly reducedMotion?: boolean | undefined;
}

export function AgentGlyph({
  state: _state,
  reducedMotion: _reducedMotion,
  size = 24,
  strokeWidth = 2,
  "aria-label": ariaLabel,
  ...props
}: AgentGlyphProps) {
  const named = ariaLabel !== undefined;
  return (
    <Mic
      size={size}
      strokeWidth={strokeWidth}
      role={named ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={named ? undefined : true}
      {...props}
    />
  );
}
