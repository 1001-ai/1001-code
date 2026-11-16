import type { AgentsBoardData, AgentsBoardStatus } from "@t3tools/contracts";

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** The header's counts: "3 agents · 2 active · 1 needs a person". */
export function agentsBoardCounts(
  board: Pick<AgentsBoardData, "agents" | "activeCount" | "needsPersonCount">,
): string {
  return [
    count(board.agents.length, "agent", "agents"),
    `${board.activeCount} active`,
    count(board.needsPersonCount, "needs a person", "need a person"),
  ].join(" · ");
}

const STATUS_LABELS: Record<AgentsBoardStatus, string> = {
  started: "Started",
  working: "Working",
  blocked: "Blocked",
  question: "Question",
  done: "Done",
};

export function agentsBoardStatusLabel(status: AgentsBoardStatus): string {
  return STATUS_LABELS[status];
}

const STATUS_TONES = {
  started: "outline",
  working: "info",
  blocked: "error",
  question: "warning",
  done: "success",
} as const satisfies Record<AgentsBoardStatus, string>;

export function agentsBoardStatusTone(status: AgentsBoardStatus) {
  return STATUS_TONES[status];
}

/** Who a person's message is for: one agent, or all of them. */
export function agentsBoardRecipient(to: string | null): string {
  return to ?? "everyone";
}

/** A time from the branch in the reader's own format; the text itself when it is not a time. */
export function agentsBoardTime(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime())
    ? at
    : time.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** The file name of a media path, as the image's name. */
export function agentsBoardMediaName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
