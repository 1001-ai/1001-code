import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { boardConnect, useBoardConnection } from "../../state/board";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** The server forgets an unfinished sign-in after ten minutes. */
const SIGN_IN_WAIT_MS = 10 * 60_000;

/** One environment's Linear connection and the sign-in that opens Linear in the browser. */
export function useLinearSignIn(environmentId: EnvironmentId) {
  const connection = useBoardConnection(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const connect = useAtomCommand(boardConnect, { reportFailure: false });
  const [pending, setPending] = useState(false);
  // The sign-in this waits on, so an older attempt's timeout cannot end a newer wait. `link`
  // is set when the browser blocked the sign-in tab, for the person to open it themselves.
  const [waiting, setWaiting] = useState<{
    readonly attempt: number;
    readonly link: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A wait ends once the environment signs in, here or from anywhere else.
  if (waiting !== null && connection !== null && connection.status !== "disconnected") {
    setWaiting(null);
  }

  const signIn = async () => {
    const callbackOrigin = readPreparedConnection(environmentId)?.httpBaseUrl;
    if (callbackOrigin === undefined) return;
    // Opened before the request: a tab opened after an await can be blocked as a pop-up.
    const tab = isElectron ? null : window.open("about:blank", "_blank");
    if (tab !== null) tab.opener = null;
    setPending(true);
    setError(null);
    const result = await connect({ environmentId, input: { callbackOrigin } });
    setPending(false);
    if (result._tag === "Failure") {
      tab?.close();
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not start the Linear sign-in.");
      return;
    }
    const { authorizeUrl } = result.value;
    let link: string | null = null;
    if (tab !== null) {
      tab.location.replace(authorizeUrl);
    } else if (isElectron) {
      await readLocalApi()?.shell.openExternal(authorizeUrl);
    } else {
      link = authorizeUrl;
    }
    const attempt = Date.now();
    setWaiting({ attempt, link });
    setTimeout(
      () => setWaiting((current) => (current?.attempt === attempt ? null : current)),
      SIGN_IN_WAIT_MS,
    );
  };

  return { connection, canWrite, pending, waiting, error, signIn };
}
