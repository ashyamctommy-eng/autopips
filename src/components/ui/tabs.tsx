'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export const tabsListVariants = cva('inline-flex items-center text-muted', {
  variants: {
    variant: {
      default: 'h-9 justify-center gap-1 rounded-lg border border-line bg-base-850 p-1',
      line: 'gap-4 border-b border-line pb-0',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn(tabsListVariants({ variant }), className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const tabsTriggerVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default:
          'h-7 rounded-md px-3 data-[state=active]:bg-base-700 data-[state=active]:text-base-100 data-[state=active]:shadow-card',
        line: '-mb-px h-9 rounded-none border-b-2 border-transparent px-1 data-[state=active]:border-brand data-[state=active]:text-base-100',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface TabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>,
    VariantProps<typeof tabsTriggerVariants> {}

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(tabsTriggerVariants({ variant }), className)}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('mt-4 focus-visible:outline-none', className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
