import crypto from "node:crypto";
import http from "node:http";
import { getMeta, setMeta } from "./db.js";
import { config } from "./config.js";

// The guardian: someone else chooses the code that uninstalling Unibox or switching off its
// protection asks for. They get a one-time link, type a code twice, and only its fingerprint is
// kept. A new link needs the current code, so the owner can't reset it alone.

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The current code's fingerprint: the guardian's if they set one, else the one set on the server. */
export function guardHash(): string {
  return getMeta("guard_hash") || config.guardHash;
}

/** A fresh one-time link. With a code already set, only its holder can ask for one. */
export function newLink(code: string | undefined, base: string): string | null {
  const current = guardHash();
  if (current && sha(String(code ?? "")) !== current) return null;
  const token = crypto.randomBytes(24).toString("hex");
  setMeta("guard_link", sha(token));
  return `${base.replace(/\/+$/, "")}/guardian/${token}`;
}

const page = (body: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Código de guardián</title><style>
body{margin:0;background:#F4F3EE;color:#1E2620;font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:380px;padding:28px}h1{font-size:26px;line-height:1.2;margin:8px 0 12px}.k{font:12px monospace;letter-spacing:.16em;color:#3F6B4C}
p{color:#6B6F68}input{width:100%;box-sizing:border-box;font-size:22px;padding:12px 14px;border:1px solid #DCDAD2;border-radius:14px;margin:8px 0;letter-spacing:.2em}
button{width:100%;font-size:16px;padding:14px;border:0;border-radius:14px;background:#2A3A2E;color:#F4F3EE;margin-top:12px}.e{color:#A03A2C}
@media (prefers-color-scheme:dark){body{background:#161B17;color:#E9E8E2}input{background:#1E2620;color:#E9E8E2;border-color:#3A443C}}
</style></head><body><main>${body}</main></body></html>`;

/** GET shows the form, POST sets the code. Public (the link itself is the secret), one use. */
export async function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
  const send = (status: number, body: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(page(body)); };
  const valid = !!getMeta("guard_link") && sha(token) === getMeta("guard_link");
  if (!valid) return send(410, `<div class="k">CÓDIGO DE GUARDIÁN</div><h1>Este enlace ya no vale.</h1><p>Ya se usó o se pidió otro.</p>`);
  const form = (err = "") => `<div class="k">CÓDIGO DE GUARDIÁN</div><h1>Elige un código para proteger el móvil de alguien.</h1>
    <p>Sin él no podrá desinstalar su app de concentración ni quitarle la protección. Guárdalo tú; no se lo des salvo que de verdad lo necesite. Nadie sabrá que lo pusiste tú.</p>
    ${err ? `<p class="e">${err}</p>` : ""}
    <form method="post"><input name="code" type="password" inputmode="numeric" pattern="[0-9]{6,12}" placeholder="6 a 12 cifras" required autocomplete="off">
    <input name="code2" type="password" inputmode="numeric" pattern="[0-9]{6,12}" placeholder="Repítelo" required autocomplete="off"><button>Guardar el código</button></form>`;
  if (req.method !== "POST") return send(200, form());
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const f = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const code = String(f.get("code") ?? ""), code2 = String(f.get("code2") ?? "");
  if (!/^\d{6,12}$/.test(code)) return send(400, form("Tienen que ser de 6 a 12 cifras."));
  if (code !== code2) return send(400, form("No coinciden."));
  setMeta("guard_hash", sha(code));
  setMeta("guard_link", "");
  send(200, `<div class="k">CÓDIGO DE GUARDIÁN</div><h1>Listo.</h1><p>El código está puesto. Este enlace ya no sirve. Guárdalo bien.</p>`);
}
