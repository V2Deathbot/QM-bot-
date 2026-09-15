---
name: Discord settings interaction contracts
description: Lessons from moving slash actions into a shared settings menu.
---

Test menu actions with Discord's actual acknowledgement and component constraints, not only command-shaped mocks.

**Why:** A menu migration exposed cases where permissive mocks accepted editing an unacknowledged response, and stored text exceeded Discord's shorter select-label limit. Slash-command coverage alone did not catch these integration errors.

**How to apply:** Every dropdown/button must reply, update, or defer before editing. Bind interactive controls and the modal itself to the session nonce, not modal text-input field keys. Test long stored values separately from truncated UI labels, and migrate only recognized old defaults while preserving custom settings.

Test modal submissions using the actual serialized field IDs, with missing-field errors matching Discord.

**Why:** Tests that invented submission keys concealed a form-builder mismatch: completed forms failed because session scoping had renamed their input fields.

**How to apply:** Capture the emitted modal JSON, construct submissions from its fields, and verify persisted values rather than only checking the modal opened.

Validate Discord command registration constraints in serialization tests, not just builder construction.

**Why:** The builder accepted a required channel after optional asset fields, but Discord rejected the entire guild command registration, blocking bot startup.

**How to apply:** Assert required options precede optional ones for every command whenever adding options.