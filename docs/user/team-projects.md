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
catalog there, and **Use default** goes back to it.

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
it is not added yet.

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

1. Create a personal API key in Linear under **Settings → Security & access → Personal API keys**.
2. Open **Settings → Threads → Board**, paste the key and select **Connect**. The key is checked
   with Linear and stored in the environment's secret store; Settings then shows who you are
   connected as. **Disconnect** removes it.
3. In a thread of the project, open **Board** from the right panel's new surface menu or the
   command palette.

The board shows open issues and those closed in the last week, as columns or as a list grouped by
state. **Mine** keeps the issues assigned to you. A card shows its pull request's state, from the
pull request this app tracks for a thread when it has one, and otherwise from Linear's GitHub
integration. Selecting a card opens its thread when the issue links to a thread on a machine you
are connected to, and opens the issue in Linear otherwise. The board is read when you open it and
when you select refresh; it does not change issues.

Each environment reads Linear with its own owner's key, so connect Linear on each machine you use
the board from.

## Team preferences

Team preferences are standing instructions your agents follow, kept as markdown in the catalog
repository so the whole team shares them:

- `preferences/team.md` applies to everyone, in every project.
- `preferences/projects/<key>.md` applies to threads in that catalog project.
- `preferences/people/<github-login>.md` applies only to that person's own agents. Your login is
  the one the GitHub CLI is signed in with (`gh auth login`).

Write one preference per list item, in plain words. Every turn gets the team file, then the
project's, then your own, so a more specific one wins; the user's own message wins over all of
them. The text is limited to about 8 KB in total, roughly 2,000 tokens.

Open **Team preferences** from the right panel's new surface menu or the command palette, in a
thread of the project. **Team**, **Project** and **Personal** show each file as it was last
fetched; **What agents get** shows the exact text agents receive and its size. **Edit** changes
a file and **Propose change** opens a pull request on the catalog repository, as link changes
do. The change is pending until it is merged; the repository's review rules decide who approves
it, including for personal files.

Agents pick up changes on their next turn once the catalog is fetched again. A turn uses the
last fetch and fetches in the background when it is more than ten minutes old; the refresh
button fetches at once. Claude and Codex get team preferences. Rules that belong to one
repository, and are fine to publish, belong in that repository's `AGENTS.md` instead.
