/** A scripted `fetch` mock for provider tests. */

import { vi } from "vitest";
import type { FetchFn } from "../../src/providers/base";

export type MockReply =
  | { status?: number; json?: unknown; body?: string }
  | Error
  | ((request: RecordedRequest) => MockReply | Promise<MockReply>);

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface Route {
  method?: string;
  /** Matches when the URL pathname (relative to the API host) equals or matches this. */
  path: string | RegExp;
  reply: MockReply;
}

/**
 * Build a fetch mock that answers requests from `routes` (first match wins)
 * and records every request it sees. Unmatched requests return 404.
 */
export function mockFetch(routes: Route[]) {
  const requests: RecordedRequest[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: RecordedRequest = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);

    const route = routes.find(
      (r) =>
        (r.method ?? "GET") === request.method &&
        (typeof r.path === "string" ? url.pathname === r.path : r.path.test(url.pathname)),
    );
    let reply: MockReply = route ? route.reply : { status: 404, json: { error: "not found" } };
    while (typeof reply === "function") reply = await reply(request);
    if (reply instanceof Error) throw reply;

    const body = reply.body ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const fn = vi.fn(impl);
  return { fetch: fn as unknown as FetchFn, mock: fn, requests };
}

/** Query parameters of a recorded request as a plain object. */
export function queryOf(request: RecordedRequest): Record<string, string> {
  return Object.fromEntries(request.url.searchParams.entries());
}
