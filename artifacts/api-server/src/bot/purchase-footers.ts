import { randomInt } from "node:crypto";
import { safePresentationText } from "./presentation";

export const purchaseFooterLines = [
  "tried to take a bite of your tie.",
  "ironed this uniform with sheer determination.",
  "checked your pockets. Sadly, no snacks.",
  "fought a sewing machine and narrowly won.",
  "promises those buttons are mostly decorative.",
  "briefly considered adding a cape.",
  "saluted your uniform before packing it.",
  "used a ruler. At least once.",
  "personally interrogated every loose thread.",
  "recommends keeping this uniform away from soup.",
  "tried it on. We made them give it back.",
  "folded this so neatly it became a classified document.",
  "has declared your collar fit for duty.",
  "spent twenty minutes arguing with a sleeve.",
  "would like you to know the wrinkles are not included.",
  "inspected the stitching with suspicious enthusiasm.",
  "accidentally promoted your tie.",
  "resisted the urge to add seventeen extra pockets.",
  "polished the buttons until they could see their regrets.",
  "says this uniform pairs nicely with showing up on time.",
  "has asked you not to challenge the washing machine.",
  "measured twice and panicked three times.",
  "attempted to expense this uniform as a business lunch.",
  "packed extra confidence into the left pocket.",
  "assures you the mannequin was paid fairly.",
  "lost a staring contest with your collar.",
  "gave the final stitch a motivational speech.",
  "says running faster will not improve the stitching.",
  "considered signing the uniform, but ran out of crayons.",
  "is already taking credit for how good you look.",
] as const;

export function purchaseFooter(username: string): string {
  return `${safePresentationText(username, 200)} ${purchaseFooterLines[randomInt(purchaseFooterLines.length)]}`;
}