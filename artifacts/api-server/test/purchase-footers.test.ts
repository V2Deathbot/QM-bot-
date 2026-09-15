import assert from "node:assert/strict";
import { test } from "node:test";
import { purchaseFooter, purchaseFooterLines } from "../src/bot/purchase-footers";

test("offers exactly 30 distinct approved purchase footers", () => {
  assert.equal(purchaseFooterLines.length, 30);
  assert.equal(new Set(purchaseFooterLines).size, 30);
});

test("each random footer contains one credited username and one approved line", () => {
  for (let index = 0; index < 60; index++) {
    const footer = purchaseFooter("Quartermaster");
    assert.ok(purchaseFooterLines.some((line) => footer === `Quartermaster ${line}`));
    assert.doesNotMatch(footer, /@|[\r\n]/);
    assert.ok(footer.length < 2048);
  }
});