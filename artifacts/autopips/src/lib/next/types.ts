/** Minimal stand-ins for the next metadata types used by page modules. */
export interface Metadata {
  title?: string | { default?: string; template?: string; absolute?: string };
  description?: string;
  robots?: { index?: boolean; follow?: boolean } | string;
  [key: string]: unknown;
}
