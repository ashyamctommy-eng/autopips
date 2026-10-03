---
name: Large connector payloads
description: Safely transfer sizeable local repository data through CodeExecution into authenticated connector APIs.
---

When using CodeExecution `shellExec` to move repository data into a connector API, large stdout can be clipped even when `maxOutputBytes` is set higher and the returned truncation flag is false. Compress the payload and transfer it in small chunks, then reassemble it inside CodeExecution. Do not print the combined content.

**Why:** A large GitHub tree payload was parsed after the output had been clipped at an arbitrary point; chunked transfer succeeded.

**How to apply:** Use this for GitHub Git-Database writes or other connector calls that need local file contents. Verify every chunk, keep credentials inside `use impure`, and log only counts or hashes.