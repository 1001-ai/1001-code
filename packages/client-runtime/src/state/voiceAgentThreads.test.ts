import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  withoutVoiceAgentThreads,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");

it("keeps the voice agent's thread out of every list a side chat shows in", () => {
  const root = v2ThreadShell;
  const sideChatLineage = {
    ...root.lineage,
    parentThreadId: root.id,
    relationshipToParent: "fork" as const,
    sideChat: true,
  };
  const sideChat = { ...root, id: ThreadId.make("side-chat"), lineage: sideChatLineage };
  const voice = {
    ...root,
    id: ThreadId.make("voice-1"),
    title: "Voice agent",
    lineage: { ...sideChatLineage, voiceAgent: true },
    // Even a request it could never make must not reach its chat's row.
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("ask"),
      createdAt: v2Now,
      kind: "command" as const,
    },
  };
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>({
      ...v2ShellSnapshot,
      threads: [root, sideChat, voice],
    }),
  );
  const threads = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([
        [
          environmentId,
          {
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Environment",
              httpBaseUrl: "https://example.test",
              wsBaseUrl: "wss://example.test",
            }),
            profile: Option.none(),
            enabled: true,
          },
        ],
      ]),
    }),
    snapshotAtom,
    hiddenThreadTagsAtom: () => Atom.make(null),
  });
  const registry = AtomRegistry.make();
  const parentRef = { environmentId, threadId: root.id };
  const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((thread) => thread.id);

  expect(ids(registry.get(threads.environmentThreadsAtom(environmentId)))).toEqual([
    root.id,
    sideChat.id,
  ]);
  expect(ids(registry.get(threads.sideChatsAtom(parentRef)))).toEqual([sideChat.id]);
  expect(registry.get(threads.childThreadInputsAtom(parentRef))).toEqual([]);
  expect(registry.get(threads.threadShellAtom(parentRef))?.pendingSubagentRequest).toBeNull();
  expect(registry.get(threads.threadShellAtom({ environmentId, threadId: voice.id }))).toBeNull();
  expect(ids(registry.get(threads.navigationThreadShellsAtom))).toEqual([root.id]);
  registry.dispose();

  // A list without one is handed back as it is, so nothing that reads it recomputes.
  const plain = [root, sideChat];
  expect(withoutVoiceAgentThreads(plain)).toBe(plain);
});
