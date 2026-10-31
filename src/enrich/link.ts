import { config } from "../config.js";

export interface LinkMeta {
  title?: string;
  description?: string;
  site?: string;
  image?: string;
  author?: string;
}

export function mediaSiteKind(url: string): "video" | "audio" | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (
      ["youtube.com", "youtu.be", "m.youtube.com", "vimeo.com", "tiktok.com", "twitch.tv"].some(
        (h) => host === h || host.endsWith(`.${h}`)
      )
    ) {
      return "video";
    }
    if (
      ["spotify.com", "open.spotify.com", "soundcloud.com", "podcasts.apple.com", "music.apple.com"].some(
        (h) => host === h || host.endsWith(`.${h}`)
      )
    ) {
      return "audio";
    }
    return null;
  } catch {
    return null;
  }
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.linkTimeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return "";
    const reader = res.body?.getReader();
    if (!reader) return (await res.text()).slice(0, 400_000);
    let received = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received > 400_000) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (key && content != null && !out.has(key.toLowerCase())) {
      out.set(key.toLowerCase(), decode(content));
    }
  }
  return out;
}

async function oEmbed(url: string): Promise<LinkMeta | null> {
  const kind = mediaSiteKind(url);
  if (!kind) return null;
  const endpoint =
    kind === "video" && /vimeo\.com/.test(url)
      ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
      : `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  const raw = await fetchText(endpoint);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
      provider_name?: string;
    };
    return {
      title: j.title,
      author: j.author_name,
      site: j.provider_name ?? (kind === "video" ? "YouTube" : undefined),
      image: j.thumbnail_url,
    };
  } catch {
    return null;
  }
}

export async function enrichLink(url: string): Promise<LinkMeta> {
  const oe = await oEmbed(url);
  if (oe?.title) return oe;

  const html = await fetchText(url);
  if (!html) return oe ?? {};
  const meta = metaTags(html);
  const titleTag = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let site: string | undefined;
  try {
    site = new URL(url).hostname.replace(/^www\./, "");
  } catch {
  }
  return {
    title: meta.get("og:title") ?? meta.get("twitter:title") ?? (titleTag || undefined),
    description:
      meta.get("og:description") ??
      meta.get("twitter:description") ??
      meta.get("description") ??
      undefined,
    site,
    image: meta.get("og:image") ?? meta.get("twitter:image") ?? undefined,
    author: meta.get("author") ?? meta.get("og:site_name") ?? undefined,
  };
}
