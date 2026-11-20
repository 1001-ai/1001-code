const LABEL_ATTRIBUTE = "data-pane-strip-label";

/**
 * Calls back when the strip's columns are added, removed or renamed. Columns are the scroller's
 * children and the children of the host the panes portal into, so only those lists are watched:
 * watching the whole subtree would fire on every node a streaming chat adds.
 */
export function observePaneStripColumns(scroller: HTMLElement, onChange: () => void): () => void {
  const lists = new MutationObserver(() => {
    watch();
    onChange();
  });
  const watch = () => {
    lists.disconnect();
    lists.observe(scroller, { childList: true });
    for (const child of scroller.children) lists.observe(child, { childList: true });
  };
  watch();
  const labels = new MutationObserver(onChange);
  labels.observe(scroller, { subtree: true, attributeFilter: [LABEL_ATTRIBUTE] });
  return () => {
    lists.disconnect();
    labels.disconnect();
  };
}
