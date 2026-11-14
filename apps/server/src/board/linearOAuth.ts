import { BoardError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Linear OAuth 2.0 with PKCE, as https://linear.app/developers/oauth-2-0-authentication describes
 * it: a PKCE token exchange or refresh needs only the client id, never the client secret.
 */
const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";

/** Where Linear sends the browser back, on the environment's own origin. */
export const CALLBACK_PATH = "/oauth/linear/callback";

/** `read` lets the board read; `write` is for agents acting in Linear as the signed-in person. */
const SCOPES = "read,write";

export interface LinearOAuthEndpoints {
  readonly authorize: string;
  readonly token: string;
  readonly revoke: string;
}

export const LINEAR_OAUTH_ENDPOINTS: LinearOAuthEndpoints = {
  authorize: LINEAR_AUTHORIZE_URL,
  token: LINEAR_TOKEN_URL,
  revoke: LINEAR_REVOKE_URL,
};

/** A dev stand-in serves the OAuth endpoints at the same origin as its GraphQL endpoint. */
export const standInEndpoints = (graphqlUrl: string): LinearOAuthEndpoints => {
  const origin = new URL(graphqlUrl).origin;
  return {
    authorize: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    revoke: `${origin}/oauth/revoke`,
  };
};

/** The callback URL on the origin the browser reaches the environment at, or null if not http(s). */
export const redirectUriFor = (callbackOrigin: string): string | null => {
  try {
    const url = new URL(callbackOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${CALLBACK_PATH}`;
  } catch {
    return null;
  }
};

export const authorizeUrl = (input: {
  readonly endpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string => {
  const url = new URL(input.endpoint);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    // Lets someone choose another account or workspace when signing in again.
    prompt: "consent",
  }).toString();
  return url.toString();
};

export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
});
export type TokenResponse = typeof TokenResponse.Type;

const TokenErrorBody = Schema.Struct({ error: Schema.String });
const decodeTokenError = Schema.decodeUnknownOption(TokenErrorBody);

/**
 * The token endpoint's refusal. `dead` means the sign-in itself is gone (expired, revoked or
 * rotated away) and only signing in again helps; anything else may pass.
 */
export function tokenFailure(
  status: number,
  body: unknown,
): { readonly dead: boolean; readonly error: BoardError } {
  const decoded = decodeTokenError(body);
  const code = decoded._tag === "Some" ? decoded.value.error : null;
  if (code === "invalid_grant" || code === "invalid_client" || status === 401) {
    return {
      dead: true,
      error: new BoardError({
        reason: "unauthorized",
        detail: "Your Linear sign-in has expired or was revoked. Sign in again in Settings.",
      }),
    };
  }
  if (status >= 500 || status === 429) {
    return {
      dead: false,
      error: new BoardError({
        reason: "unreachable",
        detail: `Linear's sign-in service is unavailable (HTTP ${status}).`,
      }),
    };
  }
  return {
    dead: false,
    error: new BoardError({
      reason: "invalid-response",
      detail: `Linear refused the sign-in (${code ?? `HTTP ${status}`}).`,
    }),
  };
}
