---
name: Atomic GitHub publish through the App
description: Publish a verified local tree to GitHub when command-line push authentication is unavailable.
---

When command-line `git push` authentication fails but the connected GitHub App has write access, the Git Data API can publish the full tree as one atomic commit. Verify the remote tip and local tree first; create a tree based on the remote tip, compare its SHA with local `HEAD^{tree}`, create a commit, recheck the ref, then advance it without force. An API-created commit may have a different SHA and ancestry from local commits even when its tree is identical.

**Why:** A rejected CLI credential did not prevent the connected GitHub App from publishing the exact merged tree, and a single ref update avoided partial deploys.

**How to apply:** Use this only for an explicitly approved push. Consult GitHub's current Git Data API docs, never request or expose a PAT when the App is available, stop if the remote ref changed or the tree hash differs, and account for local branch ancestry after an API-created commit.