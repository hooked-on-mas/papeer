import createClient from "openapi-fetch";
import type { paths } from "./schema";

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

export const api = createClient<paths>({
  baseUrl: "http://127.0.0.1:8000/", // dummy
  fetch: (request) => {
    const url = new URL(request.url);
    url.port = backendPort().toString();
    const newRequest = new Request(url.toString(), request);
    const token = authToken();
    if (token) {
      newRequest.headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(newRequest);
  }
});

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function errorMessage(body: any, status: number): string {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d?.msg ?? JSON.stringify(d)).join("\n");
  return `通信エラー (${status})`;
}

/** Untyped request for endpoints the generated schema does not describe yet. */
export async function apiRequest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(backendUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("バックエンドに接続できませんでした。", 0);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(errorMessage(data, response.status), response.status);
  return data as T;
}
