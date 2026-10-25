import { subtotalCents, type Line } from "./cart.ts";
import { formatCents } from "./money.ts";

export function invoiceTotal(lines: Line[], taxRate: number): string {
  const subtotal = subtotalCents(lines);
  const tax = Math.round(subtotal * taxRate);
  return formatCents(subtotal + tax);
}
