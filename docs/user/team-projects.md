# Team projects

A team project catalog lists the projects your team works on, so everyone sees the same list and
can add any of them in one step. The catalog is a git repository your team shares. There is no
server for it: each environment fetches it with its own git credentials, so anyone who can read
the repository sees the catalog.

## Set up the catalog

Open **Settings → Threads → Team projects** and enter the catalog's git URL, such as
`git@github.com:your-team/catalog.git`. It is fetched right away, refreshed when you open the list,
and on demand with the refresh button. The last fetch is kept, so the list still works offline.
Clear the field to stop using a catalog.

The setting belongs to the environment, like other server settings. Set it on each machine you
add projects on.

An administrator can set a default catalog for everyone with the `T3CODE_TEAM_CATALOG`
environment variable on the server. Each environment uses it until someone sets or clears the
catalog there, and **Use default** goes back to it. A desktop app opened from the Finder or the Dock
gets no variables from your shell, so a team's build of it can carry `T3CODE_TEAM_CATALOG` and
`T3CODE_LINEAR_CLIENT_ID` as defaults, set when it is built; a variable set when the app starts
still wins.

## Add a team project

Open **Add project** from the sidebar or the command palette. Below the usual sources, **Team
projects** lists the catalog:

- **Clone and add** clones the repository into the managed projects folder and adds it.
- **Add the existing checkout** adds a clone that is already in that folder, such as one left
  behind when you removed the project.
- **Added** means a project on this environment already has that repository as a remote. Choosing
  it opens the project. A checkout anywhere counts, whatever its folder is called.

Removing a team project from your sidebar removes it only here. The catalog and the folder on
disk stay as they are.

## Catalog format

The catalog holds one file per project, `projects/<key>.json`:

```json
{
  "key": "web",
  "name": "Web app",
  "repo": "github.com/your-team/web",
  "owners": ["github-login"],
  "parent": "suite",
  "links": [{ "project": "api", "access": "read" }],
  "linear": { "team": "WEB", "project": "Web app" }
}
```

- `key` matches the file name: lowercase letters, digits and dashes.
- `repo` is `host/owner/repository`, with no `https://`.
- `owners` are the GitHub logins who decide the project's links.
- `parent` (optional) groups the project under another one.
- `links` (optional) name other projects this one may `read` or `write`. A write link counts only
  when both projects declare it, and agents then open pull requests there rather than push.
