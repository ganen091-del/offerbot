---
name: Offer history by Telegram ID
description: The admin's ID-only history lookup avoids requiring target users to contact the bot.
---

An administrator may review all saved offers sent by a user, including earlier offers, by specifying the sender's Telegram ID. The target user does not need to contact the bot or repeat the activation command for history lookup.

**Why:** the user explicitly chose ID-only lookup to avoid asking target users to write to the bot. Telegram bots cannot generally resolve an arbitrary private user's ID by username, and earlier offers already recorded sender IDs.

**How to apply:** search stored offers by sender ID, not username. Keep history limited to the authorized administrator in a private chat, paginate it, and never claim to reconstruct offers that were never successfully saved.
