// A blocking, same-origin script: apply the saved theme before the first paint, within Tauri's CSP.
(() => {
  let theme = "system";
  try {
    const saved = localStorage.getItem("papeer-ui-theme") ?? localStorage.getItem("paperdesk-ui-theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {
    // Storage may be disabled. Follow the system until the app is ready.
  }
  document.documentElement.dataset.theme = theme;
})();
