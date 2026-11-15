import type { EnvironmentId } from "@t3tools/contracts";

import { boardDisconnect } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { useLinearSignIn } from "../board/useLinearSignIn";
import { Button, InlineButton } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const BOARD_SETTINGS_SECTION_ID = "board";

function LinearConnectionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { connection, canWrite, pending, waiting, error, signIn } = useLinearSignIn(
    props.environmentId,
  );
  const disconnect = useAtomCommand(boardDisconnect);

  const title = props.label === null ? "Linear" : `Linear · ${props.label}`;
  if (connection?.status === "unavailable") {
    return (
      <SettingsRow
        title={title}
        description="Boards read Linear as the person signed in on this environment."
        status="Linear sign-in is not set up for this environment. An administrator sets T3CODE_LINEAR_CLIENT_ID on its server."
      />
    );
  }
  if (connection?.status === "connected") {
    const { viewer } = connection;
    return (
      <SettingsRow
        title={title}
        description="Boards read Linear as this account. The sign-in stays on this environment's server."
        status={`Signed in as ${viewer.name} (${viewer.email}) in ${viewer.workspace}.`}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canWrite}
            onClick={() => void disconnect({ environmentId: props.environmentId, input: {} })}
          >
            Disconnect
          </Button>
        }
      />
    );
  }

  return (
    <SettingsRow
      title={title}
      description="Sign in to Linear to see team projects' boards. Linear opens in your browser and sends you back to this environment."
      status={
        error ??
        (connection === null
          ? null
          : (connection.signInFailure ??
            (waiting === null ? (
              "Not signed in."
            ) : waiting.link === null ? (
              "Finish signing in to Linear in your browser."
            ) : (
              <>
                The browser blocked the sign-in tab.{" "}
                <InlineButton
                  render={<a href={waiting.link} target="_blank" rel="noopener noreferrer" />}
                >
                  Open Linear sign-in
                </InlineButton>
              </>
            ))))
      }
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={connection === null || !canWrite || pending}
          onClick={() => void signIn()}
        >
          Sign in with Linear
        </Button>
      }
    />
  );
}

/** The Linear account each environment in scope reads boards as. */
export function BoardSettings() {
  const { scope, targets } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout" || targets.length === 0) return null;
  return (
    <SettingsSection id={BOARD_SETTINGS_SECTION_ID} title="Board">
      {targets.map((target) => (
        <LinearConnectionRow
          key={target.environmentId}
          environmentId={target.environmentId}
          label={targets.length > 1 ? target.label : null}
        />
      ))}
    </SettingsSection>
  );
}
