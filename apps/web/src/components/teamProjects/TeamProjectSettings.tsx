import {
  type EnvironmentId,
  type RepositoryIdentity,
  teamCatalogRepositoryMatches,
} from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useTeamCatalog } from "../../state/teamCatalog";
import { SettingsSection } from "../settings/settingsLayout";
import { TeamProjectLinksEditor } from "./TeamProjectLinksEditor";

/** The project's team catalog entry, when the catalog lists its repository. */
export function TeamProjectSettings(props: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const member =
    props.members.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    props.members[0];
  const environmentId = member?.environmentId ?? null;
  const catalog = useTeamCatalog(environmentId);
  const entry = catalog?.projects.find((candidate) =>
    props.members.some(
      (project) =>
        project.environmentId === environmentId &&
        teamCatalogRepositoryMatches(candidate.project.repo, project.repositoryIdentity),
    ),
  );
  if (environmentId === null || catalog === null || entry === undefined) return null;
  return (
    <SettingsSection
      id="team-project"
      title="Team project"
      titleAction={
        <span className="truncate text-xs text-muted-foreground">{entry.project.key}</span>
      }
    >
      <TeamProjectLinksEditor
        environmentId={environmentId}
        snapshot={catalog}
        projectKey={entry.project.key}
      />
    </SettingsSection>
  );
}
