import { db } from "../src/db.js";
import { processItems } from "../src/capture/process.js";

const pending = () =>
  (db.prepare("SELECT COUNT(*) c FROM items WHERE processed_at IS NULL").get() as { c: number }).c;

let total = 0;
let round = 0;
const started = Date.now();
while (pending() > 0 && round < 400) {
  round++;
  const n = await processItems();
  total += n;
  const left = pending();
  console.log(`round ${round}: +${n} (total ${total}) · pending ${left} · ${Math.round((Date.now() - started) / 1000)}s`);
  if (n === 0 && left > 0) {
    console.log("no progress; stopping");
    break;
  }
}
console.log(`done: processed ${total} items, ${pending()} left`);
