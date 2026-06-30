import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const chipVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-pill border whitespace-nowrap font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
        active: "border-transparent bg-accent-soft text-primary",
        outline: "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      },
      size: {
        sm: "h-6 px-2 text-2xs",
        default: "h-7 px-2.5 text-xs",
      },
      interactive: {
        true: "cursor-pointer",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      interactive: false,
    },
  },
)

type ChipProps = React.ComponentProps<"button"> &
  VariantProps<typeof chipVariants> & {
    asChild?: boolean
  }

function Chip({ className, variant, size, interactive, asChild = false, ...props }: ChipProps) {
  const isButton = !asChild && props.onClick !== undefined
  const Comp = asChild ? Slot.Root : isButton ? "button" : "span"
  return (
    <Comp
      data-slot="chip"
      className={cn(chipVariants({ variant, size, interactive: interactive ?? isButton, className }))}
      {...(props as Record<string, unknown>)}
    />
  )
}

export { Chip, chipVariants }
