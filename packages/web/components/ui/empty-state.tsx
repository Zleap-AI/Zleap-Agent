import * as React from "react"

import { cn } from "@/lib/utils"

/** Unified empty state. Replaces the per-feature inline empties (manage / sidebar
 *  / workspace) so blank surfaces look identical everywhere. */
function EmptyState({
  icon,
  title,
  description,
  action,
  bordered = true,
  className,
}: {
  icon?: React.ReactNode
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  bordered?: boolean
  className?: string
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        bordered && "rounded-lg border border-dashed border-border",
        className,
      )}
    >
      {icon ? (
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      {title ? <div className="text-sm font-medium text-foreground">{title}</div> : null}
      {description ? <div className="max-w-sm text-xs text-muted-foreground">{description}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
