---
name: Telegram polling during VM rollouts
description: Why production polling must tolerate overlapping revisions and stay separate from development.
---

Keep a single polling owner across production revisions, and never run development polling with the production bot token.

**Why:** a failed publication was traced to overlapping old and new production VMs. The new poller displaced the old one; the old VM restarted and displaced the candidate, whose fatal 409 handling stopped publication. Development was already stopped at that time, so do not assume every 409 comes from development.

**How to apply:** preserve shared-database session-lock coordination and transient 409 retries during rollouts. Development requires a separate test-bot token. A healthy dev API with polling disabled does not prove that the latest production bot code has been published.

A long-lived polling-lock database connection can be terminated by the provider; treat losing that connection as losing polling ownership.

**Why:** production telemetry repeatedly showed PostgreSQL `57P01` administrative connection termination on the dedicated client, followed by an unhandled error and application restarts, including while normal offer processing otherwise worked.

**How to apply:** any recovery must stop the old poller before reacquiring a new session lock. Merely swallowing the connection error would leave polling running without ownership. Distinguish these availability failures from Telegram send failures when diagnosing an ignored command.

Do not automatically replay an interrupted offer send after reconnecting.

**Why:** sending through Telegram and recording the offer locally are not one atomic operation. A lost response can mean Telegram sent the message even though the bot saw an error; automatic replay could create duplicate offers.

**How to apply:** retain completed update acknowledgements during in-process recovery and warn the administrator to check the chat before retrying an interrupted action. Report provider refusals without claiming they can be removed by restarting or publishing.
