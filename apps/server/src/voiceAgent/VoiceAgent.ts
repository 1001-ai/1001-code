import {
  AGENTS_BOARD_INBOX_EVERYONE,
  AGENTS_BOARD_VIA_VOICE_AGENT,
  type AgentsBoardData,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ThreadId,
  VOICE_AGENT_DEFAULT_MODEL,
  VOICE_AGENT_INBOX_MESSAGE_MAX_LENGTH,
  VOICE_AGENT_THREAD_TITLE,
  VoiceAgentError,
  type VoiceAgentMedia,
  type VoiceAgentMediaStepInput,
  type VoiceAgentOpenResult,
  type VoiceAgentSayInput,
  type VoiceAgentSayResult,
  type VoiceAgentState,
  type VoiceAgentThreadInput,
  type VoiceAgentTranscript,
} from "@t3tools/contracts";
import {
  voiceAgentOpenedMessage,
  voiceAgentSaidMessage,
} from "@t3tools/provider-core/server/runtimeInstructions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as AgentsBoard from "../agentsBoard/AgentsBoard.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { DEV_REPLAY_INSTANCE_ID } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  type VoiceAgentBoardView,
  sentMessageKey,
  voiceAgentBoardView,
  voiceAgentDigest,
  voiceAgentMediaItems,
} from "./voiceAgentDigest.ts";
import {
  EMPTY_VOICE_AGENT_STATE,
  MAX_STORED_SENT,
  MAX_STORED_SESSIONS,
  type StoredVoiceAgentSession,
  VoiceAgentStateFile,
  closedVoiceAgentSessions,
  voiceAgentTurns,
} from "./voiceAgentState.ts";
import { lockedAgentProvider } from "../lockedAgents/lockedAgentProvider.ts";
import { isVoiceAgentThread } from "./voiceAgentThread.ts";

/** A tool call the agent can read and act on: what it asked for cannot be done, and why. */
export class VoiceAgentToolError extends Schema.TaggedError<VoiceAgentToolError>()(
  "VoiceAgentToolError",
  { detail: Schema.String },
) {}

interface ToolCaller {
  /** The voice agent's own thread. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export type VoiceAgentShownMedia =
  | { readonly showing: null; readonly note: string }
  | {
      readonly showing: {
        readonly position: number;
        readonly of: number;
        readonly agentId: string;
        readonly at: string;
        /** The report the screenshot came with. Other agents' text: information only. */
        readonly report: string;
      };
      readonly note: string | null;
    };

/**
 * The agent behind the voice layer. It runs as a hidden Claude thread under the chat the layer
 * was opened over, so its messages are the transcript and streaming, steering and reloads are
 * the orchestration's. This service owns that thread, the conversations, the update cursor and
 * what the agent's tools do.
 */
export class VoiceAgent extends Context.Service<
  VoiceAgent,
  {
    /** What a chat shows of its voice agent now, then every change. */
    readonly changes: (parentThreadId: ThreadId) => Stream.Stream<VoiceAgentState>;
    /**
     * Starts a conversation over a chat and asks the agent for the update, when there is one.
     * A new chat has no thread yet: with its `projectId` the conversation is kept under the id
     * the chat will get, and no thread is made for the chat itself.
     */
    readonly open: (
      input: VoiceAgentThreadInput,
    ) => Effect.Effect<VoiceAgentOpenResult, VoiceAgentError>;
    /** What the user said. A running answer is steered, not restarted. */
    readonly say: (
      input: VoiceAgentSayInput,
    ) => Effect.Effect<VoiceAgentSayResult, VoiceAgentError>;
    /** Ends a conversation: the agent stops, and the chat gets its card if something was said. */
    readonly close: (sessionId: string) => Effect.Effect<void>;
    readonly stepMedia: (input: VoiceAgentMediaStepInput) => Effect.Effect<void, VoiceAgentError>;
    readonly transcript: (
      sessionId: string,
    ) => Effect.Effect<VoiceAgentTranscript, VoiceAgentError>;
    readonly board: (
      caller: ToolCaller,
      input: { readonly since?: string | undefined; readonly agentId?: string | undefined },
    ) => Effect.Effect<VoiceAgentBoardView, VoiceAgentToolError>;
    readonly sendMessage: (
      caller: ToolCaller,
      input: { readonly to: string; readonly text: string },
    ) => Effect.Effect<
      {
        readonly sent: true;
        readonly to: string;
        readonly signedAs: string;
        readonly text: string;
      },
      VoiceAgentToolError
    >;
    readonly showMedia: (
      caller: ToolCaller,
      input: {
        readonly action: "show" | "next" | "previous" | "hide";
        readonly agentId?: string | undefined;
      },
    ) => Effect.Effect<VoiceAgentShownMedia, VoiceAgentToolError>;
  }
