import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      data-slot="spinner"
      className={cn("size-4 animate-spin text-muted-foreground", className)}
      aria-hidden
      {...props}
    />
  )
}

/** Centered loading state for panels/lists. Pass `label` for a11y + visible hint. */
function LoadingState({
  label,
  className,
  spinnerClassName,
}: {
  label?: React.ReactNode
  className?: string
  spinnerClassName?: string
}) {
  return (
    <div
      role="status"
      aria-busy
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-14 text-sm text-muted-foreground",
        className,
      )}
    >
      <Spinner className={cn("size-5", spinnerClassName)} />
      {label ? <span>{label}</span> : null}
    </div>
  )
}

export { Spinner, LoadingState }
