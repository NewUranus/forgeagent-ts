import { total, count } from "./stats_helpers.ts";
export function average(numbers: (number | null)[]): number {
  const c = count(numbers);
  return c === 0 ? 0 : total(numbers) / c;
}
