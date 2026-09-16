/**
 * The automatic responder is intentionally a small, deterministic FAQ rather
 * than a general-purpose language model.  Keep entries explicit and require a
 * distinctive phrase (or a complete set of topic tokens) before answering.
 */

export interface FaqMatch {
  id: string;
  answer: string;
}

const questionOpeners = new Set([
  "are", "can", "could", "do", "does", "how", "is", "may", "should",
  "what", "when", "where", "which", "who", "why", "will", "would",
]);

export function normalizeFaqText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function looksLikeQuestion(input: string, normalized: string): boolean {
  const tokens = normalized.split(" ");
  if (tokens.length > 32) return false;
  if (/\b(?:not asking|dont ask|do not ask|stop asking)\b/.test(normalized)) return false;
  return input.includes("?") || questionOpeners.has(tokens[0] ?? "");
}

interface FaqEntry {
  id: string;
  phrases: string[];
  tokenSets: string[][];
  answer: string;
}

const faqEntries: FaqEntry[] = [
  {
    id: "ticket-order",
    phrases: ["ticket requests", "ticket request", "request a ticket", "order a uniform"],
    tokenSets: [["order", "uniform"], ["buy", "uniform"], ["purchase", "uniform"]],
    answer: "Order a uniform through the #ticket-requests channel.",
  },
  {
    id: "ticket-eligibility",
    phrases: ["ticket eligibility", "ticket request requirements", "eligible for a ticket", "request a uniform"],
    tokenSets: [["ticket", "eligible"], ["ticket", "requirements"], ["uniform", "requirements"]],
    answer:
      "To request a ticket, you must not be blacklisted, meet the uniform requirements, provide valid award evidence, and be a member of the relevant division (unless you are a veteran). Custom uniforms cost 50 Robux; full medals/backarts cost 75 Robux, and veterans cost 75 Robux. A late purchase may result in a blacklist.",
  },
  {
    id: "uniform-pricing",
    phrases: ["custom uniform cost", "custom uniform price", "full medals", "veteran uniform cost"],
    tokenSets: [["custom", "uniform", "cost"], ["medals", "backarts"], ["veteran", "uniform", "cost"]],
    answer:
      "Custom uniforms cost 50 Robux. Full medals/backarts cost 75 Robux, and veterans cost 75 Robux. A late purchase may result in a blacklist.",
  },
  {
    id: "become-quartermaster",
    phrases: ["become a quartermaster", "become quartermaster", "quartermaster academy"],
    tokenSets: [["join", "quartermaster", "academy"], ["become", "quartermaster"]],
    answer: "Become a Quartermaster through the Quartermaster Academy server.",
  },
  {
    id: "check-awards",
    phrases: ["check my awards", "check awards", "award evidence", "view my awards"],
    tokenSets: [["awards", "profile"], ["awards", "bot commands"], ["award", "evidence"]],
    answer: "Check awards in the main US Military 1940s server's #bot-commands channel with /profile.",
  },
  {
    id: "blue-pants",
    phrases: ["blue pants", "where are the pants", "pants links", "pants in the branch catalog"],
    tokenSets: [["pants", "catalog"], ["pants", "blue", "links"], ["pants", "branch", "catalog"]],
    answer: "The pants are blue links in the branch catalog.",
  },
  {
    id: "turnaround",
    phrases: ["uniform turnaround time", "how long does it take to receive my uniform", "when will my uniform be ready"],
    tokenSets: [["uniform", "turnaround"], ["uniform", "long", "take"], ["ticket", "uniform", "ready"]],
    answer: "The turnaround information is in the first message of your ticket.",
  },
  {
    id: "violations",
    phrases: ["report a violation", "report violations", "uniform violation"],
    tokenSets: [["violation", "evidence"], ["violations", "quartermaster", "officer"]],
    answer: "Report violations to a Quartermaster Officer and include evidence.",
  },
  {
    id: "post-purchase",
    phrases: ["uniform issue after purchase", "problem with my uniform after purchase"],
    tokenSets: [["uniform", "purchase", "issue"], ["uniform", "bought", "problem"]],
    answer: "For a post-purchase issue, contact the uploader.",
  },
  {
    id: "army-winter-class-a",
    phrases: ["army winter class a requirements", "who can wear winter class a"],
    tokenSets: [["army", "winter", "class", "a", "requirements"]],
    answer:
      "Army Winter Class A eligibility: enlisted Class A is for Sergeant through Master Sergeant; officer Class A is for Warrant Officer or above; the Sam Browne Belt officer variant is for Headquarters. It includes service bars, ribbons, badges, and rank/division-specific accessories. Full medals add 25 Robux.",
  },
  {
    id: "army-winter-military-police",
    phrases: ["military police winter class a requirements", "mp winter class a requirements"],
    tokenSets: [["military", "police", "winter", "class", "a"]],
    answer:
      "Military Police Winter Class A is for Military Police members who are Sergeant through Master Sergeant and Operation Staff or above for enlisted, or Warrant Officer or above and Operation Staff or above for officers. Full medals add 25 Robux.",
  },
  {
    id: "army-winter-class-b",
    phrases: ["army winter class b requirements", "who can wear winter class b"],
    tokenSets: [["army", "winter", "class", "b", "requirements"]],
    answer:
      "Army Winter Class B eligibility: enlisted is Sergeant through Master Sergeant; officer is Warrant Officer or above; the officer Class B with Ike Jacket is Second Lieutenant or above.",
  },
  {
    id: "army-winter-flight-jackets",
    phrases: ["winter bomber flight jacket requirements", "winter ike jacket requirements"],
    tokenSets: [["winter", "bomber", "flight", "jacket"], ["winter", "ike", "jacket"]],
    answer:
      "The Winter Bomber/Flight Jacket is for 8th Army Air Force members: Sergeant or above for enlisted and Warrant Officer or above for officers. The Winter Ike Jacket is for 1st Cavalry Division or Army Recruiting Command members: Private or above for enlisted and Second Lieutenant or above for officers.",
  },
  {
    id: "navy-winter-uniforms",
    phrases: ["navy winter uniform requirements", "navy service dress blues requirements", "navy gray working uniform requirements"],
    tokenSets: [["navy", "winter", "uniform", "requirements"], ["navy", "service", "dress", "blues", "requirements"]],
    answer:
      "Navy winter eligibility varies by uniform. Gray Working Uniform: Petty Officer Third Class+ enlisted, Chief Petty Officer+ chief, or Ensign+ for the officer coat variant. Service Dress Blues: Petty Officer Third Class–First Class enlisted, Chief Petty Officer for the chief variant, and Warrant Officer+ for officers. Navy overcoats require Brigadier General+.",
  },
  {
    id: "marine-winter-uniforms",
    phrases: ["marine winter uniform requirements", "marine service alpha requirements", "marine service bravo requirements", "marine dress blues requirements"],
    tokenSets: [["marine", "winter", "uniform", "requirements"], ["marine", "service", "alphas", "requirements"], ["marine", "service", "bravos", "requirements"]],
    answer:
      "Marine winter eligibility: Service Bravos require Sergeant+; Service Alphas require Sergeant+, with the Military Police variants also requiring Marine Corps Military Police membership. Marine Dress Blues require Sergeant+ in the Marine Corps Drill Team for enlisted or Warrant Officer+ for officers. Marine overcoats require Brigadier General+.",
  },
  {
    id: "veteran-uniforms",
    phrases: ["veteran uniform requirements", "veteran catalog requirements", "veteran uniform price", "how much is a veteran uniform"],
    tokenSets: [["veteran", "uniform", "requirements"], ["veteran", "uniform", "price"], ["veteran", "uniform", "much"]],
    answer:
      "Veterans may request a uniform without current division membership. Veteran uniforms cost 75 Robux. Use the veteran catalog for the rank requirements and seasonal pants links for the selected Army, Marine, or Navy variant.",
  },
];

