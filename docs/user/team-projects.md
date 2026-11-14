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
  "links": [{ "project": "api", "access": "read" }]
}
```

- `key` matches the file name: lowercase letters, digits and dashes.
- `repo` is `host/owner/repository`, with no `https://`.
- `owners` are the GitHub logins who decide the project's links.
- `parent` (optional) groups the project under another one.
- `links` (optional) name other projects this one may `read` or `write`. A write link counts only
  when both projects declare it, and agents then open pull requests there rather than push.

Files are checked strictly. A file with a mistake, an unknown field, or a repository another
file already lists is skipped, and Settings says which file and why. The rest of the catalog
still loads.

## See all team projects

Open **Team projects** from the sidebar footer or the command palette. Projects are drawn inside
their parent's box. Dashed lines are read links and solid lines are write links; a write link
only one side has declared is faded. A read link to a repository your git credentials cannot
reach shows as **No access**.

Select a project to highlight what it links to and what links to it, open it, or add it here if
it is not added yet.

## Change links and grouping

A project's owners change its parent and links, either in the project's settings under **Team
project** or from **Team projects**. Owners are matched against the GitHub login the GitHub CLI is
signed in with on that environment (`gh auth login`); everyone else sees the links read-only.

Saving never changes the catalog directly. **Propose change** pushes a new branch to the catalog
repository with your own git credentials and, on GitHub, opens a pull request. The catalog
repository's own review rules decide who approves it, and the change counts once it is merged.

A write link counts only when both projects declare it. When you add one, you can propose the
other project's matching declaration in the same pull request; its owners still approve it.
Until then the link shows as pending.
