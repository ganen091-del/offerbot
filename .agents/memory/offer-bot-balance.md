---
name: Offer bot balance rules
description: Product rules for the Telegram NFT offer bot's Stars/Gram accounting.
---

The bot tracks balances denominated in Telegram Stars and Gram. When an offer is accepted, debit the balance of the user who sent `/offer`.

**Why:** the user specified this balance behavior.

**How to apply:** use this as the debit rule when implementing offers; do not infer who receives a credit or who may add funds.
