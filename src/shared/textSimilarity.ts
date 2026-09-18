/**
 * Reusable string-similarity primitives shared by skill routing and the
 * paper-read section matcher. Pure functions only — no Zotero or IO.
 */

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

export function scoreTokenMatch(queryToken: string, targetToken: string): number {
  if (!queryToken || !targetToken) return 0;
  if (queryToken === targetToken) return 1;
  if (
    queryToken.length >= 4 &&
    targetToken.length >= 4 &&
    (queryToken.startsWith(targetToken) || targetToken.startsWith(queryToken))
  ) {
    return 0.9;
  }
  const maxLength = Math.max(queryToken.length, targetToken.length);
  if (maxLength >= 4 && levenshteinDistance(queryToken, targetToken) <= 1) {
    return 0.85;
  }
  return 0;
}
