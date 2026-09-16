import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFaq, matchFaqQuestion, normalizeFaqText } from "../src/bot/faq.ts";
import {
  automaticAnswerChannelIdsFor,
  validateGuildSettingsDocument,
} from "../src/bot/setup-store.ts";

test("FAQ normalization is Unicode, case, punctuation, and whitespace stable", () => {
  assert.equal(
    normalizeFaqText("  Tícket—REQUESTS?!\n  "),
    "ticket requests",
  );
});

test("FAQ answers only a strong known question and stays silent when unsure", () => {
  assert.match(answerFaq("Where do I order a uniform?") ?? "", /ticket-requests/);
  assert.match(answerFaq("What are the Army winter Class A requirements?") ?? "", /Sergeant through Master Sergeant/);
  assert.match(answerFaq("How much is a veteran uniform?") ?? "", /75 Robux/);
  assert.equal(answerFaq("Can someone help me?"), undefined);
  assert.equal(answerFaq("How long does this take?"), undefined);
  assert.equal(answerFaq("I bought something and have a problem"), undefined);
  assert.equal(matchFaqQuestion("ticket"), undefined);
});

test("automatic answer setup accepts legacy absence and rejects unsafe shapes", () => {
  const base = {
    guildId: "guild",
    moderatorRoleId: "role",
    auditChannelId: "12345",
    updatedBy: "owner",
    updatedAt: new Date().toISOString(),
  };
  validateGuildSettingsDocument({ guilds: [base] });
  assert.deepEqual(
    automaticAnswerChannelIdsFor({
      ...base,
      automaticAnswerChannelIds: ["12345", "12345", "bad"],
    }),
    ["12345"],
  );
  assert.throws(
    () => validateGuildSettingsDocument({
      guilds: [{
        ...base,
        automaticAnswerChannelIds: Array.from({ length: 11 }, (_, index) => String(10000 + index)),
      }],
    }),
    /invalid format/i,
  );
});