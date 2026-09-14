---
name: Discord settings interaction contracts
description: Lessons from moving slash actions into a shared settings menu.
---

Test menu actions with Discord's actual acknowledgement and component constraints, not only command-shaped mocks.

**Why:** A menu migration exposed cases where permissive mocks accepted editing an unacknowledged response, and valid 128-character presence text exceeded Discord's shorter select-label limit. Slash-command coverage alone did not catch these integration errors.

**How to apply:** Every dropdown/button must reply, update, or defer before editing; every new child component must retain the session nonce. Test long stored values separately from truncated UI labels, and migrate only recognized old defaults while preserving custom settings.