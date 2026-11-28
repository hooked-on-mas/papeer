/** Backend addressing/authentication without loading a client, stores or recovery code. */
export function backendPort(): number {
  return Number((window as any).__PAPEER_PORT || import.meta.env.VITE_PAPEER_PORT || import.meta.env.VITE_PAPERDESK_PORT || 8000);
}
// Vite development only; packaged Tauri supplies its token through get_backend_config.
const DEV_TOKEN = 'dev_token';
export function authToken(): string {
  return (window as any).__PAPEER_TOKEN || import.meta.env.VITE_PAPEER_TOKEN || import.meta.env.VITE_PAPERDESK_TOKEN || (import.meta.env.DEV ? DEV_TOKEN : '');
}
export function backendUrl(path: string): string {
  return `http://127.0.0.1:${backendPort()}${path.startsWith('/') ? path : `/${path}`}`;
}
export function authorizedUrl(path: string): string {
  const url = new URL(backendUrl(path)), token = authToken(); if (token) url.searchParams.set('token', token); return url.toString();
}
