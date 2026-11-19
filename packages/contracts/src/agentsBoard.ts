import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import {
  TeamCatalogProjectKey,
  TeamCatalogRepository,
  teamCatalogHttpsUrl,
} from "./teamCatalog.ts";

/**
 * The agents board is a branch that holds no product code, in a team project's repository or
 * the one its catalog file names: agents write `reports/<agent-id>.md`, people's messages to
 * them sit in `inbox/<agent-id>.md` and `inbox/all.md`, and screenshots in
 * `media/<agent-id>/<file>`. It is all text other agents wrote, so every field is capped and plain.
 */
export const AGENTS_BOARD_DEFAULT_BRANCH = "agent-reports";
export const AGENTS_BOARD_REPORTS_DIRECTORY = "reports";
export const AGENTS_BOARD_INBOX_DIRECTORY = "inbox";
export const AGENTS_BOARD_MEDIA_DIRECTORY = "media";
/** The inbox file whose messages are for every agent. */
export const AGENTS_BOARD_INBOX_EVERYONE = "all";
export const AGENTS_BOARD_MEDIA_MAX_BYTES = 500 * 1024;
export const AGENTS_BOARD_TEXT_MAX_LENGTH = 2_000;
export const AGENTS_BOARD_FIELD_MAX_LENGTH = 300;
/** How a message sent from the voice agent says where it came from. */
export const AGENTS_BOARD_VIA_VOICE_AGENT = "voice agent";

const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,98}[A-Za-z0-9])?$/;

/** A branch name git takes as written: no option, refspec or revision syntax. */
export function isAgentsBoardBranch(branch: string): boolean {
  return (
    BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.includes("/.") &&
    !branch.includes("./") &&
    !branch.split("/").some((part) => part.endsWith(".lock"))
  );
}

export const AgentsBoardBranch = Schema.String.check(
  Schema.makeFilter((branch: string) => isAgentsBoardBranch(branch) || "Not a branch name."),
);
export type AgentsBoardBranch = typeof AgentsBoardBranch.Type;

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `<owner>-<number>`, such as `sam-2`: the name of an agent's report and inbox files. */
export const AgentsBoardAgentId = Schema.String.check(Schema.isPattern(AGENT_ID_PATTERN));
export type AgentsBoardAgentId = typeof AgentsBoardAgentId.Type;

export function isAgentsBoardAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}

export const AGENTS_BOARD_MEDIA_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const;
export type AgentsBoardMediaType =
  (typeof AGENTS_BOARD_MEDIA_TYPES)[keyof typeof AGENTS_BOARD_MEDIA_TYPES];

const MEDIA_PATH_PATTERN =
  /^media\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(png|jpe?g|webp|gif)$/i;

/**
 * `media/<agent-id>/<file>` with an image extension, and nothing else: no other folder, no `..`,
 * no backslash, no absolute path. Returns the content type the extension stands for.
 */
export function agentsBoardMediaType(path: string): AgentsBoardMediaType | null {
  const extension = MEDIA_PATH_PATTERN.exec(path)?.[1]?.toLowerCase();
  if (extension === undefined || path.includes("..")) return null;
  return AGENTS_BOARD_MEDIA_TYPES[extension as keyof typeof AGENTS_BOARD_MEDIA_TYPES];
}

export const AgentsBoardMediaPath = Schema.String.check(
  Schema.makeFilter(
    (path: string) => agentsBoardMediaType(path) !== null || "Not a media file of the board.",
  ),
);
export type AgentsBoardMediaPath = typeof AgentsBoardMediaPath.Type;

export const AgentsBoardStatus = Schema.Literals([
  "started",
  "working",
  "blocked",
  "question",
  "done",
]);
export type AgentsBoardStatus = typeof AgentsBoardStatus.Type;

const Text = Schema.String.check(Schema.isMaxLength(AGENTS_BOARD_TEXT_MAX_LENGTH));
const Field = Schema.String.check(Schema.isMaxLength(AGENTS_BOARD_FIELD_MAX_LENGTH));

export const AgentsBoardAgent = Schema.Struct({
  id: AgentsBoardAgentId,
  owner: Schema.NullOr(Field),
  tool: Schema.NullOr(Field),
  task: Schema.NullOr(Field),
  started: Schema.NullOr(IsoDateTime),
  /** Of the agent's newest message; null when it has none or wrote another word. */
  latestStatus: Schema.NullOr(AgentsBoardStatus),
  latestAt: Schema.NullOr(IsoDateTime),
  /** What the newest message asks of a person; null for "nothing". */
  needs: Schema.NullOr(Field),
});
export type AgentsBoardAgent = typeof AgentsBoardAgent.Type;

export const AgentsBoardAgentMessage = Schema.TaggedStruct("agent", {
  /** The file and the entry's place in it, so it stays the same as the file grows. */
  id: Schema.String,
  agentId: AgentsBoardAgentId,
  at: IsoDateTime,
  status: Schema.NullOr(AgentsBoardStatus),
  text: Text,
  branch: Schema.NullOr(Field),
  pr: Schema.NullOr(Field),
  next: Schema.NullOr(Field),
  needs: Schema.NullOr(Field),
  media: Schema.Array(AgentsBoardMediaPath),
});
export type AgentsBoardAgentMessage = typeof AgentsBoardAgentMessage.Type;

/** A message to agents, written on a person's behalf. */
export const AgentsBoardPersonMessage = Schema.TaggedStruct("person", {
  id: Schema.String,
  /** The person's name; null when the entry does not say. */
  from: Schema.NullOr(Field),
  /** The agent it is for; null for every agent. */
  to: Schema.NullOr(AgentsBoardAgentId),
  at: IsoDateTime,
  text: Text,
  via: Schema.NullOr(Field),
});
export type AgentsBoardPersonMessage = typeof AgentsBoardPersonMessage.Type;

