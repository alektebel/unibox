import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDue, isExpired, dueLabel } from "../src/deadline.js";

const at = (s: string) => new Date(s).getTime();
const ymd = (ts: number | null) => {
  assert.ok(ts != null);
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

test("English month-day after a deadline word", () => {
  assert.equal(ymd(parseDue("Complete UAM graduation form before September 25", at("2026-09-10"))), "2026-9-25");
  assert.equal(ymd(parseDue("Pay rent by Sept 1st", at("2026-08-20"))), "2026-9-1");
});

test("Spanish day-month, with and without year", () => {
  assert.equal(ymd(parseDue("Renovar DNI antes del 3 de noviembre", at("2026-10-01"))), "2026-11-3");
  assert.equal(ymd(parseDue("Entregar TFM el 15 de enero de 2027", at("2026-10-01"))), "2027-1-15");
});

test("a month already well past rolls to next year", () => {
  assert.equal(ymd(parseDue("Examen AWS antes del 10 de marzo", at("2026-11-20"))), "2027-3-10");
});

test("a recent past date stays in this year, so it reads as expired", () => {
  const due = parseDue("Complete form before September 25", at("2026-10-05"));
  assert.equal(ymd(due), "2026-9-25");
  assert.ok(isExpired(due, at("2026-10-20")));
});

test("numeric dates need a deadline word", () => {
  assert.equal(ymd(parseDue("Enviar factura antes del 30/11", at("2026-10-01"))), "2026-11-30");
  assert.equal(parseDue("Leer capítulo 3/4 del libro", at("2026-10-01")), null);
});

test("no date, nonsense dates", () => {
  assert.equal(parseDue("Leer sobre Rust async", at("2026-10-01")), null);
  assert.equal(parseDue("before September 45", at("2026-10-01")), null);
  assert.equal(parseDue("", at("2026-10-01")), null);
});

test("words that merely contain a month name don't count", () => {
  assert.equal(parseDue("Comprar 2 mayonesas", at("2026-10-01")), null);
  assert.equal(parseDue("Watch 3 decks on marketing", at("2026-10-01")), null);
});

test("the due day itself is not expired until it ends", () => {
  const due = parseDue("before October 20", at("2026-10-01"));
  assert.ok(!isExpired(due, at("2026-10-20T18:00:00")));
  assert.equal(dueLabel(due!), "20/10");
});