>()("t3/voiceAgent/VoiceAgent") {}

const BOARD_REFRESH_TIMEOUT = "8 seconds";

const NO_CLAUDE_MESSAGE =
  "The voice agent runs on Claude, and no Claude provider is ready on this server. Install Claude Code and sign in to it under Settings, then open this again.";
const CLAUDE_OFF_FOR_PROJECT_MESSAGE =
  "The voice agent runs on Claude, and Claude is turned off for this project. Turn it on in the project's settings, then open this again.";

/**
 * For trying the layer without a paid turn: a dev server started with `T3CODE_VOICE_AGENT_REPLAY=1`
 * runs the voice thread on the free Replay provider, which plays a recording of two short
 * answers. No model answers and no tool runs, so it shows the stream, the voice and the card only.
 */
const DEV_REPLAY_SELECTION: ModelSelection = {
  instanceId: DEV_REPLAY_INSTANCE_ID,
  model: "multi-turn",
};

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceAgentStateFile));
const encodeState = Schema.encodeSync(Schema.fromJsonString(VoiceAgentStateFile));

/** What the voice thread takes from its chat: a chat with no thread yet has only its project. */
type VoiceAgentParent = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "branch" | "worktreePath"
>;

interface ShownMedia {
  readonly sessionId: string;
  readonly items: ReturnType<typeof voiceAgentMediaItems>;
  readonly index: number;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const agentsBoard = yield* AgentsBoard.AgentsBoard;

  // Only a server run from source has the Replay provider, so only there can the switch be on.
  const replay =
    config.devUrl !== undefined &&
    (yield* HostProcess.Environment).T3CODE_VOICE_AGENT_REPLAY === "1";
  const root = path.join(config.stateDir, "voice-agent");
  const statePath = path.join(root, "state.json");
  const lock = yield* Semaphore.make(1);
  const signals = yield* PubSub.unbounded<void>();
  const publish = PubSub.publish(signals, undefined).pipe(Effect.asVoid);
  // Screenshots in front of the user, by conversation. Gone with the server run, like the layer.
  const shown = new Map<string, ShownMedia>();
  let commandCount = 0;

  const loaded = yield* fileSystem.readFileString(statePath).pipe(
    Effect.map(decodeState),
    Effect.map((file) => (Option.isSome(file) ? file.value : EMPTY_VOICE_AGENT_STATE)),
    Effect.orElseSucceed(() => EMPTY_VOICE_AGENT_STATE),
  );
  let state: VoiceAgentStateFile = loaded;
  // No layer survives a server restart: a conversation the last run left open has ended. It is
  // closed, with its card, when its chat is next read.
  const leftOpen = new Set(
    loaded.sessions.flatMap((session) => (session.closedAt === null ? [session.id] : [])),
  );

