import { useStore } from "@/store";
import { statusLifetime } from "@/lib/statusLifetime";

/**
 * Clears the status bar message once it has been up long enough to read (lib/statusLifetime.ts),
 * so an old outcome does not read as news later. It runs whether or not the bar is shown (focus
 * mode hides it), and clears the store, so the same message set again shows again.
 */
let timer: ReturnType<typeof setTimeout> | undefined;
let held = false;

function schedule(message: string): void {
  clearTimeout(timer);
  timer = undefined;
  const lifetime = statusLifetime(message);
  if (lifetime === null || held) return;
  timer = setTimeout(() => {
    if (useStore.getState().statusMessage === message) useStore.getState().setStatus("");
  }, lifetime);
}

/** While the pointer is on the status bar the message stays; it gets its full time again after. */
export function holdStatus(hold: boolean): void {
  if (held === hold) return;
  held = hold;
  schedule(useStore.getState().statusMessage);
}

schedule(useStore.getState().statusMessage);
useStore.subscribe((state, previous) => {
  if (state.statusMessage !== previous.statusMessage) schedule(state.statusMessage);
});
