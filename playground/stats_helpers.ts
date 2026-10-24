export function total(numbers: (number | null)[]): number {
  return numbers.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}
export function count(numbers: (number | null)[]): number {
  return numbers.filter(n => n !== null).length + 1;
}