export const AgentsBoardMessage = Schema.Union([AgentsBoardAgentMessage, AgentsBoardPersonMessage]);
export type AgentsBoardMessage = typeof AgentsBoardMessage.Type;

export const AgentsBoardData = Schema.Struct({
  agents: Schema.Array(AgentsBoardAgent),
  /** Oldest first. */
  messages: Schema.Array(AgentsBoardMessage),
  /** Agents whose newest message is not `done`. */
  activeCount: NonNegativeInt,
  /** Agents whose newest message is blocked, a question, or asks something of a person. */
  needsPersonCount: NonNegativeInt,
  /** Files or messages were left out to stay within the size limits. */
  truncated: Schema.Boolean,
});
export type AgentsBoardData = typeof AgentsBoardData.Type;

export const AgentsBoardProject = Schema.Struct({
  key: TeamCatalogProjectKey,
  name: Schema.String,
});
export type AgentsBoardProject = typeof AgentsBoardProject.Type;

export const AgentsBoardUnavailableReason = Schema.Literals(["no-catalog", "not-in-catalog"]);
export type AgentsBoardUnavailableReason = typeof AgentsBoardUnavailableReason.Type;

const OfProject = {
  project: AgentsBoardProject,
  branch: AgentsBoardBranch,
  /** The repository that holds the branch, as the catalog names it, when not the project's own. */
  repository: Schema.optionalKey(TeamCatalogRepository),
  /** A fetch of the branch is running. */
  refreshing: Schema.Boolean,
};

export const AgentsBoardSnapshot = Schema.Union([
  /** The thread's project is not a team project, so it has no agents branch. */
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: AgentsBoardUnavailableReason }),
  /** Nothing fetched yet. */
  Schema.Struct({ status: Schema.Literal("loading"), ...OfProject }),
  /** The repository has no such branch yet, which is where every project starts. */
  Schema.Struct({ status: Schema.Literal("missing-branch"), ...OfProject }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    ...OfProject,
    board: AgentsBoardData,
    fetchedAt: IsoDateTime,
    /** The last fetch's failure while this board, from an earlier fetch, is still shown. */
    failure: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("failed"), ...OfProject, failure: Schema.String }),
]);
export type AgentsBoardSnapshot = typeof AgentsBoardSnapshot.Type;

export const AgentsBoardProjectInput = Schema.Struct({ projectId: ProjectId });
export type AgentsBoardProjectInput = typeof AgentsBoardProjectInput.Type;

export const AgentsBoardSetBranchInput = Schema.Struct({
  projectId: ProjectId,
  /** Null goes back to the default branch name. */
  branch: Schema.NullOr(AgentsBoardBranch),
});
export type AgentsBoardSetBranchInput = typeof AgentsBoardSetBranchInput.Type;

export const AgentsBoardMediaInput = Schema.Struct({
  projectId: ProjectId,
  path: AgentsBoardMediaPath,
});
export type AgentsBoardMediaInput = typeof AgentsBoardMediaInput.Type;

/** A message for an agent's inbox, or for every agent's, written on the signed-in person's behalf. */
export interface AgentsBoardInboxMessageInput {
  readonly projectId: ProjectId;
  /** An agent on the board, or `AGENTS_BOARD_INBOX_EVERYONE`. */
  readonly to: string;
  readonly text: string;
  readonly maxLength: number;
  readonly via: string;
}

export interface AgentsBoardInboxMessageSent {
  /** The agent it went to; null for every agent. */
  readonly to: string | null;
  /** The name it is signed with. */
  readonly from: string;
  readonly at: string;
  readonly text: string;
}

export const AgentsBoardMedia = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  /** At most `AGENTS_BOARD_MEDIA_MAX_BYTES` before encoding. */
  base64: Schema.String,
});
export type AgentsBoardMedia = typeof AgentsBoardMedia.Type;

export const AgentsBoardErrorReason = Schema.Literals([
  "not-a-team-project",
  "not-fetched",
  "not-found",
  "too-large",
  "not-an-image",
  "settings-unsaved",
  "empty-message",
  "message-too-long",
  "unknown-agent",
  "not-signed-in",
  "not-sent",
]);
export type AgentsBoardErrorReason = typeof AgentsBoardErrorReason.Type;

const ERROR_MESSAGES: Record<AgentsBoardErrorReason, string> = {
  "not-a-team-project": "This project is not a team project.",
  "not-fetched": "The agents branch has not been fetched yet.",
  "not-found": "The agents branch has no such file.",
  "too-large": "The file is larger than 500 KB.",
  "not-an-image": "The file is not the kind of image its name says.",
  "settings-unsaved": "The branch name could not be saved.",
  "empty-message": "The message is empty.",
  "message-too-long": "The message is too long.",
  "unknown-agent": "The agents board has no such agent.",
  "not-signed-in": "The GitHub CLI is not signed in, so the message cannot be signed.",
  "not-sent": "The message could not be pushed to the agents branch.",
};

export class AgentsBoardError extends Schema.TaggedError<AgentsBoardError>()("AgentsBoardError", {
  reason: AgentsBoardErrorReason,
}) {
  override get message(): string {
    return ERROR_MESSAGES[this.reason];
  }
}

/**
 * The one line a person gives an agent, so it reads the branch's instructions. A board kept in
 * another repository is named by URL, because `origin` is the project's own repository.
 */
export function agentsBoardAgentCommand(branch: string, repository?: string): string {
  return repository === undefined
    ? `git fetch origin ${branch} && git show origin/${branch}:README.md`
    : `git fetch ${teamCatalogHttpsUrl(repository)} ${branch} && git show FETCH_HEAD:README.md`;
}
