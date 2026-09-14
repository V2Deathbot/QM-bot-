import assert from "node:assert/strict";
import test from "node:test";
import {
  displayId,
  embedOnlyResponse,
  presentationEmbed,
  safePresentationText,
  trustedPresentationText,
} from "../src/bot/presentation.ts";

test("presentation embeds stay within Discord field and aggregate limits", () => {
  const embed = presentationEmbed(
    "Large status",
    "D".repeat(4_096),
    "info",
    undefined,
    Array.from({ length: 40 }, (_, index) => ({
      name: `Field ${index}`,
      value: "V".repeat(1_024),
    })),
  );
  const data = embed.toJSON();
  const fields = data.fields ?? [];
  const total = [
    data.title ?? "",
    data.description ?? "",
    ...fields.flatMap((field) => [field.name, field.value]),
  ].join("").length;

  assert.ok(fields.length <= 25);
  assert.ok(fields.every((field) => field.name.length <= 256 && field.value.length <= 1_024));
  assert.ok(total <= 6_000);
});

test("trusted formatting survives while untrusted markdown and mentions are cleaned", () => {
  assert.equal(displayId("123456789012345678"), "`123456789012345678`");
  assert.equal(trustedPresentationText("Card `123` for @everyone"), "Card `123` for @\u200beveryone");
  assert.equal(safePresentationText("Card `123` for @everyone"), "Card '123' for @\u200beveryone");

  const embed = presentationEmbed(
    "Formatting",
    "A concise result",
    "success",
    undefined,
    [{ name: "Record", value: displayId("123456789012345678") }],
  ).toJSON();
  assert.equal(embed.fields?.[0]?.value, "`123456789012345678`");
});

test("embed-only response clears content instead of duplicating the description", () => {
  const response = embedOnlyResponse(presentationEmbed("Result", "Completed", "success"));
  assert.equal(response.content, "");
  assert.equal(response.embeds.length, 1);
  assert.equal(response.embeds[0]?.data.description, "Completed");
});