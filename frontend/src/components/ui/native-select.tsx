import * as React from "react"
import { cn } from "cn"

/** Plain <select> styled like the other inputs; used where options change at runtime. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
