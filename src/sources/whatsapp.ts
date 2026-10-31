#!/usr/bin/env node
import qrcode from "qrcode-terminal";
import { waStart, waStatus } from "../wamanager.js";

const printed = new Set<string>();
const holdAlive = setInterval(() => {}, 1 << 30);

async function waitConnected(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const qr = waStatus().qr;
      if (qr && !printed.has(qr)) {
        printed.add(qr);
        qrcode.generate(qr, { small: true });
      }
      if (waStatus().state === "connected") {
        clearInterval(timer);
        resolve();
      }
    }, 1500);
  });
}

export async function link(): Promise<void> {
  await waStart();
  console.log("Scan the QR with WhatsApp → Linked devices. Ctrl-C to stop.");
  await waitConnected();
  console.log("WhatsApp linked. Capturing messages.");
}

export async function watch(durationSec?: number): Promise<void> {
  if (waStatus().state !== "connected") await waStart();
  console.log("Watching WhatsApp for new messages...");
  if (durationSec) {
    setTimeout(() => {
      clearInterval(holdAlive);
      process.exit(0);
    }, durationSec * 1000);
  }
}
