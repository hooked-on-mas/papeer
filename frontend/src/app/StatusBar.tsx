import { GlobalProgress } from "../features/jobs/GlobalProgress";

export function StatusBar() {
  return (
    <footer className="h-[32px] border-t flex items-center px-4 text-xs text-muted-foreground shrink-0 justify-between bg-background">
      <div className="flex items-center gap-2">
        <GlobalProgress />
      </div>
      <div className="flex items-center gap-4">
        {/* <button className="hover:text-foreground">移動を戻す</button> */}
        <span>codex</span>
        <span>v0.2</span>
      </div>
    </footer>
  );
}
