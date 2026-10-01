export interface ProductCandidate { title: string; url: string; imageUrl?: string; price?: string; }

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function similarity(query: string, candidate: string): number {
  const expected = new Set(normalize(query).split(" ").filter(Boolean));
  const actual = new Set(normalize(candidate).split(" ").filter(Boolean));
  const intersection = [...expected].filter((word) => actual.has(word)).length;
  const union = new Set([...expected, ...actual]).size;
  return union ? intersection / union : 0;
}

export function findBestProduct(query: string, candidates: ProductCandidate[], threshold: number): ProductCandidate {
  const ranked = candidates.map((candidate) => ({ candidate, score: similarity(query, candidate.title) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < threshold) throw new Error(`Nenhum produto atingiu similaridade minima de ${threshold}. Melhor resultado: ${best ? `${best.candidate.title} (${best.score.toFixed(2)})` : "nenhum"}`);
  return best.candidate;
}
