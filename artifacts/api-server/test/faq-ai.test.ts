import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHybridFaqAnswer,
  hybridFaqVoicePrompt,
} from "../src/bot/faq-ai.ts";

test("hybrid FAQ voice permits playful sarcasm without changing official facts", () => {
  assert.match(hybridFaqVoicePrompt, /confident, lively, funny/i);
  assert.match(hybridFaqVoicePrompt, /light sarcasm, playful teasing, memes/i);
  assert.match(hybridFaqVoicePrompt, /ranks, eligibility, mistakes, blacklists, moderation, and enforcement/i);
  assert.match(hybridFaqVoicePrompt, /do not use slurs, threats, sexual content/i);
  assert.match(hybridFaqVoicePrompt, /Do not add requirements, prices, ranks/i);
});

test("hybrid FAQ safely falls back to the fixed answer when AI is unavailable", async () => {
  const previousBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const previousApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  try {
    const match = { id: "fixed", answer: "The approved fixed answer." };
    assert.equal(
      await createHybridFaqAnswer("What is the answer?", match),
      match.answer,
    );
  } finally {
    if (previousBaseUrl) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = previousBaseUrl;
    if (previousApiKey) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = previousApiKey;
  }
});