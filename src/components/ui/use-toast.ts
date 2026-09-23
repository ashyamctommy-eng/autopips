'use client';

/**
 * Tiny toast store (shadcn-style, hand-rolled).
 *
 * Module-level state + `useSyncExternalStore`, so toasts fired from an async
 * handler (a fetch callback, a socket listener) render without prop drilling.
 * No timers are started for a toast until it is actually shown, and the
 * auto-dismiss clock is paused while Radix holds it open (`onOpenChange`).
 */

import * as React from 'react';
import { useSyncExternalStore } from 'react';

export type ToastVariant = 'default' | 'info' | 'success' | 'warn' | 'danger';

export interface ToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** Milliseconds on screen. Defaults to 6000. */
  duration?: number;
  /** Usually a `<ToastAction>` element. */
  action?: React.ReactNode;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  open: boolean;
}

export interface ToastHandle {
  id: string;
  dismiss: () => void;
  update: (options: ToastOptions) => void;
}

interface ToastState {
  toasts: ToastRecord[];
}

/** Only the newest N toasts are kept mounted. */
const TOAST_LIMIT = 4;
const DEFAULT_DURATION = 6000;
/** Grace period so the exit animation can play before unmounting. */
const REMOVE_DELAY = 350;

let counter = 0;
function nextId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `toast-${counter}`;
}

let state: ToastState = { toasts: [] };
const listeners = new Set<() => void>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(next: ToastState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastState {
  return state;
}

function scheduleRemoval(id: string): void {
  if (removalTimers.has(id)) return;
  const timer = setTimeout(() => {
    removalTimers.delete(id);
    emit({ toasts: state.toasts.filter((entry) => entry.id !== id) });
  }, REMOVE_DELAY);
  removalTimers.set(id, timer);
}

/** Queue a toast. Callable outside React. */
export function toast(options: ToastOptions): ToastHandle {
  const id = nextId();
  const record: ToastRecord = {
    id,
    open: true,
    variant: options.variant ?? 'default',
    duration: options.duration ?? DEFAULT_DURATION,
    title: options.title,
    description: options.description,
    action: options.action,
  };
  const kept = [record, ...state.toasts];
  const overflow = kept.slice(TOAST_LIMIT).map((entry) => entry.id);
  emit({ toasts: kept.slice(0, TOAST_LIMIT) });
  for (const staleId of overflow) scheduleRemoval(staleId);
  return {
    id,
    dismiss: () => dismissToast(id),
    update: (next) => updateToast(id, next),
  };
}

/** Start the exit animation, then drop the record. */
export function dismissToast(id: string): void {
  emit({ toasts: state.toasts.map((entry) => (entry.id === id ? { ...entry, open: false } : entry)) });
  scheduleRemoval(id);
}

export function dismissAllToasts(): void {
  emit({ toasts: state.toasts.map((entry) => ({ ...entry, open: false })) });
  for (const entry of state.toasts) scheduleRemoval(entry.id);
}

export function updateToast(id: string, options: ToastOptions): void {
  emit({
    toasts: state.toasts.map((entry) => (entry.id === id ? { ...entry, ...options } : entry)),
  });
}

/** Clear the store. Test-only helper — also unmounts timers. */
export function resetToasts(): void {
  for (const timer of removalTimers.values()) clearTimeout(timer);
  removalTimers.clear();
  emit({ toasts: [] });
}

export interface UseToastResult {
  toasts: ToastRecord[];
  toast: (options: ToastOptions) => ToastHandle;
  dismiss: (id: string) => void;
  update: (id: string, options: ToastOptions) => void;
}

export function useToast(): UseToastResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return React.useMemo(
    () => ({
      toasts: snapshot.toasts,
      toast,
      dismiss: dismissToast,
      update: updateToast,
    }),
    [snapshot.toasts],
  );
}
