---
name: Discord privileged intents
description: External Discord application settings required when a bot requests member data.
---

Discord gateway authorization for privileged intents is controlled by the Discord Developer Portal for the exact application that issued the bot token. A valid token and correct code can still fail with “Used disallowed intents” until the corresponding intent is enabled and saved there.

**Why:** The bot needs member access to resolve users and remove or restore roles; removing the intent would hide the configuration problem and break those commands.

**How to apply:** When this gateway error appears, verify the token’s application, enable Server Members Intent, save the setting, and restart the bot before changing application code.