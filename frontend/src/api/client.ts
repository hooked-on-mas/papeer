import createClient from "openapi-fetch";
import type { paths } from "./schema";
import { sendWhenLibraryFree } from "@/lib/libraryBusy";

export function backendPort(): number {
  return Number((window as any).__PAPEER_PORT || import.meta.env.VITE_PAPEER_PORT || import.meta.env.VITE_PAPERDESK_PORT || 8000);
}

/**
 * The token `just dev-sidecar` starts the development sidecar with (the same value as DEV_TOKEN in
 * src-tauri/src/lib.rs). Only a Vite dev server falls back to it; a production build has no default.
 */
const DEV_TOKEN = "dev_token";

/**
 * The sidecar's token. Inside Tauri it comes from get_backend_config (main.tsx); in a plain browser
 * during development, from VITE_PAPEER_TOKEN, else the development default.
 */
export function authToken(): string {
  return (window as any).__PAPEER_TOKEN || import.meta.env.VITE_PAPEER_TOKEN || import.meta.env.VITE_PAPERDESK_TOKEN
    || (import.meta.env.DEV ? DEV_TOKEN : "");
}

export function backendUrl(path: string): string {
  return `http://127.0.0.1:${backendPort()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** URL usable from <img> and other elements that cannot send an Authorization header. */
export function authorizedUrl(path: string): string {
  const url = new URL(backendUrl(path));
  const token = authToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/**
 * The typed client: paths, parameters, bodies and answers come from schema.d.ts (`just gen-api` makes it
 * from the sidecar). Read the answer with unwrap(), which fails like apiRequest.
 */
export const api = createClient<paths>({
  baseUrl: "http://127.0.0.1:8000/", // dummy
  fetch: async (request) => {
    const url = new URL(request.url);
    url.port = backendPort().toString();
    const newRequest = new Request(url.toString(), request);
    const token = authToken();
    if (token) {
      newRequest.headers.set("Authorization", `Bearer ${token}`);
    }
    // Like apiRequest: one refused while the automatic sync runs in the background is sent again after it.
    const { response } = await sendWhenLibraryFree(async () => {
      let response: Response;
      try {
        response = await fetch(newRequest.clone());
      } catch (error) {
        // As apiRequest: a stopped request rejects with its AbortError, an unreachable sidecar with an ApiError.
        if (newRequest.signal.aborted) throw error;
        throw new ApiError("バックエンドに接続できませんでした。", 0);
      }
      const body = response.status === 409 ? await response.clone().json().catch(() => null) : null;
      return { status: response.status, body, response };
    });
    return response;
  }
});

export class ApiError extends Error {
  /** `code` is the body's machine-readable reason when it gives one, such as library_busy (libraryBusy.ts). */
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

function errorMessage(body: any, status: number): string {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d?.msg ?? JSON.stringify(d)).join("\n");
  return `通信エラー (${status})`;
}

/**
 * The answer of a typed request, `unwrap(api.GET("/api/papers/{paper_id}", ...))`; a refusal throws the
 * ApiError that apiRequest would (with the body's code, such as library_busy).
 */
export async function unwrap<R extends { data?: unknown; error?: unknown; response: Response }>(
  request: Promise<R>): Promise<Exclude<R["data"], undefined>> {
  const { data, error, response } = await request;
  if (!response.ok) {
    const code = (error as { code?: unknown } | undefined)?.code;
    throw new ApiError(errorMessage(error, response.status), response.status, typeof code === "string" ? code : undefined);
  }
  return data as Exclude<R["data"], undefined>;
}

/**
 * Untyped request, for the endpoints not moved to the typed client (api and unwrap) yet.
 * One refused while the automatic sync runs in the background waits for it and is sent again (libraryBusy.ts).
 * `signal` stops it (a query's, when its key changes: a search typed further); the promise then rejects
 * with the AbortError itself, which React Query takes for a cancellation rather than a failure.
 */
export async function apiRequest<T = any>(method: string, path: string, body?: unknown,
  { signal }: { signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await sendWhenLibraryFree(async () => {
    let response: Response;
    try {
      response = await fetch(backendUrl(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError("バックエンドに接続できませんでした。", 0);
    }
    const text = await response.text();
    return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null };
  });
  if (!response.ok) {
    const code = typeof response.body?.code === "string" ? response.body.code : undefined;
    throw new ApiError(errorMessage(response.body, response.status), response.status, code);
  }
  return response.body as T;
}
