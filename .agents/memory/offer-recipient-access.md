---
name: Offer recipient access rules
description: Product intent and identity-binding rationale for choosing an NFT recipient.
---

Administrators can grant users permission to append a recipient username to an offer. Without that permission, retain the original default recipient; granting permission does not change the default or the destinations of earlier offers.

**Why:** the user requested delegated recipient selection while keeping everyone else's routing unchanged.

**How to apply:** treat recipient selection as a separate permission from general bot activation. Store the chosen destination with each offer, so subsequent grants or commands cannot redirect existing offers.

Do not preserve automatic recipient-selection exceptions for previously privileged users. Only the designated owner retains administrative commands, and users receive custom-recipient access through a fresh explicit grant.

**Why:** the user asked to reset the former special user's access and issue permissions again personally.

**How to apply:** ordinary activation and recipient-selection checks apply uniformly; do not restore a hardcoded username bypass when revising permissions.

Bind a username-based grant to the user's stable Telegram ID on its first authenticated use; duplicate grants must not clear that binding.

**Why:** Telegram usernames can change owners, while an already-granted capability should stay with its original user.

**How to apply:** preserve ID-bound access after a username change, and never grant access to a new holder of a previously bound username just because the username matches.
