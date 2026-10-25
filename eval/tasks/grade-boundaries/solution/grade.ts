export function letterGrade(score: number): string {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError(`invalid score: ${score}`);
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function gradeReport(scores: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(scores).map(([name, score]) => [name, letterGrade(score)]));
}
