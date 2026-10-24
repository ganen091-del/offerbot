---
name: Telegram Business message deletion
description: Use the Business-specific Bot API method to delete messages in connected business chats.
---

Delete messages in connected Telegram Business chats with `deleteBusinessMessages` and the connection ID plus message IDs. A regular `deleteMessage` may return “message to delete not found” even when the business message is visible. Deleting owner-sent messages may require the connection's delete-all-messages right; deleting bot-sent messages requires its delete-sent-messages right.

**Why:** Telegram keeps connected business messages in a separate context from the bot's ordinary chat messages.

**How to apply:** use the Business-specific method for source commands and bot messages sent on behalf of a business connection; if deletion fails, report the required Business permission instead of silently treating the offer as fully processed.
