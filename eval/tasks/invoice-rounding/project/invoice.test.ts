import test from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal } from "./invoice.ts";

test("three items at 0.29", () => assert.equal(invoiceTotal([{ sku: "pen", price: 0.29, quantity: 3 }], 0), "0.87"));
test("single item at 1.15", () => assert.equal(invoiceTotal([{ sku: "cap", price: 1.15, quantity: 1 }], 0), "1.15"));
test("tax is rounded to the nearest cent", () => {
  assert.equal(invoiceTotal([{ sku: "book", price: 19.99, quantity: 1 }, { sku: "pen", price: 0.29, quantity: 3 }], 0.1), "22.95");
});
test("empty invoice", () => assert.equal(invoiceTotal([], 0.2), "0.00"));
test("whole amounts", () => assert.equal(invoiceTotal([{ sku: "mug", price: 8, quantity: 2 }], 0.25), "20.00"));
