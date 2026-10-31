import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { llm } from "./llm.js";
import { startChat, addTurn, turns, chatExists } from "./chats.js";
import { target, applyOutcome, localDate, ensurePlan, spots, schedule, upcoming, whenLabel, freeHours, whoseTurn, outdated, type Outcome } from "./planner.js";
import { addItems } from "./slate.js";
import { workHoursFor } from "./presence.js";
import { recentExits } from "./policy.js";
import { entry as journalEntry } from "./journal.js";

// One conversation with the AI, kept whole. It asks how each planned thing went when its
// time ends (the phone notifies you), and from a set hour it goes over the day: what's done,
// what's left, one question to do better tomorrow, and tomorrow's plan. You answer in your
// own words; one message can close several things.

const DAY = 86_400_000;

export function thread(): number {
  const id = Number(getMeta("assistant_chat") ?? 0);
  if (id && chatExists(id, "assistant")) return id;
  const fresh = startChat("assistant");
  setMeta("assistant_chat", String(fresh));
  return fresh;
}

const isReading = (a: string | null) => a === "read" || a === "watch" || a === "listen";

function question(title: string, action: string | null): string {
  return `¿Cómo ha ido «${title}»? ${isReading(action) ? "Cuéntame qué has sacado" : "Cuéntame qué has hecho"}, o si no ha podido ser.`;
}

/** Ended slots the AI hasn't asked about yet get their question in the conversation. */
export function syncQuestions(): number {
  const slots = db.prepare("SELECT id, title, action, end FROM plan_slots WHERE status = 'asking' ORDER BY end").all() as any[];
  let n = 0;
  for (const s of slots) {
    if (getMeta(`asked:${s.id}`)) continue;
    // "espera a que las termine": what ends while you asked for quiet is asked at the evening review instead
    if (s.end < Number(getMeta("assistant_quiet_until") ?? 0)) continue;
    addTurn(thread(), "assistant", question(s.title, s.action), { about: { slotId: s.id } });
    setMeta(`asked:${s.id}`, String(Date.now()));
    n++;
  }
  return n;
}

/** Things the AI is waiting to hear about. */
export function pending(): { slotId: number; title: string }[] {
  return (db.prepare("SELECT id, title FROM plan_slots WHERE status = 'asking' ORDER BY end").all() as any[])
    .map((s) => ({ slotId: s.id, title: s.title }));
}

/** You tapped something: the AI asks about it in the conversation. */
export function askAbout(slotId: number | null, ref: string | null): void {
  const t = target(slotId, ref);
  addTurn(thread(), "assistant", question(t.title, t.action), { about: slotId ? { slotId } : { ref } });
}

