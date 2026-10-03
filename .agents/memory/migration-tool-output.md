---
name: Migration tool output
description: A shell callback output detail that matters when generating route registries.
---

Trim each line of shell output before treating it as a filesystem path, not only
the full output string.

**Why:** The shell callback returned CRLF-delimited output; splitting on newline
alone left carriage returns embedded in generated imports and route URLs.

**How to apply:** Normalize individual lines when deriving file lists, route
registries, or generated manifests from shell callback output.