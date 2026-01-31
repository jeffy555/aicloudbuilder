import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Whitespace-nowrap: Badges should never wrap.
  "whitespace-nowrap inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-all duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2" +
  " hover-elevate hover:scale-105",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-gradient-primary text-primary-foreground shadow-xs hover:shadow-sm",
        secondary: 
          "border-transparent bg-secondary/80 backdrop-blur-sm text-secondary-foreground shadow-xs hover:shadow-sm hover:bg-secondary",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-xs hover:shadow-sm hover:brightness-110",

        outline: 
          "border [border-color:var(--badge-outline)] shadow-xs hover:shadow-sm hover:bg-muted/50",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants }
