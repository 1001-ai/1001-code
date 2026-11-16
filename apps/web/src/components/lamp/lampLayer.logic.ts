/** The feature's working name, in the one place the interface reads it from. */
export const LAMP_NAME = "Voice agent";
/** The name after a verb, as in "Toggle voice agent". A proper name would stay as written. */
export const LAMP_NAME_IN_SENTENCE = LAMP_NAME.toLowerCase();

export interface LampLayerState {
  /** The thread whose title bar shows the button; the shortcut and the palette act on it. */
  readonly target: string | null;
  /** The thread whose chat the layer covers. */
  readonly openIn: string | null;
}

export const LAMP_LAYER_CLOSED: LampLayerState = { target: null, openIn: null };

export function isLampLayerOpenIn(state: LampLayerState, threadKey: string | null): boolean {
  return state.openIn !== null && state.openIn === threadKey;
}

/** The shortcut and the palette have something to act on: a thread on screen, or an open layer. */
export function canToggleLampLayer(state: LampLayerState): boolean {
  return state.target !== null || state.openIn !== null;
}

/** A thread's button came on screen. A layer left open over another thread closes. */
export function lampThreadShown(state: LampLayerState, threadKey: string): LampLayerState {
  return { target: threadKey, openIn: state.openIn === threadKey ? threadKey : null };
}

/**
 * A thread's button left the screen. Its layer stays as it was: the button also leaves when
 * the right panel opens or closes and the controls are drawn somewhere else.
 */
export function lampThreadHidden(state: LampLayerState, threadKey: string): LampLayerState {
  return state.target === threadKey ? { ...state, target: null } : state;
}

/** A maximized panel covers the thread's chat: its layer closes, and nothing opens one. */
export function lampThreadCovered(state: LampLayerState, threadKey: string): LampLayerState {
  return {
    target: state.target === threadKey ? null : state.target,
    openIn: state.openIn === threadKey ? null : state.openIn,
  };
}

/** A prompt was sent from a thread's prompt box: the layer over that thread closes. */
export function lampPromptSent(state: LampLayerState, threadKey: string): LampLayerState {
  return state.openIn === threadKey ? { ...state, openIn: null } : state;
}

export function lampLayerToggled(state: LampLayerState): LampLayerState {
  if (state.openIn !== null) return { ...state, openIn: null };
  return state.target === null ? state : { ...state, openIn: state.target };
}

export function lampLayerClosed(state: LampLayerState): LampLayerState {
  return state.openIn === null ? state : { ...state, openIn: null };
}

/**
 * Find reads and scrolls the list the layer covers, so the two never share a thread: whichever
 * opens second closes the other. This is the find that an opening layer closes, and the find
 * whose opening closes the layer.
 */
export function lampLayerSharesThreadWithFind(
  state: LampLayerState,
  findThreadKey: string | null,
): boolean {
  return isLampLayerOpenIn(state, findThreadKey);
}

/** The layer has the keyboard while it is open, unless a text field has focus or a popup is open. */
export function lampHoldsKeyboard(where: {
  readonly open: boolean;
  readonly inEditable: boolean;
  readonly popupOpen: boolean;
}): boolean {
  return where.open && !where.inEditable && !where.popupOpen;
}

/** Space on its own, held to talk. A repeat is the same key, so a held Space types nothing. */
export function isLampTalkKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "keyCode">,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return event.key === " " && !event.metaKey && !event.ctrlKey && !event.altKey;
}
