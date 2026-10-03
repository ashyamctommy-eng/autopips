# Guarded braces

Local, MIT-licensed fork of <https://github.com/micromatch/braces/tree/3.0.3>.
The upstream parser/compiler/expander/stringifier and options are retained.
Comments are shortened; the upstream debug console statement is removed.
This is not an upstream release or a claim that upstream braces is patched.

GHSA-vfj7-8cjw-p6xm has no patched upstream release as of 2026-10-03.
The active app uses braces only through build-time globbing (Tailwind,
micromatch, chokidar, fast-glob); no request handler accepts brace patterns.
Nonetheless, malicious build inputs could reach the vulnerable walkers.

Hardening:

- The parser rejects more than 32 nested blocks, including parentheses,
  before allocating another block or calling any recursive walker.
- Every recursive AST entry point validates the tree iteratively, rejecting
  depth greater than 34 (root and terminal leaf included), cycles/shared nodes,
  invalid parent links, and more than 10,002 nodes.
- Supplied parent chains are also checked iteratively for cycles and depth.
- Limits cannot be raised or disabled through caller options.
- Existing upstream input-length and numeric expansion limits remain.

Both the pnpm workspace and the archived npm project replace `braces` with
this package. Test with `pnpm --filter @workspace/guarded-braces test`.
Replace the fork with a patched upstream release when one becomes available.