export interface Submission {
  player: string;
  score: number;
}

/** Highest scores first; the input keeps its original (submission) order. */
export function topN(submissions: Submission[], n: number): Submission[] {
  return [...submissions].sort((a, b) => b.score - a.score).slice(0, n);
}

export function firstSubmitter(submissions: Submission[]): string | undefined {
  return submissions[0]?.player;
}

export function rankOf(submissions: Submission[], player: string): number {
  return topN(submissions, submissions.length).findIndex((s) => s.player === player) + 1;
}
