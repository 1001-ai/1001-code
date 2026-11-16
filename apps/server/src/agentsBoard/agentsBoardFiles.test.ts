import { agentsBoardMediaType, isAgentsBoardBranch } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  AGENTS_BOARD_LIMITS,
  agentsBoardFileKind,
  buildAgentsBoard,
  parseAgentInbox,
  parseAgentReport,
} from "./agentsBoardFiles.ts";
import { imageTypeOf } from "./agentsBoardMedia.ts";

const REPORT = `# sam-2

- owner: Sam
- tool: Cursor cloud agent
- task: Make the sign-in page faster
- started: 2026-11-16T00:02:10Z

## 2026-11-16T00:02:10Z · started

Reading the sign-in code.

- branch: sam/faster-sign-in
- next: measure the page
- needs: nothing

## 2026-11-16T00:12:45Z · blocked

The staging database refuses my login.
It worked yesterday.

- needs: a person to reset the staging password
- media: media/sam-2/20261116T001245Z-error.png
- pr: https://example.test/pull/7
`;

const report = (text: string) => parseAgentReport("reports/sam-2.md", "sam-2", text);

describe("parseAgentReport", () => {
  it("reads the header and the entries, oldest first", () => {
    const parsed = report(REPORT);
    expect(parsed.agent).toEqual({
      id: "sam-2",
      owner: "Sam",
      tool: "Cursor cloud agent",
      task: "Make the sign-in page faster",
      started: "2026-11-16T00:02:10.000Z",
      latestStatus: "blocked",
      latestAt: "2026-11-16T00:12:45.000Z",
      needs: "a person to reset the staging password",
    });
    expect(parsed.messages).toEqual([
      {
        _tag: "agent",
        id: "reports/sam-2.md#0",
        agentId: "sam-2",
        at: "2026-11-16T00:02:10.000Z",
        status: "started",
        text: "Reading the sign-in code.",
        branch: "sam/faster-sign-in",
        pr: null,
        next: "measure the page",
        needs: null,
        media: [],
      },
      {
        _tag: "agent",
        id: "reports/sam-2.md#1",
        agentId: "sam-2",
        at: "2026-11-16T00:12:45.000Z",
        status: "blocked",
        text: "The staging database refuses my login.\nIt worked yesterday.",
        branch: null,
        pr: "https://example.test/pull/7",
        next: null,
        needs: "a person to reset the staging password",
        media: ["media/sam-2/20261116T001245Z-error.png"],
      },
    ]);
  });

  it.each([
    ["no header at all", "## 2026-11-16T00:12:45Z · working\n\nStill going.\n", "working"],
    ["a status in capitals", "## 2026-11-16T00:12:45Z · DONE\nShipped.\n", "done"],
    ["a hyphen for the dot", "## 2026-11-16T00:12:45Z - question\nWhich one?\n", "question"],
    ["no separator", "## 2026-11-16T00:12:45Z working\nStill going.\n", "working"],
    ["a time with an offset", "## 2026-11-16T02:12:45+02:00 · working\nStill going.\n", "working"],
    ["a time with no zone and no seconds", "## 2026-11-16 00:12 · working\nGoing.\n", "working"],
    ["a word that is not a status", "## 2026-11-16T00:12:45Z · reviewing\nLooking.\n", null],
  ])("keeps an entry with %s", (_name, text, status) => {
    const parsed = report(text);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({ status, _tag: "agent" });
    expect(parsed.messages[0]?.at.startsWith("2026-11-16T00:12")).toBe(true);
  });

  it("skips what does not parse, with the text under it, and never throws", () => {
    const parsed = report(
      [
        "## not a time · working",
        "Text under a heading that is skipped.",
        "## 2026-13-45T99:99:99Z · working",
        "An impossible time.",
        "## 2026-11-16T00:12:45Z · working",
        "The one real entry.",
        "### A smaller heading is text",
        "- did: one thing",
        "- needs",
        "## ",
        "##",
      ].join("\n"),
    );
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      id: "reports/sam-2.md#2",
      text: "The one real entry.\n### A smaller heading is text\n- did: one thing\n- needs",
      needs: null,
    });
    for (const text of [
      "",
      "\u0000\u0001",
      "#".repeat(5_000),
      "## ".repeat(2_000),
      "- media: ../x",
    ]) {
      expect(() => report(text)).not.toThrow();
    }
  });

  it("takes the later of two entries with one time as the newest", () => {
    const parsed = report(
      "## 2026-11-16T00:12:45Z · working\nFirst.\n## 2026-11-16T00:12:45Z · done\nSecond.\n",
    );
    expect(parsed.messages.map((message) => message.id)).toEqual([
      "reports/sam-2.md#0",
      "reports/sam-2.md#1",
    ]);
    expect(parsed.agent?.latestStatus).toBe("done");
  });

  it("keeps only media paths inside media/, whatever the time in the name looks like", () => {
    const parsed = report(
      [
        "## 2026-11-16T00:12:45Z · working",
        "- media: media/sam-2/2026-11-16_00.12.45-a.png, `media/kim-1/b.JPG`",
        "- media: ../../etc/passwd",
        "- media: media/../reports/sam-2.md",
        "- media: /media/sam-2/c.png.exe",
        "- media: media/sam-2/sub/d.png",
        "- media: https://example.test/e.png",
        "- media: media/sam-2/f.svg",
        "- media: media/sam-2/g.webp media/sam-2/h.gif media/sam-2/i.png",
      ].join("\n"),
    );
    expect(parsed.messages[0]).toMatchObject({
      media: [
        "media/sam-2/2026-11-16_00.12.45-a.png",
        "media/kim-1/b.JPG",
        "media/sam-2/g.webp",
        "media/sam-2/h.gif",
      ],
    });
  });

  it("caps every field, the text and the entries of a file", () => {
    const long = "x".repeat(10_000);
    const parsed = report(
      [
        `- owner: ${long}`,
        ...Array.from({ length: AGENTS_BOARD_LIMITS.maxEntriesPerFile + 5 }, (_unused, index) =>
          [
            `## 2026-11-16T00:${String(index % 60).padStart(2, "0")}:00Z · working`,
            long,
            `- next: ${long}`,
          ].join("\n"),
        ),
      ].join("\n"),
    );
    expect(parsed.agent?.owner).toHaveLength(300);
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages).toHaveLength(AGENTS_BOARD_LIMITS.maxEntriesPerFile);
    // The oldest entries are the ones left out.
    expect(parsed.messages[0]?.id).toBe("reports/sam-2.md#5");
    expect(parsed.messages[0]).toMatchObject({ _tag: "agent" });
    const first = parsed.messages[0];
    expect(first?.text).toHaveLength(2_000);
    expect(first?._tag === "agent" ? first.next : null).toHaveLength(300);
  });

  it("makes text plain: no control or direction-override characters", () => {
    const parsed = report(
      "- owner: Sa‮m\u0007\n## 2026-11-16T00:12:45Z · working\nLine\u0000 one⁦\n",
    );
    expect(parsed.agent?.owner).toBe("Sa m");
    expect(parsed.messages[0]?.text).toBe("Line  one");
  });
});