  const save = Effect.fn("VoiceAgent.save")(function* (next: VoiceAgentStateFile) {
    state = {
      ...next,
      sessions: next.sessions.slice(-MAX_STORED_SESSIONS),
      sent: next.sent.slice(-MAX_STORED_SENT),
    };
    yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(statePath, encodeState(state))),
      Effect.catch((cause) =>
        Effect.logWarning("The voice agent could not save its state.", cause),
      ),
    );
  });

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );

  // The time and a counter: unique within a run, and never reused after a restart.
  const nextId = Effect.fnUntraced(function* (prefix: string) {
    commandCount += 1;
    return `${prefix}-${(yield* Clock.currentTimeMillis).toString(36)}-${commandCount}`;
  });

  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
      Effect.orElseSucceed(() => null),
    );

  const readTurns = Effect.fn("VoiceAgent.readTurns")(function* (session: StoredVoiceAgentSession) {
    const records = yield* threads
      .getThreadRecords(ThreadId.make(session.voiceThreadId), ["messages"])
      .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
    return voiceAgentTurns(records.messages, session);
  });

  /** The board as the last fetch left it, after one try to fetch it again. */
  const readBoard = Effect.fn("VoiceAgent.readBoard")(function* (projectId: ProjectId) {
    const snapshot = yield* agentsBoard.refresh(projectId).pipe(
      Effect.timeoutOption(BOARD_REFRESH_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => agentsBoard.read(projectId),
          onSome: Effect.succeed,
        }),
      ),
    );
    return snapshot.status === "ready"
      ? { key: snapshot.project.key, board: snapshot.board }
      : null;
  });

  const openSessionOfThread = (voiceThreadId: string) =>
    state.sessions.findLast(
      (session) => session.voiceThreadId === voiceThreadId && session.closedAt === null,
    );

  /** Ends a conversation. The caller holds the lock. */
  const finish = Effect.fn("VoiceAgent.finish")(function* (session: StoredVoiceAgentSession) {
    const closedAt = yield* nowIso;
    const voiceThreadId = ThreadId.make(session.voiceThreadId);
    const shell = yield* shellOf(voiceThreadId);
    // Nobody is listening any more: the agent stops instead of finishing its answer.
    if (shell !== null && shell.activeRunId !== null) {
      yield* threads
        .interruptThread({
          projectId: shell.projectId,
          commandId: CommandId.make(yield* nextId(`voice-agent:${session.id}:close`)),
          threadId: voiceThreadId,
          reason: "The voice agent layer was closed.",
        })
        .pipe(Effect.ignore);
    }
    const turns = yield* readTurns({ ...session, closedAt });
    shown.delete(session.id);
    const heardUpdate = turns.some((turn) => turn.role === "agent");
    yield* save({
      ...state,
      // The update counts as given once the agent said something in this conversation.
      cursors:
        session.pendingCursor !== undefined && heardUpdate
          ? { ...state.cursors, [session.pendingCursor.key]: session.pendingCursor.cursor }
          : state.cursors,
      sessions: state.sessions.flatMap((candidate) =>
        candidate.id !== session.id
          ? [candidate]
          : turns.length === 0
            ? []
            : [{ ...candidate, closedAt, turns: turns.length }],
      ),
    });
  });

  const closeLeftOpen = Effect.fn("VoiceAgent.closeLeftOpen")(function* (parentThreadId: string) {
    if (leftOpen.size === 0) return;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        for (const session of state.sessions.filter(
          (candidate) => candidate.parentThreadId === parentThreadId && leftOpen.has(candidate.id),
        )) {
          leftOpen.delete(session.id);
          if (session.closedAt === null) yield* finish(session);
        }
      }),
    );
  });

  /** The chat's voice thread, made on first use. */
  const ensureThread = Effect.fn("VoiceAgent.ensureThread")(function* (
    parent: VoiceAgentParent,
    modelSelection: ModelSelection,
  ) {
    const known = state.threads[parent.id];
    const existing = known === undefined ? null : yield* shellOf(ThreadId.make(known));
    // Only a thread that carries the marker is reused, since the tool lock follows the marker,
    // and only one on the same provider: a thread never moves between Claude and the recording.
    if (
      existing !== null &&
      isVoiceAgentThread(existing) &&
      existing.modelSelection.instanceId === modelSelection.instanceId
    ) {
      return existing.id;
    }
    const threadId = ThreadId.make(yield* nextId(`voice:${parent.id}`));
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`voice-agent:create:${threadId}`),
      threadId,
      projectId: parent.projectId,
      title: VOICE_AGENT_THREAD_TITLE,
      modelSelection,
      // The lowest mode. The tool lock does not depend on it, but nothing should ask for more.
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: parent.branch,
      worktreePath: parent.worktreePath,
      voiceAgentOf: parent.id,
      createdBy: "system",
      creationSource: "server",
    });
    yield* save({ ...state, threads: { ...state.threads, [parent.id]: threadId } });
    return threadId;
  });

  const send = Effect.fn("VoiceAgent.send")(function* (
    session: StoredVoiceAgentSession,
    kind: string,
    text: string,
  ) {
    const voiceThreadId = ThreadId.make(session.voiceThreadId);
    const shell = yield* shellOf(voiceThreadId);
    if (shell === null) return yield* new VoiceAgentError({ reason: "session-not-found" });
    const id = yield* nextId(`voice-agent:${session.id}:${kind}`);
    return yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(id),
        threadId: voiceThreadId,
        messageId: MessageId.make(id),
        text,
        attachments: [],
        // Steers a turn that is running, so the agent is nudged and never restarted.
        mode: "auto",
        // The constant is the setting: a thread made for another model follows it from here on.
        ...(replay || shell.modelSelection.model === VOICE_AGENT_DEFAULT_MODEL
          ? {}
          : {
              modelSelection: {
                instanceId: shell.modelSelection.instanceId,
                model: VOICE_AGENT_DEFAULT_MODEL,
              },
            }),
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("The voice agent's turn did not start.", cause),
        ),
        Effect.mapError(() => new VoiceAgentError({ reason: "not-delivered" })),
      );
  });

  const open: VoiceAgent["Service"]["open"] = Effect.fn("VoiceAgent.open")(function* (input) {
    const parentId = input.threadId;
    const shell = yield* shellOf(parentId);
    if (shell !== null && isVoiceAgentThread(shell)) {
      return yield* new VoiceAgentError({ reason: "thread-not-found" });
    }
    // A new chat has no thread until its first message, and making one is not this service's
    // to do: the voice thread hangs under the id the chat will get, in the chat's project.
    const parent: VoiceAgentParent | null =
      shell ??
      (input.projectId === undefined
        ? null
        : { id: parentId, projectId: input.projectId, branch: null, worktreePath: null });
    if (parent === null) return yield* new VoiceAgentError({ reason: "thread-not-found" });
    const provider = replay
      ? undefined
      : lockedAgentProvider(yield* registry.getProviders, "voice");
    const selection: ModelSelection | undefined = replay
      ? DEV_REPLAY_SELECTION
      : provider && { instanceId: provider.instanceId, model: VOICE_AGENT_DEFAULT_MODEL };
    const enabled =
      selection !== undefined &&
      (yield* threads.isProviderInstanceEnabledForProject({
        projectId: parent.projectId,
        instanceId: selection.instanceId,
      }));
    if (selection === undefined || !enabled) {
      return {
        status: "unavailable",
        message: selection === undefined ? NO_CLAUDE_MESSAGE : CLAUDE_OFF_FOR_PROJECT_MESSAGE,
      } as const;
    }
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // One conversation a chat: a layer that never said it closed is closed now.
        for (const dangling of state.sessions.filter(
          (session) => session.parentThreadId === parentId && session.closedAt === null,
        )) {
          yield* finish(dangling);
        }
        const voiceThreadId = yield* ensureThread(parent, selection).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("The voice agent's thread could not be made.", cause),
          ),
          Effect.mapError(() => new VoiceAgentError({ reason: "not-delivered" })),
        );
        // Once a conversation: who the user is to the other agents, read where the board signs.
        const [board, userName] = yield* Effect.all(
          [
            readBoard(parent.projectId),
            agentsBoard.signerName.pipe(
              Effect.timeoutOption(BOARD_REFRESH_TIMEOUT),
              Effect.map(Option.getOrNull),
            ),
          ],
          { concurrency: 2 },
        );
        const openedAt = yield* nowIso;
        const digest =
          board === null
            ? null
            : voiceAgentDigest({
                board: board.board,
                cursor: state.cursors[board.key] ?? null,
                now: openedAt,
                ownSent: new Set(state.sent),
              });
        const session: StoredVoiceAgentSession = {
          id: yield* nextId("v"),
          parentThreadId: parentId,
          voiceThreadId,
          openedAt,
          closedAt: null,
          turns: 0,
          said: 0,
          userName,
          ...(board === null || digest === null || digest.changes === null
            ? {}
            : { pendingCursor: { key: board.key, cursor: digest.cursor } }),
        };
        yield* save({ ...state, sessions: [...state.sessions, session] });
        const ready = {
          status: "ready",
          sessionId: session.id,
          voiceThreadId,
          openedAt,
        } as const;
        const changes = digest?.changes ?? null;
        // Nothing new costs no turn: the layer says its one line itself. The recording always plays.
        if (changes === null && !replay) {
          yield* publish;
          return { ...ready, update: "nothing-new" } as const;
        }
        yield* send(session, "open", voiceAgentOpenedMessage(changes, userName));
        yield* publish;
        return { ...ready, update: "requested" } as const;
      }),
    );
  });

  const sessionOf = (sessionId: string) =>
    state.sessions.find((session) => session.id === sessionId);

  const say: VoiceAgent["Service"]["say"] = Effect.fn("VoiceAgent.say")(function* (input) {
    const session = sessionOf(input.sessionId);
    if (session === undefined) return yield* new VoiceAgentError({ reason: "session-not-found" });
    if (session.closedAt !== null) return yield* new VoiceAgentError({ reason: "session-closed" });
    const sent = yield* send(
      session,
      "say",
      voiceAgentSaidMessage({
        text: input.text,
        interruption: input.interruption,
        userName: session.userName,
      }),
    );
    yield* lock.withPermits(1)(
      save({
        ...state,
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id ? { ...candidate, said: candidate.said + 1 } : candidate,
        ),
      }),
    );
    return { delivery: sent.delivery };
  });

  const close: VoiceAgent["Service"]["close"] = Effect.fn("VoiceAgent.close")(function* (id) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const session = sessionOf(id);
        // A layer may say it closed twice, or after the server already closed it.
        if (session === undefined || session.closedAt !== null) return;
        yield* finish(session);
      }),
    );
    yield* publish;
  });

  const mediaOf = (parentThreadId: string): VoiceAgentMedia | null => {
    const session = state.sessions.findLast(
      (candidate) => candidate.parentThreadId === parentThreadId && candidate.closedAt === null,
    );
    const media = session === undefined ? undefined : shown.get(session.id);
    return media === undefined
      ? null
      : {
          sessionId: media.sessionId,
          items: media.items.map(({ path: mediaPath, agentId, at }) => ({
            path: mediaPath,
            agentId,
            at,
          })),
          index: media.index,
        };
  };

  const changes: VoiceAgent["Service"]["changes"] = (parentThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(signals);
        yield* closeLeftOpen(parentThreadId);
        const current = Effect.sync((): VoiceAgentState => ({
          sessions: closedVoiceAgentSessions(state, parentThreadId),
          media: mediaOf(parentThreadId),
        }));
        return Stream.concat(
          Stream.fromEffect(current),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => current)),
        ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
      }),
    );

  const stepMedia: VoiceAgent["Service"]["stepMedia"] = Effect.fn("VoiceAgent.stepMedia")(
    function* (input) {
      const media = shown.get(input.sessionId);
      if (media === undefined) {
        // Putting away what is already away is not an error.
        if (input.index === null) return;
        return yield* new VoiceAgentError({ reason: "session-not-found" });
      }
      if (input.index === null) shown.delete(input.sessionId);
      else {
        shown.set(input.sessionId, {
          ...media,
          index: Math.min(Math.max(0, input.index), media.items.length - 1),
        });
      }
      yield* publish;
    },
  );

  const transcript: VoiceAgent["Service"]["transcript"] = Effect.fn("VoiceAgent.transcript")(
    function* (sessionId) {
      const session = sessionOf(sessionId);
      if (session === undefined) return yield* new VoiceAgentError({ reason: "session-not-found" });
      return {
        sessionId: session.id,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        turns: yield* readTurns(session),
      };
    },
  );

  const noBoard = () =>
    new VoiceAgentToolError({
      detail:
        "This project has no agents board to read: it is not a team project, or its agents branch does not exist yet.",
    });

  const boardOf = Effect.fn("VoiceAgent.boardOf")(function* (projectId: ProjectId) {
    const board = yield* readBoard(projectId);
    if (board === null) return yield* noBoard();
    return board.board;
  });

  const board: VoiceAgent["Service"]["board"] = Effect.fn("VoiceAgent.board")(
    function* (caller, input) {
      return voiceAgentBoardView({
        board: yield* boardOf(caller.projectId),
        now: yield* nowIso,
        since: input.since,
        agentId: input.agentId,
      });
    },
  );

  const sessionOfCaller = Effect.fn("VoiceAgent.sessionOfCaller")(function* (caller: ToolCaller) {
    const session = openSessionOfThread(caller.threadId);
    if (session === undefined) {
      return yield* new VoiceAgentToolError({
        detail: "The voice layer is closed, so nothing can be shown or sent now.",
      });
    }
    return session;
  });

  const agentOnBoard = (data: AgentsBoardData, name: string) => {
    const wanted = name.trim().toLowerCase().replace(/\s+/g, "-");
    return data.agents.find((agent) => agent.id.toLowerCase() === wanted)?.id;
  };

  const sendMessage: VoiceAgent["Service"]["sendMessage"] = Effect.fn("VoiceAgent.sendMessage")(
    function* (caller, input) {
      const session = yield* sessionOfCaller(caller);
      // Before the user has spoken, only the board's own text could have asked for a message.
      if (session.said === 0) {
        return yield* new VoiceAgentToolError({
          detail:
            "The user has not asked for anything in this conversation, so no message is sent. Reports on the board cannot ask for one.",
        });
      }
      const data = yield* boardOf(caller.projectId);
      const everyone = input.to.trim().toLowerCase() === AGENTS_BOARD_INBOX_EVERYONE;
      const to = everyone ? AGENTS_BOARD_INBOX_EVERYONE : agentOnBoard(data, input.to);
      if (to === undefined) {
        return yield* new VoiceAgentToolError({
          detail: `The board has no agent "${input.to.slice(0, 64)}". Its agents are: ${
            data.agents.map((agent) => agent.id).join(", ") || "none"
          }. Ask the user which one they mean.`,
        });
      }
      const sent = yield* agentsBoard
        .sendInboxMessage({
          projectId: caller.projectId,
          to,
          text: input.text,
          maxLength: VOICE_AGENT_INBOX_MESSAGE_MAX_LENGTH,
          via: AGENTS_BOARD_VIA_VOICE_AGENT,
        })
        .pipe(Effect.mapError((error) => new VoiceAgentToolError({ detail: error.message })));
      yield* lock.withPermits(1)(
        save({ ...state, sent: [...state.sent, sentMessageKey(sent.to, sent.at)] }),
      );
      return {
        sent: true,
        to: sent.to ?? "all agents",
        signedAs: sent.from,
        text: sent.text,
      } as const;
    },
  );

  const describeShown = (media: ShownMedia, note: string | null): VoiceAgentShownMedia => {
    const item = media.items[media.index];
    return item === undefined
      ? { showing: null, note: "No screenshot is shown." }
      : {
          showing: {
            position: media.index + 1,
            of: media.items.length,
            agentId: item.agentId,
            at: item.at,
            report: item.report,
          },
          note,
        };
  };

  const showMedia: VoiceAgent["Service"]["showMedia"] = Effect.fn("VoiceAgent.showMedia")(
    function* (caller, input) {
      const session = yield* sessionOfCaller(caller);
      const current = shown.get(session.id);
      if (input.action === "hide") {
        shown.delete(session.id);
        yield* publish;
        return { showing: null, note: "The screenshots are put away." };
      }
      if (input.action === "show" || current === undefined) {
        const items = voiceAgentMediaItems(yield* boardOf(caller.projectId), input.agentId);
        if (items.length === 0) {
          return {
            showing: null,
            note:
              input.agentId === undefined
                ? "No report on the board has a screenshot."
                : "That agent's reports have no screenshot.",
          };
        }
        const media = { sessionId: session.id, items, index: 0 };
        shown.set(session.id, media);
        yield* publish;
        return describeShown(media, "This is the newest one.");
      }
      const index = current.index + (input.action === "next" ? 1 : -1);
      if (index < 0 || index >= current.items.length) {
        return describeShown(
          current,
          index < 0 ? "This is already the newest one." : "This is already the oldest one.",
        );
      }
      const media = { ...current, index };
      shown.set(session.id, media);
      yield* publish;
      return describeShown(media, null);
    },
  );

  return VoiceAgent.of({
    changes,
    open,
    say,
    close,
    stepMedia,
    transcript,
    board,
    sendMessage,
    showMedia,
  });
});

export const layer = Layer.effect(VoiceAgent, make);
