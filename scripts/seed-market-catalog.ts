/**
 * Seed the platform instrument catalog from VALIDATED live prices.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/seed-market-catalog.ts --dry-run
 *   set -a; . ./.env; set +a; npx tsx scripts/seed-market-catalog.ts
 *
 * WHAT "SEEDING" MEANS HERE
 *   The platform's instrument catalog is the `market.instruments` setting (a
 *   comma-separated list), NOT a table — there is no broker to enumerate from in
 *   internal execution. This script writes that row.
 *
 * WHY IT VALIDATES FIRST
 *   An instrument that cannot be priced must never be offered: the client would
 *   open a position the engine cannot mark. So every symbol is priced against the
 *   LIVE API through the credit limiter before it is written, and anything the
 *   plan cannot price is reported and EXCLUDED rather than silently included.
 *
 * `--dry-run` validates and prints without touching the database.
 */

import { prisma } from '@/lib/prisma';
import { getTwelveDataQuotes } from '@/server/modules/market/twelve-data.service';
import { DEFAULT_PLATFORM_INSTRUMENTS } from '@/server/modules/market/twelve-data.service';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const requested = args.filter((arg) => !arg.startsWith('--'));
const symbols = requested.length > 0 ? requested : [...DEFAULT_PLATFORM_INSTRUMENTS];

async function main(): Promise<void> {
  console.log(`Validating ${symbols.length} instrument(s) against the live feed…`);
  const quotes = await getTwelveDataQuotes(symbols);

  const validated = symbols.filter((symbol) => quotes.prices[symbol] !== undefined);
  const rejected = symbols.filter((symbol) => quotes.prices[symbol] === undefined);

  console.log('\nVALIDATED (priceable):');
  for (const symbol of validated) console.log(`  ${symbol.padEnd(14)} ${quotes.prices[symbol]}`);

  if (rejected.length > 0) {
    console.log('\nEXCLUDED (not priceable on this plan):');
    for (const symbol of rejected) {
      console.log(`  ${symbol.padEnd(14)} ${quotes.unavailable[symbol] ?? 'no price returned'}`);
    }
  }

  if (validated.length === 0) {
    console.error('\nNothing validated — refusing to write an empty catalog.');
    process.exitCode = 1;
    return;
  }

  const value = validated.join(',');
  if (dryRun) {
    console.log(`\n[dry-run] would write market.instruments = ${value}`);
    return;
  }

  try {
    await prisma.platformSetting.upsert({
      where: { key: 'market.instruments' },
      create: { key: 'market.instruments', value, isSecret: false },
      update: { value },
    });
    console.log(`\nWrote market.instruments = ${value}`);
  } catch (err) {
    console.error(
      `\nCould not write the setting — is DATABASE_URL reachable from here? (${err instanceof Error ? err.message : err})`,
    );
    console.error('The validated list above is what to set once the database is reachable.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

void main();
