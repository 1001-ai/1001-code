/**
 * Messages another agent sent into a thread: tinted blue so they never read as the user's own,
 * and open with their full text. The tint mixes the theme's info blue into the message surface,
 * the way guests' messages mix in theirs.
 */
export const AGENT_MESSAGE_STARTS_OPEN = true;

export const AGENT_MESSAGE_BUBBLE_CLASS_NAME =
  "bg-[color-mix(in_srgb,var(--info)_14%,var(--message-surface))]";

/** The header's icon, sender and chevron take the info blue; the summary keeps the text colour. */
export const AGENT_MESSAGE_HEADER_CLASS_NAME =
  "[--contrast-muted-foreground:var(--info-foreground)]";
