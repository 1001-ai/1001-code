import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as Board from "./Board.ts";
import { CALLBACK_PATH } from "./linearOAuth.ts";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const renderSignInPage = (title: string, message: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
      main { width: min(100%, 440px); }
      h1 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0; line-height: 1.5; color: #4b5060; }
      @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #e6e8ee; } p { color: #a0a6b4; } }
    </style>
  </head>
  <body>
    <main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
  </body>
</html>`;

const page = (status: number, title: string, message: string) =>
  HttpServerResponse.text(renderSignInPage(title, message), {
    status,
    contentType: "text/html",
    headers: PAGE_HEADERS,
  });

/**
 * Linear redirects the signing-in browser here. The route needs no session: the single-use `state`
 * from `Board.startSignIn` is what ties the redirect to a sign-in someone with access started.
 */
export const layer = HttpRouter.add(
  "GET",
  CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(request.originalUrl, "http://localhost").searchParams;
    const board = yield* Board.Board;
    return yield* board
      .completeSignIn({
        state: params.get("state"),
        code: params.get("code"),
        error: params.get("error"),
      })
      .pipe(
        Effect.map(() => page(200, "Signed in to Linear", "You can close this tab.")),
        Effect.catchTags({
          BoardSignInError: (error) =>
            Effect.succeed(page(400, "Linear sign-in failed", error.message)),
        }),
      );
  }),
);
