let pending: Promise<void> | undefined;

/** Preload before the user's click so OAuth can open its popup with user activation. */
export function loadGoogleSdk(): Promise<void> {
  if (window.google?.accounts.oauth2) return Promise.resolve();
  if (pending) return pending;
  const load = new Promise<void>((resolve, reject) => {
    document.getElementById("papeer-google-sdk")?.remove();
    const script = document.createElement("script");
    script.id = "papeer-google-sdk"; script.src = "https://accounts.google.com/gsi/client"; script.async = true;
    const finish = (error?: Error) => {
      clearTimeout(timer); script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Googleログイン機能の読み込みが時間切れになりました。")), 15_000);
    script.onload = () => finish(window.google?.accounts.oauth2 ? undefined : new Error("Googleログイン機能を読み込めませんでした。"));
    script.onerror = () => finish(new Error("Googleログイン機能を読み込めませんでした。"));
    try { document.head.append(script); }
    catch { finish(new Error("Googleログイン機能を読み込めませんでした。")); }
  });
  pending = load.finally(() => { pending = undefined; });
  return pending;
}