export function wrapAt(day: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(config.wrapAt) ?? ["", "21", "00"];
  const d = new Date(day);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

let wrapping = false;

/** From the set hour on, once a day: the AI goes over the day with you. */
export async function maybeWrapUp(now = Date.now()): Promise<boolean> {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const date = localDate(now);
  if (wrapping || now < wrapAt(day.getTime()) || getMeta(`wrap:${date}`)) return false;
  const today = db.prepare("SELECT * FROM plan_slots WHERE date = ? AND status != 'moved' ORDER BY start").all(date) as any[];
  if (!today.length) return false;
  wrapping = true;
  setMeta(`wrap:${date}`, String(now));
  try {
    ensurePlan(now);
    const done = today.filter((s) => s.status === "done");
    const open = today.filter((s) => s.status === "asking" || s.status === "planned" || s.status === "missed");
    const tomorrow = db.prepare("SELECT title, start FROM plan_slots WHERE date = ? AND status = 'planned' ORDER BY start").all(localDate(now + DAY)) as any[];
    const facts = [
      `Hecho hoy: ${done.map((s) => s.title).join("; ") || "nada todavía"}.`,
      `Sin contar aún: ${open.map((s) => s.title).join("; ") || "nada"}.`,
      `Plan de mañana: ${tomorrow.map((s) => `${hhmm(s.start)} ${s.title}`).join("; ") || "aún sin plan"}.`,
      // what the phone saw: passes through a block (with his reason) and what it stopped on its own
      // what he wrote yesterday, so the review can follow up on it
      `Su diario de ayer: ${journalEntry(localDate(now - DAY))?.text.slice(0, 600) || "no escribió"}.`,
      `Lo que te ha dicho hoy: ${turns(thread()).filter((t) => t.role === "user" && t.at >= day.getTime()).map((t) => `«${t.content.slice(0, 160)}»`).join(" ") || "nada"}.`,
      `El móvil hoy: ${recentExits(day.getTime()).map((e) => `${hhmm(e.at)} ${e.pkg.split(".").slice(-2).join(".")}: «${e.reason}»`).join("; ") || "nada"}.`,
    ].join("\n");
    let text = "";
    try {
      text = await llm(
        [
          {
            role: "system",
            content:
              `Eres Unibox y repasas el día con ${config.meFirst || "el usuario"}, como un compañero que le ayuda con sus metas. Un único mensaje en español, directo y cercano, sin emojis, de 3 a 6 líneas. ` +
              `Si hizo algo, reconócelo en una frase concreta. Si no hizo nada, no lo repitas como reproche ni digas "no has avanzado nada": si en la conversación de hoy dio un motivo (trabajo, un cumpleaños…), ` +
              `tenlo en cuenta y propón ajustar el plan a su tiempo real (por ejemplo, menos cosas o pasarlas a la tarde o al fin de semana). ` +
              `Pregunta en una sola frase por lo que falta, que lo cuente todo junto. ` +
              `Si su diario de ayer decía algo que hacer distinto, mira si lo ha hecho. Si el móvil registra saltos de bloqueo o bloqueos automáticos, nómbralo en una frase sin sermonear; si no hay, no hables del móvil. ` +
              `No hagas preguntas genéricas sobre cómo se siente ni sobre obstáculos si ya los dijo. Enseña el plan de mañana en una línea por cosa con su hora, y cierra recordándole el diario en una frase corta. ` +
              `No inventes nada que no esté en los datos.`,
          },
          { role: "user", content: facts },
        ],
        { temperature: 0.5 }
      );
    } catch {
      text = [
        done.length ? `Hoy has cerrado ${done.length === 1 ? "una cosa" : `${done.length} cosas`}: ${done.map((s) => s.title).join(", ")}.` : "Repasamos el día.",
        open.length ? `Me falta saber cómo ha ido: ${open.map((s) => s.title).join(", ")}. Cuéntamelo todo junto, como quieras.` : "",
        "¿Qué te ha frenado hoy, si algo?",
        tomorrow.length ? `Mañana:\n${tomorrow.map((s) => `${hhmm(s.start)} ${s.title}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");
    }
    addTurn(thread(), "assistant", text.trim().slice(0, 1500), { wrap: date });
    return true;
  } finally {
    wrapping = false;
  }
}

/** What's open to talk about: asked-about slots, today's plan still ahead, and what you tapped. */
function openThings(now: number): { id: string; title: string; action: string | null }[] {
  const out: { id: string; title: string; action: string | null }[] = [];
  for (const s of db.prepare(
    // only what has started: "no he leído nada" is about the past, not what's planned for later
    "SELECT id, title, action FROM plan_slots WHERE (status = 'asking') OR (status = 'planned' AND date = ? AND start <= ?) ORDER BY start"
  ).all(localDate(now), now) as any[]) out.push({ id: `s:${s.id}`, title: s.title, action: s.action });
  // what the AI asked about from a tap: a slot still to come, or something unplanned
  for (const t of turns(thread()).slice(-6)) {
    const about = t.role === "assistant" ? t.data?.about : null;
    if (about?.slotId && !out.some((o) => o.id === `s:${about.slotId}`)) {
      try { const x = target(Number(about.slotId), null); if (x.slot?.status === "planned" || x.slot?.status === "asking") out.push({ id: `s:${about.slotId}`, title: x.title, action: x.action }); } catch {}
    }
    const ref = about?.ref;
    if (!ref || out.some((o) => o.id === `r:${ref}`)) continue;
    try { const x = target(null, ref); out.push({ id: `r:${ref}`, title: x.title, action: x.action }); } catch {}
  }
  return out;
}

/** Open to-dos the chat can talk about: re-prioritise, give a time (id r:<item>). */
function backlog(limit = 45): { id: string; title: string; priority: number; action: string; minutes: number }[] {
  return (db.prepare(
    "SELECT id, title, raw, priority, action, effort_min, created_at, tags, priority_set FROM items WHERE state IN ('active', 'inbox') AND processed_at IS NOT NULL ORDER BY priority DESC LIMIT ?"
  ).all(limit * 2) as any[]).filter((r) => !outdated(r, Date.now())).slice(0, limit).map((r) => ({
    id: `r:${r.id}`, title: String(r.title || r.raw || "").slice(0, 100), priority: Math.round((r.priority ?? 0) * 100) / 100, action: r.action ?? "do", minutes: r.effort_min ?? 15,
  }));
}

const ACTIONS = ["do", "reply", "read", "watch", "listen", "buy"];

interface Change { type: "add" | "priority" | "schedule" | "free" | "event"; hours?: number; start?: string; end?: string; day?: string; id?: string; name?: string; title?: string; action?: string; context?: string; minutes?: number; priority?: number; spot?: number | null }

const CONTEXTS = ["desk", "home", "phone", "errand", "anywhere"];

/** Carry out what the chat decided to change; each change says in one line what happened. */
function applyChanges(changes: Change[], freeSpots: ReturnType<typeof spots>, now: number): string[] {
  const said: string[] = [];
  let replan = false;
  let events = 0;
  // a stage whose turn hasn't come isn't scheduled (the goal's order holds here too)
  const turn = whoseTurn();
  const place = (ref: string, spot: number | null | undefined) => {
    if (!turn(ref)) return null;
    const s = spot != null ? freeSpots[spot] : undefined;
    return schedule(ref, now, s ? { from: s.start, to: s.end } : undefined) ?? (s ? schedule(ref, now) : null);
  };
  const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  // the ids look alike (stage 2 vs 3): when the model names the thing, the name decides
  const resolve = (c: Change): string | null => {
    const byId = c.id?.startsWith("r:") ? c.id.slice(2) : null;
    if (!c.name) return byId;
    const want = norm(c.name);
    const rows = db.prepare("SELECT id, title, raw FROM items WHERE state IN ('active', 'inbox')").all() as any[];
    const title = (r: any) => norm(r.title || r.raw || "");
    const exact = rows.find((r) => title(r) === want) ?? rows.find((r) => title(r).startsWith(want));
    if (exact) return exact.id;
    const some = rows.filter((r) => title(r).includes(want));
    return some.length === 1 ? some[0].id : byId;
  };
  for (const c of changes.slice(0, 10)) {
    try {
      if (c.type === "add" && c.title) {
        const priority = Math.max(0, Math.min(100, Number(c.priority ?? 60)));
        // already on the list: that one gets the time, not a copy
        const had = (db.prepare("SELECT id, title, raw FROM items WHERE state IN ('active', 'inbox')").all() as any[])
          .find((r) => norm(r.title || r.raw || "") === norm(c.title!))?.id;
        if (had) {
          const slot = place(had, c.spot);
          const it = db.prepare("SELECT title, raw FROM items WHERE id = ?").get(had) as any;
          said.push(`Ya la tenías: «${it.title || it.raw}»${slot ? `, la pongo ${whenLabel(slot.start, now)}` : ""}.`);
          continue;
        }
        const [ref] = addItems([{
          title: c.title.slice(0, 200), action: ACTIONS.includes(c.action ?? "") ? c.action : "do",
          effort: Math.max(5, Math.min(480, Number(c.minutes) || 30)), priority, context: CONTEXTS.includes(c.context ?? "") ? c.context : "", source: "chat",
        }]);
        if (!ref) continue;
        const slot = place(ref, c.spot);
        said.push(`Apuntada «${c.title}» (prioridad ${priority})${slot ? `: ${whenLabel(slot.start, now)}` : "; esta semana no le encuentro hueco"}.`);
      } else if (c.type === "priority") {
        const ref = resolve(c);
        if (!ref) continue;
        const it = db.prepare("SELECT title, raw FROM items WHERE id = ?").get(ref) as any;
        if (!it) continue;
        const priority = Math.round(Math.max(0, Math.min(100, Number(c.priority))) * 100) / 100;
        if (!Number.isFinite(priority)) continue;
        db.prepare("UPDATE items SET priority = ?, priority_set = ? WHERE id = ?").run(priority, priority, ref);
        replan = true;
        const slot = c.spot != null ? place(ref, c.spot) : null;
        said.push(`«${it.title || it.raw}» pasa a prioridad ${priority}${slot ? `, y la pongo ${whenLabel(slot.start, now)}` : ""}.`);
      } else if (c.type === "event" && c.title) {
        // something in his day with a time: it's busy, the plan goes around it
        const at = (hhmm?: string) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
          if (!m) return null;
          const d = new Date(now);
          if (c.day === "mañana") d.setDate(d.getDate() + 1);
          else if (/^\d{4}-\d{2}-\d{2}$/.test(String(c.day ?? ""))) { const [y, mo, da] = String(c.day).split("-").map(Number); d.setFullYear(y, mo - 1, da); }
          d.setHours(Number(m[1]), Number(m[2]), 0, 0);
          return d.getTime();
        };
        const start = at(c.start);
        if (start == null) continue;
        const end = Math.max(start + 15 * 60_000, at(c.end) ?? start + 60 * 60_000);
        db.prepare("INSERT OR IGNORE INTO commitments (source, ref, title, start, end, location, created_at) VALUES ('chat', ?, ?, ?, ?, NULL, ?)")
          .run(`chat:${String(c.title).slice(0, 60)}`, String(c.title).slice(0, 120), start, end, now);
        events++;
        said.push(`Apuntado: ${c.day === "mañana" ? "mañana " : ""}${new Date(start).toTimeString().slice(0, 5)}–${new Date(end).toTimeString().slice(0, 5)} ${c.title}.`);
      } else if (c.type === "free") {
        const hours = Number(c.hours);
        if (!Number.isFinite(hours) || hours <= 0) continue;
        const r = freeHours(hours, now);
        said.push(`Libre hasta las ${new Date(r.end).toTimeString().slice(0, 5)}.${r.moved.length ? ` Quito del plan: ${r.moved.map((t) => `«${t}»`).join(", ")}; lo recoloco después.` : ""} No te pregunto nada hasta entonces.`);
      } else if (c.type === "schedule") {
        const ref = resolve(c);
        if (!ref) continue;
        const slot = place(ref, c.spot);
        if (slot) said.push(`«${slot.title}»: ${whenLabel(slot.start, now)}.`);
      }
    } catch (e) {
      console.warn("[assistant] change failed:", e instanceof Error ? e.message : e);
    }
  }
  // new priorities or new appointments change what today holds (pinned and done slots stay)
  if (replan || events) ensurePlan(now, true);
  return said;
}

/** Sentences end at . ! ? followed by a space or the end: "rate_limiter.py" is one word, and "cap. 5" isn't an ending. */
function sentences(text: string): string[] {
  return text.match(/.+?(?:(?<!\b(?:cap|caps|p[aá]g|etc|ej|aprox|n[uú]m|min|vs|Sr|Sra))[.!?]+(?=\s|$)|$)\s*/g) ?? [];
}

/** Where things went is said by the lines the system adds; the model's own guesses at times (often wrong) and "¿te parece bien?" go. */
export function withoutTimes(text: string): string {
  return sentences(text)
    .filter((s) => !/\d{1,2}[:.]\d{2}|\bhueco\b|¿\s*(te (parece|encaja|va|viene)|prefieres|quieres que)/i.test(s))
    .join("").trim();
}

const AT_WORK = /\b(estoy trabajando|estoy en el (curro|trabajo)|tengo (un )?(trabajo|curro)|l[ií]o en el (curro|trabajo)|mucho curro|en una reuni[oó]n)\b/i;

/** One message about one thing, without the rest of the conversation: done, not yet, no longer needed, or unclear. */
async function judgeOne(title: string, action: string | null, text: string): Promise<{ outcome: Outcome; reply: string } | null> {
  try {
    const out = await llm(
      [
        {
          role: "system",
          content:
            `${config.meFirst || "El usuario"} responde a la pregunta «¿Cómo ha ido «${title}»?» (tipo: ${action ?? "tarea"}). Clasifica su respuesta: "done" si lo terminó y lo que cuenta lo demuestra ` +
            `(para lecturas, ideas concretas; para tareas, qué hizo), "not_yet" si no lo ha hecho, "not_needed" si ya no hace falta o no lo va a hacer, "unclear" si no se sabe. ` +
            `Responde SOLO JSON {"outcome":"done"|"not_yet"|"not_needed"|"unclear","reply":"1-2 frases en español dirigidas a ${config.meFirst || "el usuario"}, en segunda persona (tú), sobre «${title}», directas, sin emojis"}`,
        },
        { role: "user", content: text },
      ],
      { json: true, temperature: 0 }
    );
    const v = JSON.parse(out);
    const outcome = (["done", "not_yet", "not_needed", "unclear"] as const).includes(v.outcome) ? v.outcome : "unclear";
    return { outcome, reply: String(v.reply ?? "").slice(0, 400) };
  } catch {
    return null;
  }
}

/** Nothing was scheduled or added: a reply saying it was ("he programado las lecturas para mañana") isn't true. */
export function withoutClaims(text: string): string {
  return sentences(text)
    .filter((s) => !/\bhe (programado|puesto|movido|apuntado|a[nñ]adido|reorganizado|reprogramado|colocado|planificado)\b/i.test(s))
    .join("").trim();
}

/**
 * Your message. The AI answers, and for each open thing you talk about it decides done (and
 * whether what you said shows it), not yet, or no longer needed; anything vague it asks about.
 * It can also add to-dos, change priorities and give things a time in the week's free spots,
 * the way you'd say it: "esto después del curro", "el sábado por la mañana".
 */
export async function reply(text: string, now = Date.now()): Promise<{ reply: string; updates: { id: string; outcome: Outcome }[] }> {
  const chat = thread();
  addTurn(chat, "user", text);
  const open = openThings(now);
  // the question his message answers: the AI's last question about a specific thing
  const lastAbout = turns(chat).slice(0, -1).reverse().find((t) => t.role === "assistant")?.data?.about;
  const asked = lastAbout ? open.find((o) => o.id === (lastAbout.slotId ? `s:${lastAbout.slotId}` : `r:${lastAbout.ref}`)) : undefined;
  const todo = backlog();
  // how his goals stand: whether there's room for hours off
  const goalsNow = (db.prepare("SELECT id, name, due FROM goals WHERE archived = 0").all() as any[]).map((g) => {
    const parts = db.prepare("SELECT state, effort_min FROM items WHERE tags = ?").all(`goal:${g.id}`) as any[];
    const done = parts.filter((x) => x.state === "done").length;
    const daysLeft = g.due ? Math.ceil((Date.parse(g.due) + DAY - now) / DAY) : null;
    // margin: hours of work left against free hours before the date
    let margin = "";
    if (parts.length && daysLeft != null && daysLeft > 0) {
      const need = parts.filter((x) => x.state !== "done").reduce((m, x) => m + (x.effort_min ?? 60), 0) / 60;
      const free = spots(now, daysLeft).filter((x) => x.tag === "libre").reduce((m, x) => m + (x.end - x.start), 0) / 3_600_000;
      const ratio = free ? need / free : 9;
      margin = `; le faltan ~${Math.round(need)} h de trabajo y tiene ~${Math.round(free)} h libres hasta la fecha: ${ratio > 0.8 ? "MUY JUSTO" : ratio > 0.5 ? "justo" : "con margen"}`;
    }
    return `«${g.name}»: ${parts.length ? `${done} de ${parts.length} partes hechas` : "por sesiones"}${daysLeft != null ? `, quedan ${daysLeft} días` : ""}${margin}`;
  });
  const restOfToday = (db.prepare("SELECT title, start FROM plan_slots WHERE date = ? AND status = 'planned' AND end > ? ORDER BY start").all(localDate(now), now) as any[])
    .map((r) => `${new Date(r.start).toTimeString().slice(0, 5)} ${r.title}`);
  const doneToday = (db.prepare("SELECT COUNT(*) n FROM plan_slots WHERE date = ? AND status = 'done'").get(localDate(now)) as any).n;
  // what he's finished lately ("¿qué he terminado?")
  const finished = (db.prepare(
    "SELECT i.title, i.raw, MAX(e.at) at FROM item_events e JOIN items i ON i.id = e.item_id WHERE e.event = 'done' AND e.at > ? GROUP BY i.id ORDER BY at DESC LIMIT 12"
  ).all(now - 14 * DAY) as any[]).map((r) => `${new Date(r.at).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}: ${String(r.title || r.raw).slice(0, 90)}`);
  // what he's saved lately ("¿qué cosas te he pasado?")
  const saved = (db.prepare(
    "SELECT title, raw, url, created_at, state FROM items WHERE source NOT IN ('manual', 'chat') AND created_at > ? ORDER BY created_at DESC LIMIT 15"
  ).all(now - 14 * DAY) as any[]).map((r) => `${new Date(r.created_at).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}: ${String(r.title || r.raw || r.url).slice(0, 90)}${r.state === "done" ? " (hecho)" : ""}`);
  const freeSpots = spots(now).slice(0, 30);
  const set = upcoming(now).slice(0, 15);
  const hh = (t: number) => new Date(t).toTimeString().slice(0, 5);
  // earlier turns are context; only the last message can close, put off or change anything
  const history = turns(chat).slice(-12, -1).map((t) => `${t.role === "user" ? (config.meFirst || "Usuario") : "Unibox"}: ${t.content}`).join("\n") +
    `\n\nÚLTIMO MENSAJE DEL USUARIO (solo esto cuenta para updates y changes; lo anterior ya está aplicado):\n${text}`;
  let out = { reply: "", updates: [] as { id: string; outcome: Outcome; text: string }[], changes: [] as Change[] };
  try {
    const raw = await llm(
      [
        {
          role: "system",
          content:
            `Eres Unibox y hablas con ${config.meFirst || "el usuario"} sobre su día, sus tareas y sus metas. Ahora es ${whenLabel(now, now)} (${localDate(now)}).\n\n` +
            (asked ? `Lo último que le preguntaste: ${asked.id} | ${asked.title}. Si su mensaje no nombra otra cosa, habla de esto.\n\n` : "") +
            `Cosas abiertas de las que puede estar contando cómo ha ido (id | tipo | título):\n` +
            (open.map((o) => `${o.id} | ${o.action ?? "tarea"} | ${o.title}`).join("\n") || "(ninguna)") +
            `\n\nSus tareas por prioridad (id | prioridad 0-100 | tipo | minutos | título):\n` +
            (todo.map((t) => `${t.id} | ${t.priority} | ${t.action} | ${t.minutes} | ${t.title}`).join("\n") || "(ninguna)") +
            `\n\nSus metas: ${goalsNow.join("; ") || "ninguna"}. Hoy lleva ${doneToday} cosas del plan hechas; lo que queda hoy: ${restOfToday.join("; ") || "nada"}.` +
            `\n\nLo que ha terminado en las dos últimas semanas:\n` + (finished.join("\n") || "(nada)") +
            `\n\nLo último que ha guardado (enlaces, notas, capturas que te ha pasado):\n` + (saved.join("\n") || "(nada en dos semanas)") +
            `\n\nYa puesto para los próximos días:\n` + (set.map((u) => `${u.when}: ${u.title}`).join("\n") || "(nada)") +
            `\n\nHuecos libres de la semana (índice | cuándo | horario):\n` +
            (freeSpots.map((s, i) => `${i} | ${s.label} | ${hh(s.start)}-${hh(s.end)}`).join("\n") || "(ninguno)") +
            `\n\nPara cada cosa abierta que mencione en su último mensaje, decide: "done" si la terminó y lo que cuenta lo demuestra (para lecturas, ideas concretas; para tareas, qué hizo o el resultado; ` +
            `"ya está" no basta), "not_yet" si dice claramente que no la hizo, "not_needed" si ya no hace falta o decidió no hacerla. ` +
            `Si la hizo a medias, por encima o sin concretar, NO la incluyas en updates: pregúntale por ella en reply.\n` +
            `"Estoy trabajando", "tengo curro", "en el trabajo" se refiere a su EMPLEO, no a sus tareas: no le preguntes por ellas, dile que luego hablamos, sin updates. ` +
            `Si pregunta qué ha hecho, qué ha terminado o qué te ha pasado, es una pregunta: contesta con los datos de arriba (lo terminado, lo último guardado), sin updates y sin inventar. ` +
            `Las etapas de un proyecto ya van de una en una: la siguiente no se planifica hasta que termine la actual.\n` +
            `Lo mismo vale para cualquier tarea de su lista (usa su id r:...): si dice que ya la hizo, que no la hizo o que ya no hace falta, va en updates, nunca en changes.\n` +
            `Usa changes SOLO si pide apuntar algo nuevo, cambiar prioridades o cuándo hacer algo: ` +
            `{"type":"add","title":"tarea corta y concreta","action":"do|read|watch|listen|reply|buy","context":"desk (ordenador, trabajo profundo)|home (casa)|phone (llamada o móvil)|errand (fuera)","minutes":60,"priority":0-100,"spot":índice o null}, ` +
            `{"type":"priority","id":"r:...","name":"su título copiado tal cual de la lista","priority":0-100,"spot":índice o null}, {"type":"schedule","id":"r:...","name":"título tal cual","spot":índice}, {"type":"free","hours":3}, {"type":"event",...}. ` +
            `Al cambiar prioridades, parte de las que tiene en la lista: "más importante que X" es justo por encima de la prioridad de X (por ejemplo X tiene 98.9 → 99), "menos importante" justo por debajo; ` +
            `nunca bajes la prioridad de algo salvo que te lo pida. Usa decimales si hace falta para no saltar por encima de otras. ` +
            `Si te cuenta su día (hasta qué hora trabaja, citas, gimnasio, comidas, quedadas), apunta cada cosa con hora como {"type":"event","title":"Gimnasio","start":"19:00","end":"20:00","day":"hoy"|"mañana"|"YYYY-MM-DD"} ` +
            `(si no dice cuándo acaba, calcula una duración razonable) para que el plan se organice alrededor, y en reply dile en 1-2 frases cómo encaja lo suyo (qué hará en los huecos), sin horas: el sistema las añade debajo.\n` +
            `Si te pide horas libres porque tiene planes (salir, quedar, descansar), TÚ decides si puede: mira sus metas (cuánto falta y cuántos días quedan), lo que queda hoy y lo que lleva hecho. ` +
            `Con margen: dáselas con {"type":"free","hours":N}. Justo o MUY JUSTO: dáselas solo si es algo que no se mueve (gente con planes ya hechos, un cumpleaños, salud, una obligación), ` +
            `y si es solo descansar o le apetece, no pongas el change o dale menos horas, y explícale por qué en una frase, ` +
            `proponiendo algo concreto (por ejemplo, "haz la etapa 1 primero y luego eres libre", o "mañana por la mañana la recuperas"). No sermonees. ` +
            `Una de dos: o le das las horas (con el change) o le dices que no; nunca le digas "sal" o "ve" sin dárselas. Si le das horas yendo justo, añade en una frase cuándo recuperarlas.\n` +
            `Como en Instinct, a cada cosa nueva o que pida colocar asígnale el hueco que mejor encaje: trabajo profundo en huecos largos libres (después del trabajo, fin de semana por la mañana), ` +
            `lecturas en huecos libres, llamadas y recados cuando esté abierto, lo urgente antes. Si no dice prioridad, estímala frente a sus otras tareas: lo nuevo va por debajo de las de su meta de la semana (~98-99) ` +
            `salvo que diga que es urgente o más importante que ellas. ` +
            `Si te pide ayuda para priorizar, propón un orden y coloca las más importantes en huecos (varias pueden ir al mismo hueco si caben). ` +
            `Los changes se aplican en el acto: en reply no preguntes si quiere que lo apuntes o lo coloques (ya está hecho), y no digas horas ni días: el sistema añade debajo dónde ha quedado cada cosa. ` +
            `Responde SOLO JSON {"reply":"respuesta en español, directa y cercana, sin dramatizar ni compadecer, sin emojis, 1-3 frases; no repitas frases de tus mensajes anteriores ni cierres con despedidas",` +
            `"updates":[{"id":"s:12","name":"su título copiado tal cual de la lista","outcome":"done"|"not_yet"|"not_needed","text":"lo que dijo sobre esa cosa, con sus palabras"}],"changes":[]}`,
        },
        { role: "user", content: history },
      ],
      { json: true, temperature: 0.3 }
    );
    const v = JSON.parse(raw);
    out.reply = String(v.reply ?? "").slice(0, 800);
    // ids look alike and the model mixes them up: the name it gives decides which thing it is
    const things = [...open.map((o) => ({ id: o.id, title: o.title })), ...todo.map((t) => ({ id: t.id, title: t.title }))];
    const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const which = (u: any): string | null => {
      const byId = things.find((x) => x.id === u.id);
      const name = norm(String(u.name ?? ""));
      if (!name) return byId ? byId.id : null;
      if (byId && (norm(byId.title).startsWith(name) || name.startsWith(norm(byId.title).slice(0, 40)))) return byId.id;
      const hit = things.find((x) => norm(x.title) === name) ?? things.find((x) => norm(x.title).startsWith(name));
      if (hit) return hit.id;
      const some = things.filter((x) => norm(x.title).includes(name));
      return some.length === 1 ? some[0].id : null;
    };
    out.updates = (Array.isArray(v.updates) ? v.updates : [])
      .filter((u: any) => ["done", "not_yet", "not_needed"].includes(u.outcome))
      .map((u: any) => ({ id: which(u), outcome: u.outcome as Outcome, text: String(u.text ?? text).slice(0, 2000) }))
      .filter((u: any) => u.id) as { id: string; outcome: Outcome; text: string }[];
    out.changes = (Array.isArray(v.changes) ? v.changes : [])
      .filter((c: any) => c && ["add", "priority", "schedule", "free", "event"].includes(c.type))
      // priorities only move when he talks about them
      .filter((c: any) => c.type !== "priority" || /priori|importante|urgente|antes que|despu[eé]s de|s[uú]bel|b[aá]jal|primero|orden/i.test(text))
      .map((c: any) => ({ ...c, spot: c.spot == null || c.spot === "" ? null : Number(c.spot) }));
  } catch {
    out.reply = "Ahora mismo no puedo pensarlo; lo tengo guardado y te contesto en cuanto pueda.";
  }
  // "¿qué he terminado?" is a question, answered from the record, not a report to classify
  const asksDone = /qu[eé] (he|llevo) (terminado|hecho|acabado|completado|cerrado)|qu[eé] llevo hecho/i.test(text);
  if (asksDone) {
    out.updates = [];
    out.changes = [];
    out.reply = finished.length
      ? `En las dos últimas semanas has terminado:\n${finished.slice(0, 8).map((f) => `· ${f}`).join("\n")}`
      : "En las dos últimas semanas no tengo nada marcado como terminado. Si has acabado algo, cuéntamelo y lo apunto.";
  }
  // at his job: nothing to settle, nothing to ask; it waits until work is over
  // (with times in it, he's telling you his day, not that he's busy right now)
  const atWork = AT_WORK.test(text) && !/\b(a las|hasta las|desde las|de \d{1,2} a \d{1,2})\b|\d{1,2}:\d{2}/i.test(text);
  if (atWork) {
    out.updates = [];
    out.changes = [];
    out.reply = "Vale, céntrate en el curro. Hablamos cuando termines.";
  }
  // a thing his message doesn't name is the one the AI just asked about: "lo descarto" after
  // "¿Cómo ha ido la etapa 10?" is the etapa 10, not something from earlier in the conversation
  if (asked) {
    const words = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9_]{5,}/g) ?? [];
    const said = new Set(words(text));
    const names = (id: string) => {
      const x = [...open, ...todo].find((o) => o.id === id);
      return x ? words(x.title).some((w) => said.has(w)) : false;
    };
    let retargeted = false;
    out.updates = out.updates.map((u) => {
      if (u.id === asked.id || names(u.id) || retargeted || out.updates.some((v) => v.id === asked.id)) return u;
      retargeted = true;
      return { ...u, id: asked.id };
    });
    if (retargeted) out.reply = "";
  }
  // the AI had just asked about one thing and the model settled nothing about it (it can latch onto
  // an earlier, similar message): judge his message against that one thing alone
  // (only for an answer: a question or a request — "¿puedo librarme?", "apúntame…" — isn't one)
  const request = /\?|\b(puedo|podr[ií]a|necesito|quiero|me apetece|ap[uú]ntame|l[ií]brame|lib[eé]rame|ponme|mu[eé]vela|sube|baja)\b/i.test(text);
  if (asked && !atWork && !asksDone && !request && !out.updates.length && !out.changes.length) {
    const j = await judgeOne(asked.title, asked.action, text);
    if (j && j.outcome !== "unclear") {
      out.updates = [...out.updates, { id: asked.id, outcome: j.outcome, text }];
      out.reply = j.reply || out.reply;
    }
  }
  for (const u of out.updates) {
    try {
      const t = u.id.startsWith("s:") ? target(Number(u.id.slice(2)), null) : target(null, u.id.slice(2));
      applyOutcome(t, u.outcome, u.text);
    } catch {}
  }
  // a thing just closed or put off isn't added back or given a time in the same breath
  const settled = new Set(out.updates.map((u) => {
    if (u.id.startsWith("r:")) return u.id.slice(2);
    try { return target(Number(u.id.slice(2)), null).ref; } catch { return ""; }
  }));
  const titleOf = (ref: string) => String((db.prepare("SELECT title, raw FROM items WHERE id = ?").get(ref) as any)?.title ?? "");
  const settledTitles = new Set([...settled].map((r) => titleOf(r).toLowerCase()).filter(Boolean));
  // "no he terminado, espera": no more questions for a few hours (the evening review still comes)
  const putOff = out.updates.length > 0 && out.updates.every((u) => u.outcome === "not_yet");
  if (putOff || /\b(espera|esp[eé]rate|d[eé]jame|luego te (digo|cuento)|no me preguntes|ya te dir[eé])\b/i.test(text)) {
    const until = Math.min(wrapAt(now), now + 3 * 3_600_000);
    setMeta("assistant_quiet_until", String(Math.max(Number(getMeta("assistant_quiet_until") ?? 0), until > now ? until : now + 3 * 3_600_000)));
  }
  // at his job: nothing until work is over (the evening review still comes)
  if (atWork) {
    const [, end] = (workHoursFor(new Date(now).setHours(0, 0, 0, 0), now) || config.workHours || "09:00-17:00").split("-");
    const [h, m] = (end || "17:00").split(":").map(Number);
    const until = new Date(now); until.setHours(h, m, 0, 0);
    if (until.getTime() > now) setMeta("assistant_quiet_until", String(Math.max(Number(getMeta("assistant_quiet_until") ?? 0), until.getTime())));
  }
  if (!out.reply && out.updates.length) {
    const u = out.updates.find((x) => x.id === asked?.id) ?? out.updates[0];
    const title = [...open, ...todo].find((o) => o.id === u.id)?.title ?? "eso";
    out.reply = u.outcome === "done" ? `Apuntado como hecho: «${title}».` : u.outcome === "not_yet" ? `Vale, «${title}» queda para más adelante.` : `Descartado: «${title}».`;
  }
  const said = applyChanges(out.changes.filter((c) =>
    !(c.id && settled.has(c.id.slice(2))) && !(c.name && settledTitles.has(c.name.toLowerCase())) && !(c.title && settledTitles.has(c.title.toLowerCase()))
  ), freeSpots, now);
  const answer = [said.length ? withoutTimes(out.reply) : withoutClaims(out.reply), ...said].filter(Boolean).join("\n") || "Apuntado.";
  addTurn(chat, "assistant", answer, { updates: out.updates.map(({ id, outcome }) => ({ id, outcome })), changes: said });
  return { reply: answer, updates: out.updates.map(({ id, outcome }) => ({ id, outcome })) };
}

export function messages(limit = 80): { role: string; content: string; at: number }[] {
  return turns(thread()).slice(-limit).map((t) => ({ role: t.role, content: t.content, at: t.at }));
}
