import { toCents } from "./money.ts";

export interface Line {
  sku: string;
  price: number;
  quantity: number;
}

export function subtotalCents(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + toCents(line.price) * line.quantity, 0);
}
