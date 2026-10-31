import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { addItems, archiveAll, restoreArchive, archivedCount } from "../src/slate.js";

const active = () => (db.prepare("SELECT COUNT(*) n FROM items WHERE state = 'active'").get() as any).n;

test("clean slate archives everything open, keeps it, and brings it back", () => {
  addItems([{ title: "Old thing A" }, { title: "Old thing B", action: "read" }]);
  const before = active();
  assert.ok(before >= 2);
  assert.equal(archiveAll(), before);
  assert.equal(active(), 0);
  assert.equal(archivedCount(), before);
  addItems([{ title: "Leer cap. 3", action: "read", effort: 45, priority: 75 }, { title: "Ya leído", done: true }]);
  assert.equal(active(), 1);
  assert.equal(restoreArchive(), before);
  assert.equal(active(), before + 1);
});

test("adding the same to-do twice keeps one", () => {
  const a = addItems([{ title: "Anotar cita de Adeslas", url: "" }]);
  const b = addItems([{ title: "Anotar cita de Adeslas", url: "" }]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
});

test("a goal made of to-dos moves as they get done, with no fixed session block", async () => {
  const { createGoal, mobilePayload } = await import("../src/mobile.js");
  const { itemGoal } = await import("../src/slate.js");
  const id = createGoal({ name: "Semana A-track", due: "2099-01-01", steps: [{ when: "MIÉ", what: "A5" }] });
  const ids = addItems([{ title: "A5 etapa 1", goal: id }, { title: "A5 etapa 2", goal: id }]);
  assert.ok(itemGoal(id));
  db.prepare("UPDATE items SET state = 'done' WHERE id = ?").run(ids[0]);
  const g = (mobilePayload() as any).metas.goals.find((x: any) => x.id === id);
  assert.equal(g.pct, "50%");
  assert.match(g.meta, /1 de 2 hechas/);
});

test("a WhatsApp export: a link and the line about it are one thing; notes say what they ask for", async () => {
  const { parseWhatsappExport, groupBursts, looksLikeExport } = await import("../src/sources/whatsapp-export.js");
  const { byWords } = await import("../src/capture/process.js");
  const txt = [
    "24/10/26, 9:12 - Ana: https://martinfowler.com/articles/patterns-of-distributed-systems/",
    "24/10/26, 9:13 - Ana: leer esto con calma, sobre consenso",
    "24/10/26, 13:40 - Ana: Comprar bombillas para el salón",
  ].join("\n");
  assert.ok(looksLikeExport(txt));
  const bursts = groupBursts(parseWhatsappExport(txt));
  assert.equal(bursts.length, 2);
  assert.equal(bursts[0].length, 2, "link + its note");
  assert.equal(byWords("ver charla de Kleppmann https://www.youtube.com/watch?v=x", null).action, "watch");
  assert.equal(byWords("Comprar bombillas para el salón", null).action, "buy");
  assert.equal(byWords("Llamar a Pablo para lo del piso", null).context, "phone");
  assert.equal(byWords("leer el post de Mastra", null).action, "read");
});

test("a zip is read back entry by entry", async () => {
  const { unzip } = await import("../src/sources/zip.js");
  const zlib = await import("node:zlib");
  // one deflated entry, built by hand: local header + data + central directory + end record
  const name = Buffer.from("_chat.txt"), data = Buffer.from("24/10/26, 9:12 - Ana: hola"), comp = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdStart = 30 + name.length + comp.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(cdStart, 16);
  const zip = Buffer.concat([local, name, comp, central, name, end]);
  const [e] = unzip(zip);
  assert.equal(e.name, "_chat.txt");
  assert.equal(e.data.toString(), data.toString());
});
