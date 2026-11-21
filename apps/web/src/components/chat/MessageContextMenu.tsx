import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CopyIcon, LinkIcon, MessagesSquareIcon, ReplyIcon, type LucideIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import { namedClipboardTarget, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { copyPromptLink } from "../promptLinks/copyPromptLink";
import { Menu, MenuItem } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useExchangeThreadOpener } from "./ExchangeThread";

/** What the message's Copy message button copies. */
export interface MessageCopy {
  readonly text: string;
  readonly extraFlavors?: Readonly<Record<string, string>>;
}

interface MenuAction {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly run: () => void;
}

/** Right-clicks here keep the browser's own menu. */
const NATIVE_MENU_SELECTOR =
  "a[href], input, textarea, select, img, video, audio, iframe, [contenteditable]:not([contenteditable=false])";

// The popup is portaled outside the composer shell, so it copies the shell's glass variables
// from ComposerSurface.tsx.
const COMPOSER_GLASS_VARS = [
  "[--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
  "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
  "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
  "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
  "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
].join(" ");

const POPUP_CLASS = [
  COMPOSER_GLASS_VARS,
  "relative flex min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-lg border border-(--chat-composer-outline) outline-none",
  "bg-(--chat-composer-glass-surface)/(--glass-opacity) backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)",
  "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:bg-(--chat-composer-glass-surface)",
  "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)] dark:inset-shadow-2xs dark:inset-shadow-(color:--chat-composer-highlight)",
  // Electron drag hit-testing ignores z-index, so the portaled menu opts out of drag regions.
  "[-webkit-app-region:no-drag]",
].join(" ");

async function copyMessage(copy: MessageCopy) {
  try {
    if (
      !(await writeTextToClipboard(copy.text, namedClipboardTarget("message"), copy.extraFlavors))
    )
      return;
    toastManager.add({ type: "success", title: "Message copied" });
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to copy",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

function keepsNativeMenu(event: MouseEvent<HTMLElement>) {
  if (event.defaultPrevented || !(event.target instanceof Element)) return true;
  // Portaled children, such as a chip's popup, are outside the message itself.
  if (!event.currentTarget.contains(event.target)) return true;
  if (event.target.closest(NATIVE_MENU_SELECTOR)) return true;
  const selection = document.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.containsNode(event.currentTarget, true)
  );
}

/**
 * A right-click menu for a message: View thread, Copy message, then Copy prompt link or Reply to
 * this response, each only when it applies. Mounts nothing until opened.
 */
export function useMessageContextMenu(input: {
  readonly rowId: string;
  readonly copy: MessageCopy | null;
  readonly promptLink?: string | null;
  readonly reply?: (() => void) | null;
}): {
  readonly onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  readonly menu: ReactNode;
} {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const openThread = useExchangeThreadOpener(input.rowId);
  const { copy, promptLink, reply } = input;
  const actions: MenuAction[] = [];
  if (openThread) actions.push({ label: "View thread", icon: MessagesSquareIcon, run: openThread });
  if (copy)
    actions.push({ label: "Copy message", icon: CopyIcon, run: () => void copyMessage(copy) });
  if (promptLink) {
    actions.push({
      label: "Copy prompt link",
      icon: LinkIcon,
      run: () => void copyPromptLink(promptLink),
    });
  }
  if (reply) actions.push({ label: "Reply to this response", icon: ReplyIcon, run: reply });

  if (actions.length === 0) return { menu: null };
  return {
    onContextMenu: (event) => {
      if (keepsNativeMenu(event)) return;
      event.preventDefault();
      setPosition({ x: event.clientX, y: event.clientY });
    },
    menu:
      position === null ? null : (
        <MessageContextMenuPopup
          position={position}
          actions={actions}
          onClose={() => setPosition(null)}
        />
      ),
  };
}

function MessageContextMenuPopup({
  position,
  actions,
  onClose,
}: {
  position: { x: number; y: number };
  actions: ReadonlyArray<MenuAction>;
  onClose: () => void;
}) {
  return (
    <Menu open onOpenChange={(open) => !open && onClose()}>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={{ getBoundingClientRect: () => new DOMRect(position.x, position.y, 0, 0) }}
          side="bottom"
          align="start"
          className="z-[130]"
        >
          <MenuPrimitive.Popup
            className={POPUP_CLASS}
            // React carries portal events up the row's tree, where the bubble and thread view listen.
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <div className="max-h-(--available-height) w-full overflow-y-auto p-1">
              {actions.map(({ label, icon: Icon, run }) => (
                <MenuItem key={label} onClick={run}>
                  <Icon />
                  {label}
                </MenuItem>
              ))}
            </div>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </Menu>
  );
}
