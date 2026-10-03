import { serverEnv } from '@/lib/env';
import { getSetting } from '@/server/modules/settings/settings.service';

/**
 * The public-execution disclosure.
 *
 * WHY THIS IS MODE-DEPENDENT
 *   The written disclosure must match how the deployment ACTUALLY executes. If
 *   `EXECUTION_MODE=internal`, the platform is the counterparty and no broker
 *   order exists; publishing "orders are placed on third-party broker accounts"
 *   would then be a false statement to clients. If the mode is `broker`, the
 *   internal wording would overstate what the platform is.
 *
 *   So the page renders whichever notice is true for the running mode. The
 *   internal notice is operator-editable (Admin → Settings →
 *   `disclosure.internal_execution_notice`), so legal wording can change without
 *   a redeploy, and the default here is a reviewed-by-counsel-required baseline.
 *
 * Reading the setting NEVER throws: `getSetting` falls back to the definition's
 * default when no console row and no env var exist, so a public page cannot be
 * taken down by a settings outage.
 */

/** True when this deployment books trades internally rather than at a broker. */
export function isInternalExecutionMode(): boolean {
  return serverEnv().EXECUTION_MODE === 'internal';
}

/**
 * PURE: split a notice into paragraphs.
 *
 * A blank line separates paragraphs (matching the admin textarea), single line
 * breaks inside a paragraph are preserved as written.
 */
export function splitNoticeParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** The operator-editable internal-execution notice, as paragraphs. */
export function internalExecutionNotice(): string[] {
  return splitNoticeParagraphs(getSetting('disclosure.internal_execution_notice'));
}