function phraseMatches(normalized: string, phrase: string): boolean {
  const target = normalizeFaqText(phrase);
  return target.length > 0 && (` ${normalized} `).includes(` ${target} `);
}

function tokenSetMatches(tokens: Set<string>, tokenSet: string[]): boolean {
  return tokenSet.every((token) => tokens.has(token));
}

/**
 * Return a result only for an unambiguous, high-confidence entry.  A phrase
 * match outranks token matching; token matching requires every topic token.
 */
export function matchFaqQuestion(input: string): FaqMatch | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = normalizeFaqText(input);
  if (!normalized) return undefined;
  if (!looksLikeQuestion(input, normalized)) return undefined;
  const tokens = new Set(normalized.split(" "));
  const matches = faqEntries.flatMap((entry) => {
    const phrase = entry.phrases.some((candidate) => phraseMatches(normalized, candidate));
    const tokenSet = entry.tokenSets.some((candidate) => tokenSetMatches(tokens, candidate));
    return phrase || tokenSet ? [{ entry, score: phrase ? 3 : 2 }] : [];
  });
  if (!matches.length) return undefined;
  const highest = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === highest);
  if (best.length !== 1) return undefined;
  return { id: best[0]!.entry.id, answer: best[0]!.entry.answer };
}

export function answerFaq(input: string): string | undefined {
  return matchFaqQuestion(input)?.answer;
}

export interface FaqReplyAttempt {
  guildId: string;
  channelId: string;
  userId: string;
  faqId: string;
}

/** In-memory spam guard. Restarts safely clear cooldowns but never stored settings. */
export class FaqReplyLimiter {
  private readonly lastByChannel = new Map<string, number>();
  private readonly lastByUser = new Map<string, number>();
  private readonly lastFaqByChannel = new Map<string, number>();

  claim(attempt: FaqReplyAttempt, now = Date.now()): boolean {
    const channelKey = `${attempt.guildId}:${attempt.channelId}`;
    const userKey = `${attempt.guildId}:${attempt.userId}`;
    const faqKey = `${channelKey}:${attempt.faqId}`;
    if (
      now - (this.lastByChannel.get(channelKey) ?? -Infinity) < 15_000 ||
      now - (this.lastByUser.get(userKey) ?? -Infinity) < 60_000 ||
      now - (this.lastFaqByChannel.get(faqKey) ?? -Infinity) < 120_000
    ) {
      return false;
    }
    this.lastByChannel.set(channelKey, now);
    this.lastByUser.set(userKey, now);
    this.lastFaqByChannel.set(faqKey, now);
    return true;
  }
}

// Small aliases make the pure module convenient for callers and focused tests.
export const normalizeQuestion = normalizeFaqText;
export const matchFaq = matchFaqQuestion;
export const getFaqAnswer = answerFaq;