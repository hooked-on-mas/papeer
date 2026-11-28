import { PageNavigatorView } from "./PageNavigatorView";
import { desktopReaderCommands } from "./useViewerInput";
import type { ComponentProps } from "react";

/** Desktop commands are kept out of the shared page controls. */
export function PageNavigator(props: Omit<ComponentProps<typeof PageNavigatorView>, "onJump" | "onMove" | "inputId">) {
  return <PageNavigatorView {...props} onJump={page => { desktopReaderCommands("pdf").dispatch({ type: "jump", page }); }} onMove={amount => { desktopReaderCommands("pdf").dispatch({ type: "step", amount: amount < 0 ? -1 : 1 }); }} />;
}