describe("parseAgentInbox", () => {
  it("reads messages from a person, with who they are for", () => {
    const parsed = parseAgentInbox(
      "inbox/sam-2.md",
      "sam-2",
      [
        "## 2026-11-16T00:37:00Z · from Robin",
        "",
        "Use the test account instead.",
        "",
        "- via: voice agent",
        "## 2026-11-16T00:40:00Z",
        "No name on this one.",
        "## later · from Kim",
        "Skipped: no time.",
      ].join("\n"),
    );
    expect(parsed.agent).toBeNull();
    expect(parsed.messages).toEqual([
      {
        _tag: "person",
        id: "inbox/sam-2.md#0",
        from: "Robin",
        to: "sam-2",
        at: "2026-11-16T00:37:00.000Z",
        text: "Use the test account instead.",
        via: "voice agent",
      },
      {
        _tag: "person",
        id: "inbox/sam-2.md#1",
        from: null,
        to: "sam-2",
        at: "2026-11-16T00:40:00.000Z",
        text: "No name on this one.",
        via: null,
      },
    ]);
  });
});

describe("buildAgentsBoard", () => {
  it("puts agents' and people's messages in time order and counts who needs a person", () => {
    const board = buildAgentsBoard([
      { path: "reports/sam-2.md", text: REPORT },
      {
        path: "reports/kim-1.md",
        text: "- owner: Kim\n## 2026-11-16T00:05:00Z · done\nMerged.\n- needs: nothing\n",
      },
      { path: "reports/lee-4.md", text: "- owner: Lee\n" },
      { path: "inbox/all.md", text: "## 2026-11-16T00:10:00Z · from Robin\nStand-up at ten.\n" },
      { path: "inbox/sam-2.md", text: "## 2026-11-16T00:20:00Z · from Robin\nTry again.\n" },
      { path: "README.md", text: "## 2026-11-16T00:00:00Z · working\nNot a report.\n" },
      { path: "reports/../x.md", text: "## 2026-11-16T00:00:00Z · working\nNot a report.\n" },
      { path: "reports/deep/sam-2.md", text: "## 2026-11-16T00:00:00Z · working\nNo.\n" },
    ]);
    expect(board.messages.map((message) => message.id)).toEqual([
      "reports/sam-2.md#0",
      "reports/kim-1.md#0",
      "inbox/all.md#0",
      "reports/sam-2.md#1",
      "inbox/sam-2.md#0",
    ]);
    expect(board.messages[2]).toMatchObject({ _tag: "person", to: null, from: "Robin" });
    expect(board.agents.map((agent) => agent.id)).toEqual(["kim-1", "lee-4", "sam-2"]);
    expect(board).toMatchObject({ activeCount: 2, needsPersonCount: 1, truncated: false });
  });

  it("keeps the newest messages when the board has more than its limit", () => {
    const limits = { ...AGENTS_BOARD_LIMITS, maxMessages: 2 };
    const board = buildAgentsBoard(
      [
        { path: "reports/sam-2.md", text: REPORT },
        {
          path: "inbox/all.md",
          text: "## 2026-11-16T00:30:00Z · from Kim\nNewest.\n",
        },
      ],
      limits,
    );
    expect(board.messages.map((message) => message.id)).toEqual([
      "reports/sam-2.md#1",
      "inbox/all.md#0",
    ]);
    expect(board.truncated).toBe(true);
  });
});

