---
name: Telegram polling during VM rollouts
description: Why production polling must tolerate overlapping revisions and stay separate from development.
---

Keep a single polling owner across production revisions, and never run development polling with the production bot token.

**Why:** a failed publication was traced to overlapping old and new production VMs. The new poller displaced the old one; the old VM restarted and displaced the candidate, whose fatal 409 handling stopped publication. Development was already stopped at that time, so do not assume every 409 comes from development.

**How to apply:** preserve shared-database session-lock coordination and transient 409 retries during rollouts. Development requires a separate test-bot token. A healthy dev API with polling disabled does not prove that the latest production bot code has been published.
