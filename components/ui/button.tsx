import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:bg-[#6aa0ff]",
      secondary: "bg-secondary text-secondary-foreground hover:bg-[#202a39]",
      outline: "border bg-background/60 text-foreground hover:bg-secondary",
      ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
    },
    size: { default: "h-10 px-4", sm: "h-9 px-3", lg: "h-11 px-5", icon: "size-10 px-0" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({ className, variant, size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
