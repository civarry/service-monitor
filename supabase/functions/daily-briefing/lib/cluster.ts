export interface ClusterableItem {
  id: string;
  embedding: number[];
  category: string;
}

export interface Cluster {
  id: string;
  centroid: number[];
  itemIds: string[];
  category: string;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosine(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function updateCentroid(c: Cluster, newVec: number[]): void {
  const n = c.itemIds.length;
  for (let i = 0; i < c.centroid.length; i++) {
    c.centroid[i] = (c.centroid[i] * n + newVec[i]) / (n + 1);
  }
}

export function clusterByThreshold(
  items: ClusterableItem[],
  threshold = 0.82
): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    let best: Cluster | null = null;
    let bestSim = -Infinity;
    for (const c of clusters) {
      if (c.category !== item.category) continue;
      const sim = cosine(c.centroid, item.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= threshold) {
      updateCentroid(best, item.embedding);
      best.itemIds.push(item.id);
    } else {
      clusters.push({
        id: crypto.randomUUID(),
        centroid: [...item.embedding],
        itemIds: [item.id],
        category: item.category,
      });
    }
  }
  return clusters;
}
