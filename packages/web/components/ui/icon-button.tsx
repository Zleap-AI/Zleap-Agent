import * as React from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import type { VariantProps } from "class-variance-authority"

type IconButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Required: icon-only buttons must be labelled for a11y. */
    "aria-label": string
  }

/** Icon-only button. Thin wrapper over `Button` that defaults to the ghost/icon
 *  variant and enforces an `aria-label`, so we stop hand-writing `<button>`s. */
function IconButton({
  variant = "ghost",
  size = "icon-sm",
  ...props
}: IconButtonProps) {
  return <Button variant={variant} size={size} {...props} />
}

export { IconButton }
