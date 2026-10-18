/**
 * While a sync, backup or restore holds the library, the sidecar refuses every other request unrun:
 * 409 with this code in the body (sidecar/app.py, protect_library_snapshot).
 *
 * The automatic sync runs in the background (no waiting screen), so the user may save a memo or open
 * a paper meanwhile. Such a refusal is then not a failure: the request waits for that sync and is sent
 * again (it never ran, so sending it twice cannot apply it twice). A sync with the waiting screen, a
 * backup or a restore may replace the library, after which an old write must not be applied, so their
 * refusals stay errors as before. Which case applies is the waiter's call (driveSync.ts).
 */
export const LIBRARY_BUSY = "library_busy";

type Waiter = () => Promise<boolean>;

let waiter: Waiter = async () => false;

/** `wait` resolves to true once a refused request may be sent again, false when it must fail. */
export function setLibraryBusyWaiter(wait: Waiter): void {
  waiter = wait;
}

export function isLibraryBusy(status: number, body: unknown): boolean {
  return status === 409 && typeof body === "object" && body !== null
    && (body as { code?: unknown }).code === LIBRARY_BUSY;
}

/**
 * Call `send` again while the sidecar refuses it for a background sync, at most `attempts` times in all;
 * resolves to the last response either way.
 */
export async function sendWhenLibraryFree<T extends { status: number; body: unknown }>(
  send: () => Promise<T>, attempts = 4,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await send();
    if (attempt >= attempts || !isLibraryBusy(response.status, response.body) || !await waiter()) return response;
  }
}
