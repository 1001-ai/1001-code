import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { LinearIcon } from "../board/LinearIcon";
import { useLinearSignIn } from "../board/useLinearSignIn";
import { Button, InlineButton } from "../ui/button";
import { RowIcon, WelcomeSection } from "./WelcomePage";

/** Optional Linear sign-in for the Board; Start never waits on it. */
export function WelcomeBoardSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { connection, canWrite, pending, waiting, error, signIn } = useLinearSignIn(environmentId);
  const connected = connection?.status === "connected";
  const offersSignIn = connection?.status !== "unavailable" && !connected;
  const failure =
    error ?? (connection?.status === "disconnected" ? connection.signInFailure : undefined);

  let detail: ReactNode = "See your team's tasks next to your threads.";
  if (connection?.status === "unavailable") {
    detail = "Linear sign-in isn't set up on this server yet.";
  } else if (connection?.status === "connected") {
    detail = `Signed in as ${connection.viewer.name} in ${connection.viewer.workspace}.`;
  } else if (waiting !== null) {
    detail =
      waiting.link === null ? (
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
      );
  }

  return (
    <WelcomeSection title="Board">
      <div className="flex min-h-10 items-center gap-3 py-1">
        <RowIcon>
          <LinearIcon className="size-4 text-foreground" />
        </RowIcon>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {connected ? "Linear" : "Sign in to Linear"}
          </span>
          {failure ? (
            <span className="block text-xs text-destructive">{failure}</span>
          ) : (
            <span className="block text-xs text-muted-foreground">{detail}</span>
          )}
        </span>
        {offersSignIn ? (
          <Button
            variant="outline"
            size="xs"
            disabled={connection === null || !canWrite || pending}
            onClick={() => void signIn()}
          >
            Sign in
          </Button>
        ) : null}
      </div>
    </WelcomeSection>
  );
}
