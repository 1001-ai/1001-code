import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { boardConnect, boardDisconnect, useBoardConnection } from "../../state/board";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const BOARD_SETTINGS_SECTION_ID = "board";
/** The server forgets an unfinished sign-in after ten minutes. */
const SIGN_IN_WAIT_MS = 10 * 60_000;

function LinearConnectionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const connection = useBoardConnection(props.environmentId);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const connect = useAtomCommand(boardConnect, { reportFailure: false });
  const disconnect = useAtomCommand(boardDisconnect);
  const [pending, setPending] = useState(false);
  // The sign-in this row waits on, so an older attempt's timeout cannot end a newer wait.
  const [waitingFor, setWaitingFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    const callbackOrigin = readPreparedConnection(props.environmentId)?.httpBaseUrl;
    if (callbackOrigin === undefined) return;
    // Opened before the request: a tab opened after an await can be blocked as a pop-up.
    const tab = isElectron ? null : window.open("about:blank", "_blank");
    if (tab !== null) tab.opener = null;
    setPending(true);
    setError(null);
    const result = await connect({
      environmentId: props.environmentId,
      input: { callbackOrigin },
    });
    setPending(false);
    if (result._tag === "Failure") {
      tab?.close();
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not start the Linear sign-in.");
      return;
    }
    const { authorizeUrl } = result.value;
    if (tab !== null) {
      tab.location.replace(authorizeUrl);
    } else {
      await readLocalApi()?.shell.openExternal(authorizeUrl);
    }
    const attempt = Date.now();
    setWaitingFor(attempt);
    setTimeout(
      () => setWaitingFor((current) => (current === attempt ? null : current)),
      SIGN_IN_WAIT_MS,
    );
  };

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
            onClick={() => {
              setWaitingFor(null);
              void disconnect({ environmentId: props.environmentId, input: {} });
            }}
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
            (waitingFor !== null
              ? "Finish signing in to Linear in your browser."
              : "Not signed in.")))
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
