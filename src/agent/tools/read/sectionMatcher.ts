import {
  levenshteinDistance,
  scoreTokenMatch,
} from "../../../shared/textSimilarity";

/**
 * Matches user-typed section names ("related work", "3.2 Ablation Study")
 * against the section labels carried by paper chunks. Pure functions — no
 * Zotero or IO — so matching quality is unit-testable in isolation.
 */

export type SectionNameMatch = {
  candidate: string;
  score: number;
};

const SECTION_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "of",
  "the",
  "for",
  "in",
  "on",
  "to",
  "with",
]);

export function normalizeSectionName(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/^\s*\d+(?:\.\d+)*\s*/, "")
    .replace(/[`'"’:.;\-–—()]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function meaningfulTokens(normalized: string): string[] {
  return normalized
    .split(" ")
    .filter((token) => token && !SECTION_TOKEN_STOPWORDS.has(token));
}

function tokenContainmentScore(
  requestedTokens: string[],
  candidateTokens: string[],
): number | null {
  if (!requestedTokens.length || !candidateTokens.length) return null;
  const candidateSet = new Set(candidateTokens);
  if (requestedTokens.every((token) => candidateSet.has(token))) return 0.9;
  const requestedSet = new Set(requestedTokens);
  if (candidateTokens.every((token) => requestedSet.has(token))) return 0.85;
  return null;
}

function fuzzyTokenScore(
  requestedTokens: string[],
  candidateTokens: string[],
): number | null {
  if (!requestedTokens.length || !candidateTokens.length) return null;
  let matched = 0;
  for (const requestedToken of requestedTokens) {
    const best = candidateTokens.reduce(
      (score, candidateToken) =>
        Math.max(score, scoreTokenMatch(requestedToken, candidateToken)),
      0,
    );
    if (best >= 0.85) {
      matched += 1;
    }
  }
  // Morphological drift ("experimental" vs "experiments") means one requested
  // token can fail exact/prefix/edit-distance matching while the rest of the
  // name clearly identifies the section, so a majority of strongly matched
  // tokens is enough.
  const matchedFraction = matched / requestedTokens.length;
  return matchedFraction >= 0.5 ? 0.75 : null;
}

export function matchSectionName(
  requested: string,
  candidates: string[],
): SectionNameMatch | null {
  const requestedNormalized = normalizeSectionName(requested);
  if (!requestedNormalized) return null;
  const requestedTokens = meaningfulTokens(requestedNormalized);
  let best: SectionNameMatch | null = null;
  for (const candidate of candidates) {
    const candidateNormalized = normalizeSectionName(candidate);
    if (!candidateNormalized) continue;
    let score: number | null = null;
    if (candidateNormalized === requestedNormalized) {
      score = 1;
    } else {
      const candidateTokens = meaningfulTokens(candidateNormalized);
      score =
        tokenContainmentScore(requestedTokens, candidateTokens) ??
        fuzzyTokenScore(requestedTokens, candidateTokens);
    }
    if (score !== null && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }
  return best;
}

export function suggestSections(
  requested: string,
  candidates: string[],
  limit = 3,
): string[] {
  const requestedNormalized = normalizeSectionName(requested);
  if (!requestedNormalized) return [];
  return candidates
    .map((candidate) => {
      const candidateNormalized = normalizeSectionName(candidate);
      const distance = levenshteinDistance(
        requestedNormalized,
        candidateNormalized,
      );
      return { candidate, distance };
    })
    .filter((entry) => entry.distance <= 25)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
