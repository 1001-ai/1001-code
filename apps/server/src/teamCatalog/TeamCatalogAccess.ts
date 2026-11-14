import { TeamCatalogError, type TeamCatalogViewer } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";

/**
 * What this environment's own credentials allow: the GitHub CLI's signed-in login, whether git
 * can reach a repository, and opening a pull request. Separate from `TeamCatalog` so tests never
 * reach the network.
 */
export class TeamCatalogAccess extends Context.Service<
  TeamCatalogAccess,
  {
    readonly viewer: Effect.Effect<TeamCatalogViewer>;
    readonly canReach: (cloneUrl: string) => Effect.Effect<boolean>;
    /** `repository` is `host/owner/repo`. Returns the pull request's URL. */
    readonly openPullRequest: (input: {
      readonly repository: string;
      readonly branch: string;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<string, TeamCatalogError>;
  }
>()("t3/teamCatalog/TeamCatalogAccess") {}

const MAX_ERROR_LENGTH = 500;

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const env = {
    ...unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform),
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };

  const viewer: TeamCatalogAccess["Service"]["viewer"] = processRunner
    .run({ command: "gh", args: ["api", "user", "--jq", ".login"], env, timeout: "15 seconds" })
    .pipe(
      Effect.map((output): TeamCatalogViewer => {
        const login = output.stdout.trim();
        return output.code === 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)
          ? { login, problem: null }
          : { login: null, problem: "The GitHub CLI is not signed in. Run gh auth login." };
      }),
      Effect.orElseSucceed((): TeamCatalogViewer => ({
        login: null,
        problem: "The GitHub CLI (gh) is not installed, so owners cannot be recognized.",
      })),
    );

  const canReach = Effect.fn("TeamCatalogAccess.canReach")(function* (cloneUrl: string) {
    const output = yield* processRunner
      .run({
        command: "git",
        args: ["ls-remote", "--exit-code", "--quiet", "--", cloneUrl, "HEAD"],
        env,
        timeout: "15 seconds",
      })
      .pipe(Effect.option);
    // Exit 2 is a reachable repository with no HEAD yet.
    return output._tag === "Some" && (output.value.code === 0 || output.value.code === 2);
  });

  const openPullRequest = Effect.fn("TeamCatalogAccess.openPullRequest")(function* (input: {
    readonly repository: string;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }) {
    const output = yield* processRunner
      .run({
        command: "gh",
        args: [
          "pr",
          "create",
          "--repo",
          input.repository,
          "--head",
          input.branch,
          "--title",
          input.title,
          "--body",
          input.body,
        ],
        env,
        timeout: "60 seconds",
      })
      .pipe(Effect.mapError((cause) => new TeamCatalogError({ detail: cause.message })));
    const url = output.stdout.trim().split("\n").at(-1) ?? "";
    if (output.code === 0 && /^https:\/\/\S+$/.test(url)) return url;
    return yield* new TeamCatalogError({
      detail: (output.stderr.trim() || "gh pr create failed.").slice(0, MAX_ERROR_LENGTH),
    });
  });

  return TeamCatalogAccess.of({ viewer, canReach, openPullRequest });
});

export const layer = Layer.effect(TeamCatalogAccess, make);
