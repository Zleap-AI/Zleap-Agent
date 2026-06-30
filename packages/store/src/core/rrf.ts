export type RrfContribution<T extends { id: string; createdAt: Date }> = {
  item: T;
  path: string;
  rank: number;
  rawScore?: number;
};

export type RrfMerged<T extends { id: string; createdAt: Date }> = {
  item: T;
  score: number;
  paths: string[];
  pathRanks: Record<string, number>;
  pathScores: Record<string, number>;
};

const DEFAULT_RRF_K = 60;

export function mergeRrfRankings<T extends { id: string; createdAt: Date }>(
  contributions: RrfContribution<T>[],
  k = DEFAULT_RRF_K,
): RrfMerged<T>[] {
  const byId = new Map<string, {
    item: T;
    paths: string[];
    pathRanks: Record<string, number>;
    pathScores: Record<string, number>;
  }>();

  for (const contribution of contributions) {
    const path = contribution.path.trim();
    if (!path) continue;
    const rank = normalizeRank(contribution.rank);
    let entry = byId.get(contribution.item.id);
    if (!entry) {
      entry = { item: contribution.item, paths: [], pathRanks: {}, pathScores: {} };
      byId.set(contribution.item.id, entry);
    }
    if (!(path in entry.pathRanks)) {
      entry.paths.push(path);
      entry.pathRanks[path] = rank;
    } else {
      entry.pathRanks[path] = Math.min(entry.pathRanks[path], rank);
    }
    if (typeof contribution.rawScore === 'number' && Number.isFinite(contribution.rawScore)) {
      entry.pathScores[path] = Math.max(entry.pathScores[path] ?? Number.NEGATIVE_INFINITY, contribution.rawScore);
    }
  }

  return [...byId.values()]
    .map((entry) => ({
      ...entry,
      score: Object.values(entry.pathRanks).reduce((sum, rank) => sum + 1 / (k + rank), 0),
    }))
    .sort((a, b) => b.score - a.score || b.item.createdAt.getTime() - a.item.createdAt.getTime());
}

function normalizeRank(rank: number): number {
  if (!Number.isFinite(rank)) return 1;
  return Math.max(1, Math.trunc(rank));
}
