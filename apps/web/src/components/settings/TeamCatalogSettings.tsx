import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { useEnvironmentScope } from "../../state/session";
import { teamCatalogRefresh, teamCatalogSetSource, useTeamCatalog } from "../../state/teamCatalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSettingsScope } from "./SettingsScopeContext";
import { BoardSettings } from "./BoardSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function catalogStatus(snapshot: NonNullable<ReturnType<typeof useTeamCatalog>>): string {
  if (snapshot.source === null) return "Not set.";
  if (snapshot.refreshing) return "Fetching…";
  const count = `${snapshot.projects.length} project${snapshot.projects.length === 1 ? "" : "s"}`;
  if (snapshot.error !== null) {
    return snapshot.fetchedAt === null
      ? `Could not fetch: ${snapshot.error}`
      : `${count} from the last fetch. The latest fetch failed: ${snapshot.error}`;
  }
  if (snapshot.fetchedAt === null) return count;
  const time = new Date(snapshot.fetchedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${count}, fetched at ${time}.`;
}

function TeamCatalogRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const snapshot = useTeamCatalog(props.environmentId);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const setSource = useAtomCommand(teamCatalogSetSource, { reportFailure: false });
  const refresh = useAtomCommand(teamCatalogRefresh);

  const commit = async (next: string) => {
    const source = next.trim();
    if (source === (snapshot?.source ?? "")) return;
    const result = await setSource({
      environmentId: props.environmentId,
      input: { source: source.length === 0 ? null : source },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Team catalog not saved",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <SettingsRow
      title={props.label === null ? "Team catalog" : `Team catalog · ${props.label}`}
      description="A git repository with one projects/<key>.json file per team project, fetched with this environment's git credentials. Its projects appear under Team projects when you add a project."
      status={snapshot === null ? null : catalogStatus(snapshot)}
      control={
        <>
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={snapshot?.source ?? ""}
            onCommit={(next) => void commit(next)}
            placeholder="git@host:team/catalog.git"
            spellCheck={false}
            disabled={snapshot === null || !canWrite}
            aria-label="Team catalog git URL"
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Fetch team catalog"
                  disabled={snapshot?.source == null || snapshot.refreshing}
                  onClick={() =>
                    void refresh({ environmentId: props.environmentId, input: { force: true } })
                  }
                >
                  <RefreshCwIcon />
                </Button>
              }
            />
            <TooltipPopup>Fetch team catalog</TooltipPopup>
          </Tooltip>
        </>
      }
    >
      {snapshot !== null && snapshot.invalid.length > 0 ? (
        <ul className="space-y-1 pb-2 text-xs text-muted-foreground">
          {snapshot.invalid.map((file) => (
            <li key={file.file}>
              <span className="font-medium text-warning">Skipped {file.file}:</span> {file.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}

/** The team catalog each environment in scope reads; project scopes have none of their own. */
export function TeamCatalogSettings() {
  const { scope, targets } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout" || targets.length === 0) return null;
  return (
    <>
      <SettingsSection id="team-catalog" title="Team projects">
        {targets.map((target) => (
          <TeamCatalogRow
            key={target.environmentId}
            environmentId={target.environmentId}
            label={targets.length > 1 ? target.label : null}
          />
        ))}
      </SettingsSection>
      <BoardSettings />
    </>
  );
}