describe("paths and names from the branch", () => {
  it.each([
    ["reports/sam-2.md", { kind: "report", agentId: "sam-2" }],
    ["inbox/sam-2.md", { kind: "inbox", to: "sam-2" }],
    ["inbox/all.md", { kind: "inbox", to: null }],
    ["reports/sam-2.txt", null],
    ["reports/README.md", null],
    ["inbox/readme.md", null],
    ["reports/.md", null],
    ["reports/a/b.md", null],
    ["reports/..md", null],
    ["media/sam-2/a.md", null],
    ["/reports/sam-2.md", null],
  ])("reads %s as %j", (path, kind) => {
    expect(agentsBoardFileKind(path)).toEqual(kind);
  });

  it.each([
    ["media/sam-2/shot.png", "image/png"],
    ["media/sam-2/20261116T001245Z-name.JPEG", "image/jpeg"],
    ["media/sam-2/a.b.webp", "image/webp"],
    ["media/sam-2/a.gif", "image/gif"],
    ["media/sam-2/a.svg", null],
    ["media/sam-2/a.png/", null],
    ["media/sam-2/../../a.png", null],
    ["media/../a.png", null],
    ["media/sam-2/..png", null],
    ["media/sam-2/a..png", null],
    ["media//a.png", null],
    ["media/sam-2/sub/a.png", null],
    ["media\\sam-2\\a.png", null],
    ["/media/sam-2/a.png", null],
    ["reports/sam-2/a.png", null],
    ["media/sam-2/a.png\u0000.md", null],
    ["media/sam-2/a.png\n", null],
    ["media/sam-2/-a.png", null],
    [`media/sam-2/${"a".repeat(200)}.png`, null],
  ])("takes the media path %j as %j", (path, type) => {
    expect(agentsBoardMediaType(path)).toBe(type);
  });

  it.each([
    ["agent-reports", true],
    ["team/agent-reports.v2", true],
    ["-upload-pack=x", false],
    ["a..b", false],
    ["a b", false],
    ["a:b", false],
    ["+refs/heads/a", false],
    ["a@{1}", false],
    ["a/", false],
    ["a//b", false],
    ["a.lock", false],
    ["a/.b", false],
    ["", false],
    ["a".repeat(101), false],
  ])("takes the branch name %j: %j", (branch, valid) => {
    expect(isAgentsBoardBranch(branch)).toBe(valid);
  });

  it("names an image by its bytes, not its file name", () => {
    expect(imageTypeOf(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      "image/png",
    );
    expect(imageTypeOf(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(imageTypeOf(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(imageTypeOf(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(imageTypeOf(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(imageTypeOf(new TextEncoder().encode("<!doctype html>"))).toBeNull();
    expect(imageTypeOf(new Uint8Array())).toBeNull();
  });
});
