import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0" +
  " transition-all duration-200 ease-in-out hover-elevate active:elevate-2 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-primary text-primary-foreground border border-primary-border shadow-primary hover:shadow-primary-lg hover:scale-[1.02] hover:glow-primary focus-visible:glow-primary",
        destructive:
          "bg-destructive text-destructive-foreground border border-destructive-border shadow-destructive hover:shadow-destructive hover:scale-[1.02] hover:brightness-110 hover:glow-destructive focus-visible:glow-destructive",
        outline:
          // Shows the background color of whatever card / sidebar / accent background it is inside of.
          // Inherits the current text color.
          "border [border-color:var(--button-outline)] shadow-xs hover:shadow-sm hover:bg-muted/50 active:shadow-none",
        secondary: 
          "border bg-secondary/80 backdrop-blur-sm text-secondary-foreground border-secondary-border shadow-sm hover:bg-secondary hover:shadow-md hover:backdrop-blur-md",
        // Add a transparent border so that when someone toggles a border on later, it doesn't shift layout/size.
        ghost: 
          "border border-transparent hover:bg-muted/50 hover:shadow-sm active:bg-muted/70",
      },
      // Heights are set as "min" heights, because sometimes Ai will place large amount of content
      // inside buttons. With a min-height they will look appropriate with small amounts of content,
      // but will expand to fit large amounts of content.
      size: {
        default: "min-h-9 px-4 py-2 sm:min-h-[44px] sm:px-4 sm:py-2.5",
        sm: "min-h-8 rounded-md px-3 text-xs sm:min-h-[44px] sm:px-4",
        lg: "min-h-10 rounded-md px-8 sm:min-h-[48px]",
        icon: "h-9 w-9 sm:h-11 sm:w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
