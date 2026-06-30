"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "cn-toast rounded-xl border border-border bg-popover text-popover-foreground shadow-pop",
          title: "text-sm font-medium text-foreground",
          description: "text-sm text-muted-foreground",
          icon: "text-primary",
          closeButton:
            "border-border bg-popover text-muted-foreground hover:bg-muted hover:text-foreground",
          actionButton:
            "bg-primary text-primary-foreground hover:bg-primary/80",
          cancelButton:
            "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
