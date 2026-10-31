---
name: Offer bot balance rules
description: Product rules for the Telegram NFT offer bot's currency accounting.
---

The bot tracks balances denominated in Telegram Stars, Gram, RUB, and UAH. Only configured administrators may manually top up a balance; when an offer is accepted, debit the balance of the user who sent `/offer`.

**Why:** the user specified this balance behavior.

**How to apply:** use this as the debit and top-up authorization rule when implementing offers; do not infer who receives a credit from an accepted offer.
