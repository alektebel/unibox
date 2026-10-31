import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [url = "", token = ""] = process.argv.slice(2);
const target = path.join(root, "android-web", "config.js");

const clean = (v) => v.trim().replace(/\/+$/, "");
if (url && !/^https?:\/\//i.test(clean(url))) {
  console.error("usage: npm run app-server -- <https://server-url> [token]");
  process.exit(1);
}

fs.writeFileSync(
  target,
  `// Baked-in backend address for the Android app.\n` +
    `// Written by \`npm run app-server -- <url> <token>\`; empty means "ask on first launch".\n` +
    `window.UNIBOX_DEFAULT_SERVER = ${JSON.stringify(clean(url))};\n` +
    `window.UNIBOX_DEFAULT_TOKEN = ${JSON.stringify(token.trim())};\n`
);

console.log(
  url
    ? `baked server ${clean(url)}${token ? " (+ token)" : ""} into android-web/config.js`
    : "cleared baked server; the app will ask on first launch"
);
