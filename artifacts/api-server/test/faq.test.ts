import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFaq, FaqReplyLimiter, matchFaqQuestion, normalizeFaqText } from "../src/bot/faq.ts";
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
  assert.equal(answerFaq("Please stop discussing blue pants here"), undefined);
  assert.equal(answerFaq("I am not asking how to become a quartermaster"), undefined);
  assert.equal(matchFaqQuestion("ticket"), undefined);
});

test("FAQ cooldowns suppress channel, user, and duplicate-answer bursts", () => {
  const limiter = new FaqReplyLimiter();
  const attempt = { guildId: "guild", channelId: "channel", userId: "user", faqId: "ticket-order" };
  assert.equal(limiter.claim(attempt, 1_000_000), true);
  assert.equal(limiter.claim({ ...attempt, userId: "other", faqId: "check-awards" }, 1_010_000), false);
  assert.equal(limiter.claim({ ...attempt, channelId: "other-channel", faqId: "check-awards" }, 1_020_000), false);
  assert.equal(limiter.claim({ ...attempt, userId: "other", faqId: "ticket-order" }, 1_070_000), false);
  assert.equal(limiter.claim({ ...attempt, userId: "other", faqId: "ticket-order" }, 1_121_000), true);
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