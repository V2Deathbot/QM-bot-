---
name: Discord deleted-message nonces
description: Safe handling for Discord code 10008 when recreating an outbox message that used an enforced nonce.
---

Discord may retain an enforced message nonce after the associated message is deleted. Reusing that nonce can return HTTP 404 / code 10008 even though a new message is being sent. Treat that exact response as definitive evidence that the nonce cannot recover an existing message, and recreate the missing message once without the stale nonce.

**Why:** Treating every 404 as ambiguous permanently blocked a saved uniform delivery after its upload-log notice disappeared.

**How to apply:** Give separate workflow stages distinct nonces. Limit the fallback to Discord code 10008 on message creation. Preserve unresolved/no-replay behavior for outcomes where Discord may have accepted the message.