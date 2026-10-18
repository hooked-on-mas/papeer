import { PageNavigatorView } from "./PageNavigatorView";
import { jumpToPage, movePage } from "./navigation";
import type { ComponentProps } from "react";

/** Desktop commands are kept out of the shared page controls. */
export function PageNavigator(props: Omit<ComponentProps<typeof PageNavigatorView>, "onJump" | "onMove" | "inputId">) {
  return <PageNavigatorView {...props} onJump={jumpToPage} onMove={movePage} />;
}