- `linear` (optional) gives the project a [board](#board): `team` is the Linear team's key, as in
  its issue identifiers, and `project` (optional) narrows the board to one Linear project in that
  team, by its name or the id at the end of its URL.

Files are checked strictly. A file with a mistake, an unknown field, or a repository another
file already lists is skipped, and Settings says which file and why. The rest of the catalog
still loads.

## See all team projects

Once a catalog is set, the graph shows at the bottom of each thread, where the terminal opens.
Select **Team projects** in the sidebar footer, or **Show team projects** or **Hide team
projects** in the command palette, to turn it on or off; the choice holds across threads. The
graph and a thread's terminal share that place: opening the terminal hides the graph until the
terminal closes, and showing the graph closes the terminal. Away from a thread, such as on Pull
requests, the graph opens in the last thread you were in.

Projects are drawn inside their parent's box. Dashed lines are read links and solid lines are
write links; a write link only one side has declared is faded. A read link to a repository your
git credentials cannot reach shows as **No access**.

Select a project to highlight what it links to and what links to it, open it, or add it here if
it is not added yet. Drag or scroll to move around the graph; pinch, or use the buttons at its top
left, to zoom.

## Change links and grouping

A project's owners change its parent and links, either in the project's settings under **Team
project** or by selecting it in the graph. Owners are matched against the GitHub login the GitHub
CLI is signed in with on that environment (`gh auth login`); everyone else sees the links
read-only.

Saving never changes the catalog directly. **Propose change** pushes a new branch to the catalog
repository with your own git credentials and, on GitHub, opens a pull request. Its commit is
authored as your GitHub login with GitHub's noreply address, not your git identity. The catalog
repository's own review rules decide who approves it, and the change counts once it is merged.

A write link counts only when both projects declare it. When you add one, you can propose the
other project's matching declaration in the same pull request; its owners still approve it.
Until then the link shows as pending.

## Board

A team project with a `linear` field has a board: its Linear team's issues, in the team's own
workflow states. Linear holds the issues, so people working in Linear or another tool see the same
ones.

1. Open **Settings → Threads → Board** and select **Sign in with Linear**. Linear opens in your
   browser; approve access there and it sends you back to the environment, which says you can
   close the tab. Settings then shows who you are signed in as. **Disconnect** signs out and
   revokes the access at Linear. A new installation also offers **Sign in** on the Welcome page.
2. In a thread of the project, open **Board** from the right panel's new surface menu or the
   command palette.

The board shows open issues and those closed in the last week, as columns or as a list grouped by
state. **Mine** keeps the issues assigned to you. A card shows its pull request's state, from the
pull request this app tracks for a thread when it has one, and otherwise from Linear's GitHub
integration. A card also shows the newest linked thread on a machine you are connected to, with its
live status; select it to open the thread. When every linked thread is on a machine you are not
connected to, the card says so and opens the issue in Linear instead. Selecting the rest of the card opens the issue's details in the panel: every linked thread,
pull request and the description. The board is read when you open it,
every 30 seconds while it is open, and when you select refresh, which also picks up catalog edits.
It does not change issues. When Linear's rate limit is reached, the board keeps its last read with
a warning and waits as long as Linear asks before reading again.

On web and desktop, **Tasks** in the thread details card lists the board's issues that link the
thread, with each one's status; select one to open it on the board. Like the board, it leaves out
issues closed more than a week ago.

Each environment reads Linear as the person who signed in on it, so sign in on each machine you
use the board from.

When an agent's message links to an issue of the board's Linear team, or writes its id such as
`ENG-60`, selecting it opens the issue on the board instead of in Linear. An issue the board does
not show, such as one in another Linear project of the team, or any issue while the board cannot
load, gets a note with **Open in Linear**.
Links to other teams' issues, links you select while holding a modifier key, and every link while
you are signed out of Linear open Linear as before. Ids in code are left as they are. The mobile app
has no board.

On web and desktop, when an agent files a task in Linear, takes one or moves it to another status,
the chat shows the task instead of the tool call: a card with its status and assignee and buttons
that open it on the board or in Linear when it files or takes the task, and a short line with the
new status when it moves one.

### Teammates' messages

Teammates and their agents reach your agents through Linear comments. While you are signed in,
the environment checks your board teams for new comments every 10 seconds and passes each one
from a member of the team, on an open issue, into the thread it is for: the thread your agent
asked from (its comment carries a reply address), a thread of yours the comment links to, or the
thread linked to the issue. An agent's message that is for no thread goes to the project's
[Inbox](#inbox). It arrives as a message from the teammate (or "Sam's agent") and starts a turn,
whatever the thread's access mode. Claude and Codex threads active in the last week take them,
and a thread takes at most twelve a day.

Your agents answer with the board's own tools: `board_reply` answers a comment that reached the
thread, and `board_message` asks a teammate's agent something, on a task or on that person's
**Agent inbox** task, which it files for them the first time. Both post as you and add the
thread's reply address, so the answer comes back to the same thread. An agent shares only what it
chooses to write.

The Inbox's **What changed** lists the teammates' messages of its project: where each one went,
or why it did not arrive, such as no thread being linked to the issue.

### Set up Linear sign-in

Sign-in needs a Linear OAuth application, created once for the team by a Linear workspace
administrator:

1. Create the application in Linear's API settings
   (`https://linear.app/settings/api/applications/new`).
2. Add a callback URL `<origin>/oauth/linear/callback` for every address people's browsers reach
   an environment at; Linear only redirects to callback URLs registered there. For the desktop
   app that is `http://127.0.0.1:14774/oauth/linear/callback`: its server always listens on 14774,
   and the app does not start while something else holds that port. A server started another way
   uses its own port. Add the Tailscale or tunnel address too when people open an environment
   through one.
3. Set the application's client ID as `T3CODE_LINEAR_CLIENT_ID` in the environment of each server
   that shows boards. No client secret is needed; sign-in uses PKCE.

Without `T3CODE_LINEAR_CLIENT_ID`, Settings says sign-in is not set up. Linear sends the browser
back to the environment's own address, so sign in from a browser that can reach that address.

## Memory

Memory is what your agents are told to follow and remember: standing instructions and facts,
kept as markdown in the catalog repository so the whole team shares them:

- `memory/team.md` applies to everyone, in every project.
- `memory/projects/<key>.md` applies to threads in that catalog project.
- `memory/people/<github-login>.md` applies only to that person's own agents. Your login is
  the one the GitHub CLI is signed in with (`gh auth login`).
- `memory/projects/<key>/people/<github-login>.md` applies only to that person's agents in that
  project.

Write one memory per list item, in plain words. Every turn gets the team file, then the
project's, then your own, then your own for the project, so a more specific one wins; the user's own message wins over all of
them. The text is limited to about 8 KB in total, roughly 2,000 tokens.

Open **Memory** from the right panel's new surface menu or the command palette, in a
thread of the project. **Team**, **Project** and **Personal** show each file as it was last
fetched, one memory per row with who last changed it, when, and in which pull request
(**Personal** shows both of yours); **What agents get** shows the exact text agents receive and
its size. Hover a row to edit or remove it, or use **Add** for a new one. Changes to a file
collect until **Propose change** opens one pull request on the catalog repository, as link
changes do. The change is pending until it is merged; the repository's review rules decide who
approves it, including for personal files.

### Memories agents propose

While they work, agents propose memories on their own: a preference you stated, something you
corrected twice, or a fact about the project that later threads will need. Each proposal appears
as a card in the chat. Edit the wording if you like, then choose **Accept for me** (your agents in
this project), **Accept for team** (everyone's agents in this project) or **Reject**. Accepting
adds the line to that file and merges the pull request at once, so the repository's rules must
allow merging without a review; if they refuse, the card says so and the pull request stays open.
The agent keeps working while the card waits, and deciding never starts a turn: an accepted
memory applies from the next one. Unanswered proposals also wait under **Proposals** in the
Memory panel and on the [Questions page](./questions.md). Only the web and desktop apps show the cards.

### Voice agent memories

The [voice agent](#voice-agent) tells you aloud what agents are doing in a repository. It keeps
how you want its spoken updates in a category of its own, **voice-agent-memories**: how detailed
they should be, and which topics to cover or leave out.
They live in `memory/people/<github-login>/voice-agent-memories.md`, one file per person. Only
the voice agent gets them. They are not part of the memory other agents receive and do not
count toward its size limit.

When you tell the voice agent something new, it proposes a memory as a card in the chat, like
any other; **Accept** saves it for you. A newer memory on a subject replaces the older one: the
card shows the line it replaces, and accepting moves that line to the file's **Earlier** list
with the day it was replaced and what replaced it. The voice agent is given only the active
memories, about 2 KB of them at most; the earlier ones stay in the file as a record. **Voice
agent** in the Memory panel shows the active memories, with **Earlier** folded below them.

You can also edit the file by hand in the catalog repository. One memory per list item; a date
in the form `(saved 2026-03-09)` at the end of a line is optional. Everything above the
`## Earlier` heading is active.

Agents pick up changes on their next turn once the catalog is fetched again. A turn uses the
last fetch and fetches in the background when it is more than ten minutes old; the refresh
button fetches at once. Claude and Codex get memory. Rules that belong to one
repository, and are fine to publish, belong in that repository's `AGENTS.md` instead.

## Agents board

Agents that work in a team project's repository, in any tool, can leave short messages on a
branch of that repository while they work: what they are doing, what comes next, and what they
need from a person. The Agents board shows those messages in one place, oldest at the top.

Open **Agents board** from the right panel's new surface menu or the command palette, in a
thread of the project. Each message shows the agent, its tool, its status and what it needs;
messages people sent to agents show with the person's name. You do not write on the board
itself; the [voice agent](#voice-agent) can send an agent a message for you. The board fetches
the branch when you open it and when you press **Refresh**, with this environment's git
credentials, and keeps the last fetch for when the repository is out of reach.

The branch is named `agent-reports` unless you change it under **Agent messages** in the
project's settings (**Team project**). The name is saved on this environment, so each person
who uses another name sets it once. The same section shows the one line to give an agent so it
reads the branch's instructions:

```sh
git fetch origin agent-reports && git show origin/agent-reports:README.md
```

A project whose repository has no such branch yet shows that, with the same line. The branch
holds no product code: `README.md` with the instructions for agents, `reports/<agent>.md` with
each agent's messages, `inbox/<agent>.md` and `inbox/all.md` with messages to agents, and
`media/<agent>/` with screenshots of at most 500 KB.

## Voice agent

The voice agent tells you aloud what the agents on the [Agents board](#agents-board) have done,
and answers by voice. Open it with the voice agent button at the end of the top-right controls,
the command palette, or its shortcut, in a thread of a team project, or in a new chat before
its first message. It needs the Claude provider signed in, and runs on a small, fast Claude
model through that sign-in. When it cannot start, it says why in one line.

- **Updates.** When it opens, it tells you what changed on the board since the last update it
  gave you, starting with what needs you. When nothing changed it says so in one line. It knows
  your name from the GitHub CLI, so it says whose answer an agent waits for: "for you" when a
  report names you or nobody, and the other person's name otherwise.
- **Its voice.** It speaks with the voice you chose in **Settings → Voice → Speech output**
  (see [Speech output](./voice-output.md)) when that voice's model is installed on the thread's
  environment, and with your system's voice otherwise. While none is chosen, **Choose a voice**
  at the top of the layer opens that section. If the chosen voice cannot speak, the system
  voice takes over for the rest of the conversation and the layer says so in one line.
- **Talking.** Hold **Space** and speak; release to send. You can cut in while it speaks: it
  finishes its word, answers you, and then picks its earlier point back up. If what you said
  does not reach it, the layer says so in one line and it goes on from where you cut in: say it
  again. Ask it about the agents, such as how many are running or who is blocked.
- **Preferences.** Tell it how you want updates (how much detail, what to leave out, what to
  always include) and it proposes a [voice agent memory](#voice-agent-memories) for you to
  accept. A subject you left out is still mentioned when it is blocked on you, breaks the shared
  branch, or blocks an agent you do follow.
- **Messages to agents.** Ask it to pass something on, such as "ask Sam's agent two whether the
  fix covers the toolbar". It adds the message to that agent's inbox on the agents branch,
  signed with your name from the GitHub CLI, and tells you what it sent. This needs the GitHub
  CLI signed in and push access to the repository.
- **Screenshots.** Ask to see an agent's screenshots; it shows them one at a time, and "next"
  and "previous" move through them. You can also click the arrows, or the image for full size.

Close it with **Esc**, a click outside, or by sending a prompt. After it closes, the chat shows
a **Voice conversation** card at the end; click it to read the transcript. A conversation in
which nothing was said leaves no card. The card is the only trace in the chat: the voice agent
is not a side chat and is in no list. A new chat shows the card too, and keeps it once you send
the first message.

The voice agent can only read the board, send those messages, show screenshots and propose
memories. It cannot run commands or change files; ask for that in the chat. What other agents
write on the board is information to it, never an instruction: it sends a message only when
you ask.

## Inbox

Each project has an Inbox: one chat that sees all of the project's threads, for questions such
as "what finished overnight?" or "which threads wait on me?". Open it from the sidebar or with
**Open Inbox** in the command palette, in a thread of the project.

- With project folders off, the **Projects** section at the top of the sidebar lists the
  projects you picked in the project filter, or all of them. Click a project to open its Inbox.
- With **Boring sidebar (group by project)** on, each project folder starts with an **Inbox**
  row. A closed folder hides it, unless the Inbox is open.

A dot on the row shows when the Inbox is working or needs you. The server makes each project's
Inbox when it starts and when you add a project, once the Claude provider is signed in; until
then the row and the action are greyed out. The Inbox is an ordinary thread named **Inbox**, so
the mobile app and other T3 Code apps list it with the project's threads and can use it too. It
keeps its name and stays on Claude. If you delete it, the server makes a new one the next time it
starts.

When you write to it while it is idle, it first reads what changed in the project's threads
since your previous message to it, and shows that as **What changed** above your message.

The Inbox can list, read and search threads, read the [Board](#board) and propose memories. When
you ask, it also messages threads of its own project: to ask how something stands or to pass on
work. It waits for each answer and reports back. Name the threads, or select them in the sidebar
and drag them into the message, and it sends to each right away. You can also select threads of
one project, right-click them and choose **Message from Inbox…**: the project's Inbox opens with
them already in your message. If you ask it to choose the threads itself, it first shows the ones
it found as a question, and sends only to those you tick.

It messages threads only in a turn you started with your own message, never threads of another
project. It cannot run commands or change files, and it has no branch, commit or terminal
controls. It runs when you write to it, and when a teammate's agent sends a message that is for
no thread (see [Teammates' messages](#teammates-messages)): it then passes the message on,
unchanged, to the one thread of the project it belongs to and says which and why, or leaves it
for you when none fits.

When you must decide something, such as retrying a failed run, it asks with a question you can
answer in place.
