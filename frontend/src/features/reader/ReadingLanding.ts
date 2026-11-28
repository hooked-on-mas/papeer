import { createContext } from "react";
/** An explicit navigation request, separate from remount/resize restoration. */
export const ReadingLanding = createContext<{ toEnd: boolean; consumed: Set<string> } | null | undefined>(undefined);
