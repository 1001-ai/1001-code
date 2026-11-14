import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { boardConnect, boardDisconnect, useBoardConnection } from "../../state/board";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const BOARD_SETTINGS_SECTION_ID = "board";

function LinearConnectionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const connection = useBoardConnection(props.environmentId);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const connect = useAtomCommand(boardConnect, { reportFailure: false });
  const disconnect = useAtomCommand(boardDisconnect);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = apiKey.trim();
    if (value.length === 0) return;
    setPending(true);
    setError(null);
    const result = await connect({ environmentId: props.environmentId, input: { apiKey: value } });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not connect to Linear.");
      return;
    }
    setApiKey("");
  };

  const title = props.label === null ? "Linear" : `Linear · ${props.label}`;
  if (connection?.status === "connected") {
    const { viewer } = connection;
    return (
      <SettingsRow
        title={title}
        description="Boards read Linear as this account. The API key stays on this environment's server."
        status={`Connected as ${viewer.name} (${viewer.email}) in ${viewer.workspace}.`}
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
      description="Paste a Linear personal API key (Linear → Settings → Security & access → Personal API keys) to see team projects' boards. It is stored in this environment's secret store and never shown again."
      status={error ?? (connection === null ? null : "Not connected.")}
      control={
        <form
          className="flex w-full items-center gap-2 sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            size="sm"
            className="w-full sm:w-64"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="lin_api_…"
            aria-label="Linear personal API key"
            value={apiKey}
            maxLength={500}
            disabled={connection === null || !canWrite || pending}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!canWrite || pending || apiKey.trim().length === 0}
          >
            Connect
          </Button>
        </form>
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
