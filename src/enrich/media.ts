import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../config.js";
import { llm } from "../llm.js";

function which(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function hasBinary(cmd: string): boolean {
  return which(cmd) !== null;
}

export function ffmpegAvailable(): boolean {
  return hasBinary("ffmpeg");
}

/** Describe an image with the gateway's vision model, if it supports image input. */
export async function describeImage(file: string): Promise<string | null> {
  if (!config.nanApiKey) return null;
  let b64: string;
  try {
    b64 = fs.readFileSync(file).toString("base64");
  } catch {
    return null;
  }
  const ext = path.extname(file).toLowerCase().replace(".", "") || "jpeg";
  const mime = ext === "jpg" ? "jpeg" : ext;
  try {
    const out = await llm([
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Describe this image for a personal inbox in 1-2 sentences. If it contains text, " +
              "transcribe the important text. Reply with plain text only.",
          },
          { type: "image_url", image_url: { url: `data:image/${mime};base64,${b64}` } },
        ],
      },
    ]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Transcribe an audio file via a local whisper CLI, then the gateway if configured. */
export async function transcribeAudio(file: string): Promise<string | null> {
  const whisper = which("whisper") ?? which("whisper-ctranslate2");
  if (whisper) {
    try {
      const dir = path.dirname(file);
      execFileSync(whisper, [file, "--output_format", "txt", "--output_dir", dir], {
        stdio: "ignore",
        timeout: 120_000,
      });
      const txt = file.replace(/\.[^.]+$/, ".txt");
      if (fs.existsSync(txt)) return fs.readFileSync(txt, "utf8").trim() || null;
    } catch {
    }
  }
  if (!config.nanApiKey) return null;
  try {
    const buf = fs.readFileSync(file);
    const form = new FormData();
    form.append("file", new Blob([buf]), path.basename(file));
    form.append("model", config.whisperModel);
    const res = await fetch(`${config.nanBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.nanApiKey}` },
      body: form,
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch {
    return null;
  }
}

/** Extract a poster frame from a video with ffmpeg when available. */
export function videoThumbnail(file: string): string | null {
  if (!ffmpegAvailable()) return null;
  const out = path.join(config.mediaDir, `${path.basename(file)}.thumb.jpg`);
  if (fs.existsSync(out)) return out;
  try {
    execFileSync(
      "ffmpeg",
      ["-ss", "0", "-i", file, "-frames:v", "1", "-vf", "scale=640:-1", "-y", out],
      { stdio: "ignore", timeout: 30_000 }
    );
    return fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
