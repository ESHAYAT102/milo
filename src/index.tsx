#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { Jimp } from "jimp";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type {
  InputRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";

const RESEND_API_BASE = "https://api.resend.com";
const INBOX_LIMIT = 50;
const LOADER_FRAMES = ["⡁⠀⢈", "⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹"];
const MODAL_BACKGROUND_FG_DIM = 0.62;
const MILO_DIR = join(homedir(), ".milo");
const SENT_REPLIES_CACHE_PATH = join(MILO_DIR, "sent-replies.json");
const ACTIVE_PANE_BORDER_COLOR = "#7aa2f7";
const INACTIVE_PANE_BORDER_COLOR = "#414868";
const MAX_INLINE_IMAGES = 4;
const INLINE_IMAGE_WIDTH = 48;
const INLINE_IMAGE_HEIGHT = 18;

type AttachmentSummary = {
  id: string;
  filename: string;
  size?: number;
  content_type?: string;
  content_disposition?: string | null;
  content_id?: string | null;
  download_url?: string;
  expires_at?: string;
};

type EmailSummary = {
  id: string;
  from: string;
  to: string[];
  created_at: string;
  subject: string | null;
  bcc?: string[] | null;
  cc?: string[] | null;
  reply_to?: string[] | null;
  message_id?: string | null;
  attachments?: AttachmentSummary[];
};

type EmailDetail = EmailSummary & {
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
};

type InboxState =
  | { status: "loading"; message: string }
  | { status: "ready"; message: string }
  | { status: "error"; message: string };

type AttachmentState =
  | { status: "idle"; message: string }
  | { status: "loading"; message: string }
  | { status: "ready"; message: string }
  | { status: "error"; message: string };

type Notification = {
  id: number;
  tone: "info" | "success" | "error";
  message: string;
};

type ComposeField = "from" | "to" | "subject" | "attachments" | "body";
type ReplyField = "attachments" | "body";
type ActivePane = "inbox" | "detail";
type ScrollUnit = "absolute" | "viewport" | "content" | "step";

type OutgoingAttachment = {
  filename: string;
  content: string;
};

type SendEmailPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments?: OutgoingAttachment[];
  headers?: Record<string, string>;
};

type SendEmailResponse = {
  id: string;
};

type SentRepliesCache = Record<string, EmailDetail[]>;

type InlineImage = {
  alt: string;
  src: string;
};

type RenderedInlineImage = InlineImage & {
  lines: { top: string; bottom: string }[][];
};

type RenderedInlineImageSlot = RenderedInlineImage | null;

type EmailDisplayLine =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "image"; imageIndex: number };

function dimHexColor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);

  if (!match) return color;

  const value = match[1]!;
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16);
    return Math.round(channel * MODAL_BACKGROUND_FG_DIM)
      .toString(16)
      .padStart(2, "0");
  });

  return `#${channels.join("")}`;
}

function notificationBackground(tone: Notification["tone"]): string {
  if (tone === "error") return "#7f1d1d";
  if (tone === "success") return "#14532d";
  return "#1e3a8a";
}

function notificationForeground(tone: Notification["tone"]): string {
  if (tone === "error") return "#fecaca";
  if (tone === "success") return "#dcfce7";
  return "#dbeafe";
}

function isSendShortcut(key: { ctrl: boolean; name: string }): boolean {
  return key.ctrl && (key.name === "return" || key.name.toLowerCase() === "s");
}

function apiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY?.trim();
  return key ? key : undefined;
}

async function resendRequest<T>(path: string): Promise<T> {
  const key = apiKey();

  if (!key) {
    throw new Error("RESEND_API_KEY is not set in this shell.");
  }

  const response = await fetch(`${RESEND_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": "milo-tui/1.0",
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;

    try {
      const body = (await response.json()) as {
        message?: string;
        error?: string;
      };
      message = body.message || body.error || message;
    } catch {
      // The status line is enough if Resend does not return JSON.
    }

    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function resendPost<T>(path: string, body: unknown): Promise<T> {
  const key = apiKey();

  if (!key) {
    throw new Error("RESEND_API_KEY is not set in this shell.");
  }

  const response = await fetch(`${RESEND_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "milo-tui/1.0",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;

    try {
      const responseBody = (await response.json()) as {
        message?: string;
        error?: string;
      };
      message = responseBody.message || responseBody.error || message;
    } catch {
      // The status line is enough if Resend does not return JSON.
    }

    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function listReceivedEmails(): Promise<EmailSummary[]> {
  const response = await resendRequest<{ data: EmailSummary[] }>(
    `/emails/receiving?limit=${INBOX_LIMIT}`,
  );

  return response.data ?? [];
}

async function getReceivedEmail(id: string): Promise<EmailDetail> {
  return await resendRequest<EmailDetail>(`/emails/receiving/${id}`);
}

async function sendEmail(
  payload: SendEmailPayload,
): Promise<SendEmailResponse> {
  return await resendPost<SendEmailResponse>("/emails", payload);
}

async function listReceivedEmailAttachments(
  emailId: string,
): Promise<AttachmentSummary[]> {
  const response = await resendRequest<{ data: AttachmentSummary[] }>(
    `/emails/receiving/${emailId}/attachments`,
  );

  return response.data ?? [];
}

async function getReceivedEmailAttachment(
  emailId: string,
  attachmentId: string,
): Promise<AttachmentSummary> {
  return await resendRequest<AttachmentSummary>(
    `/emails/receiving/${emailId}/attachments/${attachmentId}`,
  );
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const CSS_TOKEN_PATTERN =
  /\b(?:background(?:-color)?|border(?:-(?:bottom|color|radius|top))?|color|font(?:-(?:family|size|weight))?|line-height|margin|padding|text-decoration)\s*:|!important|@media\b|(?:^|\s)[.#][a-z0-9_-]+\s*\{/gi;
const CSS_BLOCK_START_PATTERN =
  /(?:^|\n)\s*(?:@(?:font-face|media|supports|keyframes)[^{]*|(?:[#.][\w-]+|\[[^\]]+\]|(?:a|article|body|button|div|footer|h[1-6]|header|html|img|li|main|ol|p|section|span|table|tbody|td|th|thead|tr|ul)\b)(?:[\s>+~:,.[#\]\(\)"'=\w-])*)\s*\{/gi;
const CSS_DECLARATION_LINE_PATTERN = /^\s*(?:[-\w]+)\s*:\s*[^;\n]+;?\s*$/;

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi,
    (match, entity: string) => {
      const normalized = entity.toLowerCase();

      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return codePoint > 0x10ffff ? match : String.fromCodePoint(codePoint);
      }

      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return codePoint > 0x10ffff ? match : String.fromCodePoint(codePoint);
      }

      return HTML_ENTITIES[normalized] ?? match;
    },
  );
}

function normalizeBodyWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCssRules(value: string): string {
  const withoutTaggedCss = value
    .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, "")
    .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/<head\b[\s\S]*?(?:<\/head>|$)/gi, "");

  let index = 0;
  let clean = "";

  while (index < withoutTaggedCss.length) {
    CSS_BLOCK_START_PATTERN.lastIndex = index;
    const match = CSS_BLOCK_START_PATTERN.exec(withoutTaggedCss);

    if (!match) {
      clean += withoutTaggedCss.slice(index);
      break;
    }

    const blockStart = match.index;
    const braceStart = CSS_BLOCK_START_PATTERN.lastIndex - 1;
    let depth = 1;
    let cursor = braceStart + 1;

    while (cursor < withoutTaggedCss.length && depth > 0) {
      const character = withoutTaggedCss[cursor];

      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      cursor += 1;
    }

    if (depth > 0) {
      clean += withoutTaggedCss.slice(index);
      break;
    }

    clean += withoutTaggedCss.slice(index, blockStart);
    clean += "\n";
    index = cursor;
  }

  return clean
    .split("\n")
    .filter((line) => !CSS_DECLARATION_LINE_PATTERN.test(line))
    .join("\n");
}

function countCssTokens(value: string): number {
  return value.match(CSS_TOKEN_PATTERN)?.length ?? 0;
}

function isLikelyBrokenTextBody(text: string): boolean {
  const cssTokens = countCssTokens(text);
  const structuralNoise = text.match(/[{};]/g)?.length ?? 0;

  return (
    /<\/?(?:html|body|table|style|script|div|span|p|a|br)\b/i.test(text) ||
    cssTokens >= 3 ||
    (cssTokens > 0 && structuralNoise >= 12)
  );
}

function containsHtmlTags(text: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(text);
}

function cleanPlainText(text: string): string {
  return normalizeBodyWhitespace(decodeHtmlEntities(stripCssRules(text)));
}

function cleanHtml(html: string): string {
  let imageIndex = 0;

  return normalizeBodyWhitespace(
    decodeHtmlEntities(
      stripCssRules(html)
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<img\b[^>]*>/gi, () => `\n[[milo:image:${imageIndex++}]]\n`)
        .replace(
          /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
          (_match, _quote: string, href: string, label: string) => {
            const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
            const cleanHref = decodeHtmlEntities(href).trim();

            if (/\[\[milo:image:\d+]]/.test(cleanLabel)) return cleanLabel;
            if (!cleanHref) return cleanLabel;
            if (!cleanLabel || cleanLabel === cleanHref) return cleanHref;

            return `${cleanLabel} (${cleanHref})`;
          },
        )
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(
          /<\/(?:p|div|h[1-6]|li|tr|table|section|article|blockquote)>/gi,
          "\n",
        )
        .replace(/<[^>]+>/g, ""),
    ),
  );
}

function extractHtmlImages(html: string | null | undefined): InlineImage[] {
  if (!html) return [];

  return [...html.matchAll(/<img\b([^>]*)>/gi)]
    .map((match) => {
      const attributes = match[1] ?? "";
      const src = attributeValue(attributes, "src");

      if (!src) return undefined;

      return {
        alt: attributeValue(attributes, "alt") ?? "image",
        src: decodeHtmlEntities(src).trim(),
      };
    })
    .filter((image): image is InlineImage => Boolean(image?.src))
    .slice(0, MAX_INLINE_IMAGES);
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(
    attributes,
  );

  return match?.[2];
}

async function inlineImageBuffer(
  image: InlineImage,
  attachments: AttachmentSummary[],
): Promise<Buffer> {
  if (image.src.startsWith("data:")) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(image.src);

    if (!match) throw new Error("Unsupported data image.");

    return Buffer.from(match[1]!, "base64");
  }

  if (image.src.toLowerCase().startsWith("cid:")) {
    const cid = image.src.slice(4).replace(/^<|>$/g, "");
    const attachment = attachments.find(
      (item) => item.content_id?.replace(/^<|>$/g, "") === cid,
    );

    if (!attachment?.download_url) {
      throw new Error(`Missing image attachment for cid:${cid}.`);
    }

    return await fetchBuffer(attachment.download_url);
  }

  if (/^https?:\/\//i.test(image.src)) {
    return await fetchBuffer(image.src);
  }

  throw new Error("Unsupported image URL.");
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function rgbHex(data: Buffer | Uint8Array, index: number): string {
  return `#${[data[index], data[index + 1], data[index + 2]]
    .map((value) => (value ?? 0).toString(16).padStart(2, "0"))
    .join("")}`;
}

async function renderInlineImage(
  image: InlineImage,
  attachments: AttachmentSummary[],
): Promise<RenderedInlineImage> {
  const buffer = await inlineImageBuffer(image, attachments);
  const decoded = await Jimp.read(buffer);
  const scale = Math.min(
    INLINE_IMAGE_WIDTH / decoded.bitmap.width,
    (INLINE_IMAGE_HEIGHT * 2) / decoded.bitmap.height,
    1,
  );
  const width = Math.max(1, Math.floor(decoded.bitmap.width * scale));
  const height = Math.max(2, Math.floor(decoded.bitmap.height * scale));

  decoded.resize({ w: width, h: height });

  const rows: RenderedInlineImage["lines"] = [];

  for (let y = 0; y < decoded.bitmap.height; y += 2) {
    const row: { top: string; bottom: string }[] = [];

    for (let x = 0; x < decoded.bitmap.width; x += 1) {
      const top = (y * decoded.bitmap.width + x) * 4;
      const bottomY = Math.min(y + 1, decoded.bitmap.height - 1);
      const bottom = (bottomY * decoded.bitmap.width + x) * 4;

      row.push({
        top: rgbHex(decoded.bitmap.data, top),
        bottom: rgbHex(decoded.bitmap.data, bottom),
      });
    }

    rows.push(row);
  }

  return { ...image, lines: rows };
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  spawn(command, args, {
    detached: true,
    stdio: "ignore",
  }).unref();
}

const URL_PATTERN = /https?:\/\/[^\s<>)\]]+/gi;
const BRACKETED_URL_PATTERN = /^\[(https?:\/\/[^\]]+)\]$/i;
const LABELED_URL_PATTERN = /^(.*?)\s*\((https?:\/\/[^)]+)\)$/i;
const INLINE_IMAGE_MARKER_PATTERN = /^\[\[milo:image:(\d+)]]$/;

function normalizeUrl(value: string): string {
  return value.trim().replace(/[.,;:!?]+$/g, "");
}

function sameUrl(left: string, right: string): boolean {
  return normalizeUrl(left) === normalizeUrl(right);
}

function isStandaloneImageUrl(line: string, images: InlineImage[]): boolean {
  const url = normalizeUrl(line.replace(/^\[|\]$/g, ""));

  return images.some((image) => sameUrl(image.src, url));
}

function displayLinkLabel(value: string, fallback: string): string {
  const clean = value.trim().replace(/\s+/g, " ");

  if (!clean || /^https?:\/\//i.test(clean)) {
    try {
      return new URL(fallback).hostname;
    } catch {
      return "Open link";
    }
  }

  return clean;
}

function bodyDisplayLines(
  lines: string[],
  images: InlineImage[],
): EmailDisplayLine[] {
  const displayLines: EmailDisplayLine[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      displayLines.push({ kind: "text", text: "" });
      continue;
    }

    const imageMarker = INLINE_IMAGE_MARKER_PATTERN.exec(line);

    if (imageMarker) {
      const imageIndex = Number.parseInt(imageMarker[1]!, 10);

      if (images[imageIndex]) {
        displayLines.push({ kind: "image", imageIndex });
      }

      continue;
    }

    if (isStandaloneImageUrl(line, images)) continue;

    const bracketedUrl = BRACKETED_URL_PATTERN.exec(line);

    if (bracketedUrl) {
      const previous = displayLines[displayLines.length - 1];
      const href = normalizeUrl(bracketedUrl[1]!);

      if (
        previous?.kind === "text" &&
        previous.text.trim() &&
        previous.text.length <= 80
      ) {
        displayLines[displayLines.length - 1] = {
          kind: "link",
          label: displayLinkLabel(previous.text, href),
          href,
        };
      } else {
        displayLines.push({
          kind: "link",
          label: displayLinkLabel("", href),
          href,
        });
      }

      continue;
    }

    const labeledUrl = LABELED_URL_PATTERN.exec(line);

    if (labeledUrl) {
      const href = normalizeUrl(labeledUrl[2]!);

      if (!isStandaloneImageUrl(href, images)) {
        displayLines.push({
          kind: "link",
          label: displayLinkLabel(labeledUrl[1]!, href),
          href,
        });
        continue;
      }
    }

    displayLines.push({ kind: "text", text: rawLine });
  }

  return displayLines;
}

function emailBody(email: EmailDetail | undefined): string {
  if (!email) return "";

  const text = email.text?.trim();
  const html = email.html?.trim();
  const textLooksBroken = text ? isLikelyBrokenTextBody(text) : false;
  const cleanedText = text
    ? containsHtmlTags(text)
      ? cleanHtml(text)
      : cleanPlainText(text)
    : "";
  const cleanedHtml = html ? cleanHtml(html) : "";

  if (html && extractHtmlImages(html).length > 0 && cleanedHtml) {
    return cleanedHtml;
  }

  if (cleanedText && !textLooksBroken) {
    return cleanedText;
  }

  if (cleanedHtml) return cleanedHtml;
  if (cleanedText) return cleanedText;

  return "This email does not include a text or HTML body.";
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const lookup = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === lookup,
  );

  return entry?.[1];
}

function normalizeMessageId(value: string | undefined): string | undefined {
  return value?.trim().replace(/^<|>$/g, "");
}

function headerMentionsMessageId(
  value: string | undefined,
  messageId: string | null | undefined,
): boolean {
  const normalized = normalizeMessageId(messageId ?? undefined);

  if (!value || !normalized) return false;

  return value.includes(normalized) || value.includes(`<${normalized}>`);
}

function isReplyToEmail(
  reply: EmailDetail,
  parentMessageId: string | null | undefined,
): boolean {
  return (
    headerMentionsMessageId(
      headerValue(reply.headers, "In-Reply-To"),
      parentMessageId,
    ) ||
    headerMentionsMessageId(
      headerValue(reply.headers, "References"),
      parentMessageId,
    )
  );
}

function replyPreviewLines(email: EmailDetail): string[] {
  const lines = emailBody(email)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(0, 4);
}

function isEmailDetail(value: unknown): value is EmailDetail {
  if (!value || typeof value !== "object") return false;

  const email = value as Partial<EmailDetail>;

  return (
    typeof email.id === "string" &&
    typeof email.from === "string" &&
    Array.isArray(email.to) &&
    email.to.every((address) => typeof address === "string") &&
    typeof email.created_at === "string" &&
    (typeof email.subject === "string" || email.subject === null) &&
    (typeof email.text === "string" ||
      email.text === null ||
      email.text === undefined)
  );
}

function parseSentRepliesCache(value: unknown): SentRepliesCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, EmailDetail[]] =>
          typeof entry[0] === "string" &&
          Array.isArray(entry[1]) &&
          entry[1].every(isEmailDetail),
      )
      .map(([emailId, replies]) => [emailId, replies]),
  );
}

async function loadSentRepliesCache(): Promise<SentRepliesCache> {
  try {
    return parseSentRepliesCache(
      JSON.parse(await readFile(SENT_REPLIES_CACHE_PATH, "utf8")),
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }

    throw error;
  }
}

async function saveSentRepliesCache(cache: SentRepliesCache): Promise<void> {
  await mkdir(MILO_DIR, { recursive: true });
  await writeFile(
    SENT_REPLIES_CACHE_PATH,
    `${JSON.stringify(cache, null, 2)}\n`,
  );
}

function formatAddressList(addresses: string[] | null | undefined): string {
  return addresses?.length ? addresses.join(", ") : "-";
}

function parseAddressList(value: string): string[] {
  return value
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

function parseLocalPaths(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}

function inboxRowId(emailId: string): string {
  return `inbox-email-${emailId}`;
}

function attachmentRowId(attachmentId: string): string {
  return `attachment-${attachmentId}`;
}

function searchRowId(emailId: string): string {
  return `search-email-${emailId}`;
}

function formatFileSize(size: number | undefined): string {
  if (size === undefined) return "-";

  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function safeFilename(filename: string): string {
  const clean = basename(filename)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();

  return clean || "attachment";
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function buildOutgoingAttachments(
  pathsValue: string,
): Promise<OutgoingAttachment[]> {
  const paths = parseLocalPaths(pathsValue);

  return await Promise.all(
    paths.map(async (path) => {
      const expandedPath = expandHomePath(path);
      const content = await readFile(expandedPath);

      return {
        filename: safeFilename(expandedPath),
        content: Buffer.from(content).toString("base64"),
      };
    }),
  );
}

async function uniqueDownloadPath(filename: string): Promise<string> {
  const downloadsDir = join(homedir(), "Downloads");
  const clean = safeFilename(filename);
  const extension = extname(clean);
  const stem = extension ? clean.slice(0, -extension.length) : clean;

  await mkdir(downloadsDir, { recursive: true });

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = join(downloadsDir, `${stem}${suffix}${extension}`);

    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }

  return join(downloadsDir, `${stem}-${Date.now()}${extension}`);
}

async function downloadAttachmentFile(
  emailId: string,
  attachment: AttachmentSummary,
): Promise<string> {
  const freshAttachment = attachment.download_url
    ? attachment
    : await getReceivedEmailAttachment(emailId, attachment.id);

  if (!freshAttachment.download_url) {
    throw new Error(
      "Resend did not return a download URL for this attachment.",
    );
  }

  const response = await fetch(freshAttachment.download_url);

  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }

  const filePath = await uniqueDownloadPath(freshAttachment.filename);
  await writeFile(filePath, new Uint8Array(await response.arrayBuffer()));

  return filePath;
}

function App() {
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailsById, setDetailsById] = useState<Record<string, EmailDetail>>(
    {},
  );
  const [sentRepliesByEmailId, setSentRepliesByEmailId] = useState<
    Record<string, EmailDetail[]>
  >({});
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [state, setState] = useState<InboxState>({
    status: "loading",
    message: "Loading Resend...",
  });
  const [loaderFrameIndex, setLoaderFrameIndex] = useState(0);
  const [attachmentModalOpen, setAttachmentModalOpen] = useState(false);
  const [selectedAttachmentIndex, setSelectedAttachmentIndex] = useState(0);
  const [attachmentsByEmailId, setAttachmentsByEmailId] = useState<
    Record<string, AttachmentSummary[]>
  >({});
  const [attachmentState, setAttachmentState] = useState<AttachmentState>({
    status: "idle",
    message: "No attachment selected.",
  });
  const [notification, setNotification] = useState<Notification | null>(null);
  const [replyModalOpen, setReplyModalOpen] = useState(false);
  const [replyField, setReplyField] = useState<ReplyField>("body");
  const [replyDraftsByEmailId, setReplyDraftsByEmailId] = useState<
    Record<string, string>
  >({});
  const [replyAttachmentPathsByEmailId, setReplyAttachmentPathsByEmailId] =
    useState<Record<string, string>>({});
  const [replySendState, setReplySendState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [composeModalOpen, setComposeModalOpen] = useState(false);
  const [composeField, setComposeField] = useState<ComposeField>("to");
  const [composeFrom, setComposeFrom] = useState("");
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeAttachmentPaths, setComposeAttachmentPaths] = useState("");
  const [composeBodySeed, setComposeBodySeed] = useState("");
  const [composeSendState, setComposeSendState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  const [activePane, setActivePane] = useState<ActivePane>("inbox");
  const [renderedImagesByEmailId, setRenderedImagesByEmailId] = useState<
    Record<string, RenderedInlineImageSlot[]>
  >({});
  const inboxScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const attachmentScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const replyTextareaRef = useRef<TextareaRenderable | null>(null);
  const replyAttachmentsRef = useRef<InputRenderable | null>(null);
  const composeFromRef = useRef<InputRenderable | null>(null);
  const composeToRef = useRef<InputRenderable | null>(null);
  const composeSubjectRef = useRef<InputRenderable | null>(null);
  const composeAttachmentsRef = useRef<InputRenderable | null>(null);
  const composeBodyRef = useRef<TextareaRenderable | null>(null);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const searchScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const replyDetailsRequestedRef = useRef<Set<string>>(new Set());

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) return emails;

    return emails.filter((email) =>
      [
        email.from,
        email.subject ?? "",
        email.created_at,
        formatDate(email.created_at),
        ...email.to,
        ...(email.cc ?? []),
        ...(email.bcc ?? []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [emails, searchQuery]);

  const selectedEmail = emails[selectedIndex];
  const selectedSearchEmail = searchResults[searchSelectedIndex];
  const selectedDetail = selectedEmail
    ? detailsById[selectedEmail.id]
    : undefined;
  const selectedParentMessageId =
    selectedDetail?.message_id ?? selectedEmail?.message_id;
  const bodyLines = useMemo(
    () => emailBody(selectedDetail).split("\n"),
    [selectedDetail],
  );
  const selectedInlineImages = useMemo(
    () => extractHtmlImages(selectedDetail?.html),
    [selectedDetail?.html],
  );
  const displayLines = useMemo(
    () => bodyDisplayLines(bodyLines, selectedInlineImages),
    [bodyLines, selectedInlineImages],
  );
  const selectedRenderedImages = selectedEmail
    ? (renderedImagesByEmailId[selectedEmail.id] ?? [])
    : [];
  const selectedReplies = useMemo(() => {
    if (!selectedEmail || !selectedDetail) return [];

    const receivedReplies = emails
      .map((email) => detailsById[email.id])
      .filter((detail): detail is EmailDetail => Boolean(detail))
      .filter(
        (detail) =>
          detail.id !== selectedDetail.id &&
          isReplyToEmail(detail, selectedParentMessageId),
      );

    return [
      ...receivedReplies,
      ...(sentRepliesByEmailId[selectedEmail.id] ?? []),
    ].sort(
      (left, right) =>
        new Date(left.created_at).getTime() -
        new Date(right.created_at).getTime(),
    );
  }, [
    detailsById,
    emails,
    selectedDetail,
    selectedEmail,
    selectedParentMessageId,
    sentRepliesByEmailId,
  ]);
  const selectedAttachments = selectedEmail
    ? (attachmentsByEmailId[selectedEmail.id] ??
      selectedDetail?.attachments ??
      selectedEmail.attachments ??
      [])
    : [];
  const selectedAttachment = selectedAttachments[selectedAttachmentIndex];
  const modalOpen =
    attachmentModalOpen ||
    replyModalOpen ||
    composeModalOpen ||
    searchModalOpen;
  const backgroundFg = (color: string): string =>
    modalOpen ? dimHexColor(color) : color;
  const replyToAddress = selectedDetail?.reply_to?.[0] ?? selectedEmail?.from;
  const replySubject = selectedEmail
    ? selectedEmail.subject?.toLowerCase().startsWith("re:")
      ? selectedEmail.subject
      : `Re: ${selectedEmail.subject || "(no subject)"}`
    : "";
  const replyFromAddress =
    process.env.POP_FROM?.trim() || selectedEmail?.to?.[0] || "";

  const notify = useCallback((tone: Notification["tone"], message: string) => {
    setNotification({ id: Date.now(), tone, message });
  }, []);

  const syncSelectedDetailScroll = useCallback(() => {
    const scrollbox = detailScrollRef.current;

    if (!scrollbox) return;

    scrollbox.content.translateY = -scrollbox.scrollTop;
    scrollbox.content.translateX = -scrollbox.scrollLeft;
    scrollbox.requestRender();
  }, []);

  const resetSelectedDetailScroll = useCallback(() => {
    detailScrollRef.current?.scrollTo({ x: 0, y: 0 });
    syncSelectedDetailScroll();
  }, [syncSelectedDetailScroll]);

  useEffect(() => {
    let canceled = false;

    loadSentRepliesCache()
      .then((cache) => {
        if (!canceled) {
          setSentRepliesByEmailId(cache);
        }
      })
      .catch((error: unknown) => {
        if (canceled) return;
        notify(
          "error",
          error instanceof Error
            ? error.message
            : "Failed to load sent replies.",
        );
      });

    return () => {
      canceled = true;
    };
  }, [notify]);

  useEffect(() => {
    if (!notification) return;

    const timeout = setTimeout(() => {
      setNotification((current) =>
        current?.id === notification.id ? null : current,
      );
    }, 3500);

    return () => clearTimeout(timeout);
  }, [notification]);

  useEffect(() => {
    if (state.status !== "loading") return;

    const interval = setInterval(() => {
      setLoaderFrameIndex((index) => (index + 1) % LOADER_FRAMES.length);
    }, 120);

    return () => clearInterval(interval);
  }, [state.status]);

  const refreshInbox = useCallback(async () => {
    setState({ status: "loading", message: "Loading Resend..." });

    try {
      const nextEmails = await listReceivedEmails();

      setEmails(nextEmails);
      setSelectedIndex((index) => {
        if (selectedEmail) {
          const sameEmailIndex = nextEmails.findIndex(
            (email) => email.id === selectedEmail.id,
          );

          if (sameEmailIndex >= 0) {
            return sameEmailIndex;
          }
        }

        return clampIndex(index, nextEmails.length);
      });
      setState({
        status: "ready",
        message: nextEmails.length
          ? `${nextEmails.length} received email${nextEmails.length === 1 ? "" : "s"}`
          : "No received emails found.",
      });
    } catch (error: unknown) {
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to load inbox.",
      });
    }
  }, [selectedEmail]);

  useEffect(() => {
    void refreshInbox();
  }, []);

  useEffect(() => {
    if (!selectedEmail) return;

    queueMicrotask(() => {
      inboxScrollRef.current?.scrollChildIntoView(inboxRowId(selectedEmail.id));
      resetSelectedDetailScroll();
    });
  }, [resetSelectedDetailScroll, selectedEmail?.id]);

  useEffect(() => {
    if (!attachmentModalOpen || !selectedAttachment) return;

    queueMicrotask(() => {
      attachmentScrollRef.current?.scrollChildIntoView(
        attachmentRowId(selectedAttachment.id),
      );
    });
  }, [attachmentModalOpen, selectedAttachment?.id]);

  useEffect(() => {
    if (!searchModalOpen || !selectedSearchEmail) return;

    queueMicrotask(() => {
      searchScrollRef.current?.scrollChildIntoView(
        searchRowId(selectedSearchEmail.id),
      );
    });
  }, [searchModalOpen, selectedSearchEmail?.id]);

  useEffect(() => {
    setAttachmentModalOpen(false);
    setReplyModalOpen(false);
    setComposeModalOpen(false);
    setSearchModalOpen(false);
    setReplyField("body");
    setReplySendState("idle");
    setSelectedAttachmentIndex(0);
    setAttachmentState({ status: "idle", message: "No attachment selected." });
  }, [selectedEmail?.id]);

  useEffect(() => {
    if (!selectedEmail || detailsById[selectedEmail.id]) {
      return;
    }

    let canceled = false;

    getReceivedEmail(selectedEmail.id)
      .then((detail) => {
        if (canceled) return;
        setDetailsById((current) => ({ ...current, [detail.id]: detail }));
      })
      .catch((error: unknown) => {
        if (canceled) return;
        const message =
          error instanceof Error ? error.message : "Failed to load email.";
        setState({ status: "error", message });
      });

    return () => {
      canceled = true;
    };
  }, [detailsById, selectedEmail]);

  useEffect(() => {
    if (!selectedEmail || selectedInlineImages.length === 0) return;
    if (renderedImagesByEmailId[selectedEmail.id]) return;

    let canceled = false;
    const email = selectedEmail;
    const emailId = email.id;

    async function loadImages() {
      try {
        const attachments =
          attachmentsByEmailId[emailId] ??
          selectedDetail?.attachments ??
          email.attachments ??
          [];
        const rendered = (
          await Promise.allSettled(
            selectedInlineImages.map((image) =>
              renderInlineImage(image, attachments),
            ),
          )
        ).map((result) =>
          result.status === "fulfilled" ? result.value : null,
        );

        if (canceled) return;

        setRenderedImagesByEmailId((current) => ({
          ...current,
          [emailId]: rendered,
        }));
      } catch {
        if (!canceled) {
          setRenderedImagesByEmailId((current) => ({
            ...current,
            [emailId]: [],
          }));
        }
      }
    }

    void loadImages();

    return () => {
      canceled = true;
    };
  }, [
    attachmentsByEmailId,
    renderedImagesByEmailId,
    selectedDetail?.attachments,
    selectedEmail,
    selectedInlineImages,
  ]);

  useEffect(() => {
    if (!selectedDetail?.message_id) {
      setRepliesLoading(false);
      return;
    }

    const missingEmails = emails.filter(
      (email) =>
        email.id !== selectedDetail.id &&
        !detailsById[email.id] &&
        !replyDetailsRequestedRef.current.has(email.id),
    );

    if (missingEmails.length === 0) {
      setRepliesLoading(false);
      return;
    }

    let canceled = false;
    for (const email of missingEmails) {
      replyDetailsRequestedRef.current.add(email.id);
    }
    setRepliesLoading(true);

    Promise.allSettled(missingEmails.map((email) => getReceivedEmail(email.id)))
      .then((results) => {
        if (canceled) return;

        const loadedDetails = results
          .filter(
            (result): result is PromiseFulfilledResult<EmailDetail> =>
              result.status === "fulfilled",
          )
          .map((result) => result.value);

        if (loadedDetails.length > 0) {
          setDetailsById((current) => {
            const next = { ...current };

            for (const detail of loadedDetails) {
              next[detail.id] = detail;
            }

            return next;
          });
        }
      })
      .finally(() => {
        if (!canceled) {
          setRepliesLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [detailsById, emails, selectedDetail]);

  const openAttachmentModal = useCallback(async () => {
    if (!selectedEmail) return;

    setReplyModalOpen(false);
    setComposeModalOpen(false);
    setSearchModalOpen(false);
    setAttachmentModalOpen(true);
    setSelectedAttachmentIndex(0);
    setAttachmentState({
      status: "loading",
      message: "Loading attachments...",
    });
    notify("info", "Loading attachments...");

    try {
      const attachments =
        attachmentsByEmailId[selectedEmail.id] ??
        (await listReceivedEmailAttachments(selectedEmail.id));

      setAttachmentsByEmailId((current) => ({
        ...current,
        [selectedEmail.id]: attachments,
      }));
      setAttachmentState({
        status: "ready",
        message: attachments.length
          ? `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`
          : "This email has no attachments.",
      });
      notify(
        attachments.length ? "success" : "info",
        attachments.length
          ? `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} loaded`
          : "No attachments on this email",
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load attachments.";

      setAttachmentState({
        status: "error",
        message,
      });
      notify("error", message);
    }
  }, [attachmentsByEmailId, notify, selectedEmail]);

  const saveReplyDraft = useCallback(() => {
    if (!selectedEmail) return;

    const draft = replyTextareaRef.current?.plainText ?? "";
    const attachmentPaths = selectedEmail
      ? (replyAttachmentsRef.current?.value ??
        replyAttachmentPathsByEmailId[selectedEmail.id] ??
        "")
      : "";

    setReplyDraftsByEmailId((current) => ({
      ...current,
      [selectedEmail.id]: draft,
    }));
    setReplyAttachmentPathsByEmailId((current) => ({
      ...current,
      [selectedEmail.id]: attachmentPaths,
    }));
    if (draft.trim()) {
      notify("success", "Reply draft saved");
    }
  }, [notify, selectedEmail]);

  const openReplyModal = useCallback(() => {
    if (!selectedEmail) return;

    setAttachmentModalOpen(false);
    setComposeModalOpen(false);
    setSearchModalOpen(false);
    setReplyField("body");
    setReplySendState("idle");
    setReplyModalOpen(true);
  }, [selectedEmail]);

  const focusNextReplyField = useCallback(() => {
    setReplyField((field) =>
      field === "attachments" ? "body" : "attachments",
    );
  }, []);

  const focusPreviousReplyField = useCallback(() => {
    setReplyField((field) => (field === "body" ? "attachments" : "body"));
  }, []);

  const sendReplyEmail = useCallback(async () => {
    if (!selectedEmail || !replyToAddress) return;

    const body = replyTextareaRef.current?.plainText.trim() ?? "";
    const attachmentPaths =
      replyAttachmentsRef.current?.value ??
      replyAttachmentPathsByEmailId[selectedEmail.id] ??
      "";
    const trimmedReplyFromAddress = replyFromAddress.trim();

    if (!trimmedReplyFromAddress) {
      notify("error", "Set POP_FROM or select an email with a To address");
      return;
    }

    if (!body) {
      notify("error", "Reply body is required");
      setReplyField("body");
      return;
    }

    setReplySendState("sending");
    notify("info", "Sending reply...");

    try {
      const attachments = await buildOutgoingAttachments(attachmentPaths);
      const replyHeaders = selectedParentMessageId
        ? {
            "In-Reply-To": selectedParentMessageId,
            References: selectedParentMessageId,
          }
        : undefined;
      const response = await sendEmail({
        from: trimmedReplyFromAddress,
        to: [replyToAddress],
        subject: replySubject,
        text: body,
        ...(attachments.length ? { attachments } : {}),
        ...(replyHeaders ? { headers: replyHeaders } : {}),
      });
      const localReply: EmailDetail = {
        id: response.id,
        from: trimmedReplyFromAddress,
        to: [replyToAddress],
        created_at: new Date().toISOString(),
        subject: replySubject,
        text: body,
        headers: replyHeaders,
      };

      const nextSentRepliesCache = {
        ...sentRepliesByEmailId,
        [selectedEmail.id]: [
          ...(sentRepliesByEmailId[selectedEmail.id] ?? []),
          localReply,
        ],
      };
      setSentRepliesByEmailId(nextSentRepliesCache);
      saveSentRepliesCache(nextSentRepliesCache).catch((error: unknown) => {
        notify(
          "error",
          error instanceof Error
            ? error.message
            : "Reply sent, but could not cache it.",
        );
      });
      setReplyDraftsByEmailId((current) => {
        const next = { ...current };
        delete next[selectedEmail.id];
        return next;
      });
      setReplyAttachmentPathsByEmailId((current) => {
        const next = { ...current };
        delete next[selectedEmail.id];
        return next;
      });

      setReplySendState("sent");
      setReplyModalOpen(false);
      notify("success", `Reply sent: ${response.id}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to send reply.";

      setReplySendState("error");
      notify("error", message);
    }
  }, [
    notify,
    replyAttachmentPathsByEmailId,
    replyFromAddress,
    replySubject,
    replyToAddress,
    selectedEmail,
    selectedParentMessageId,
    sentRepliesByEmailId,
  ]);

  const focusNextComposeField = useCallback(() => {
    setComposeField((field) => {
      if (field === "from") return "to";
      if (field === "to") return "subject";
      if (field === "subject") return "body";
      if (field === "body") return "attachments";
      return "from";
    });
  }, []);

  const focusPreviousComposeField = useCallback(() => {
    setComposeField((field) => {
      if (field === "from") return "attachments";
      if (field === "to") return "from";
      if (field === "subject") return "to";
      if (field === "body") return "subject";
      return "body";
    });
  }, []);

  const openComposeModal = useCallback(() => {
    const defaultFrom =
      process.env.POP_FROM?.trim() || selectedEmail?.to?.[0] || "";

    setAttachmentModalOpen(false);
    setReplyModalOpen(false);
    setSearchModalOpen(false);
    setComposeFrom(defaultFrom);
    setComposeTo("");
    setComposeSubject("");
    setComposeAttachmentPaths("");
    setComposeBodySeed("");
    setComposeSendState("idle");
    setComposeField(defaultFrom ? "to" : "from");
    setComposeModalOpen(true);
  }, [selectedEmail]);

  useEffect(() => {
    setSearchSelectedIndex((index) => clampIndex(index, searchResults.length));
  }, [searchResults.length]);

  const openSearchModal = useCallback(() => {
    setAttachmentModalOpen(false);
    setReplyModalOpen(false);
    setComposeModalOpen(false);
    setSearchSelectedIndex(() => {
      const selectedSearchIndex = searchResults.findIndex(
        (email) => email.id === selectedEmail?.id,
      );

      return selectedSearchIndex >= 0 ? selectedSearchIndex : 0;
    });
    setSearchModalOpen(true);
  }, [searchResults, selectedEmail?.id]);

  const selectEmail = useCallback(
    (email: EmailSummary | undefined) => {
      if (!email) return;

      const emailIndex = emails.findIndex((item) => item.id === email.id);

      if (emailIndex >= 0) {
        setSelectedIndex(emailIndex);
      }
    },
    [emails],
  );

  const moveInboxSelection = useCallback(
    (direction: -1 | 1) => {
      if (emails.length === 0) return;

      const nextIndex = clampIndex(selectedIndex + direction, emails.length);

      setSelectedIndex(nextIndex);
    },
    [emails.length, selectedIndex],
  );

  const scrollSelectedDetail = useCallback(
    (delta: number, unit: ScrollUnit = "viewport") => {
      detailScrollRef.current?.scrollBy(delta, unit);
      syncSelectedDetailScroll();
    },
    [syncSelectedDetailScroll],
  );

  const scrollSelectedDetailTo = useCallback(
    (position: number) => {
      detailScrollRef.current?.scrollTo(position);
      syncSelectedDetailScroll();
    },
    [syncSelectedDetailScroll],
  );

  const sendComposedEmail = useCallback(async () => {
    const body = composeBodyRef.current?.plainText.trim() ?? "";
    const to = parseAddressList(composeTo);

    if (!composeFrom.trim()) {
      notify("error", "From address is required");
      setComposeField("from");
      return;
    }

    if (to.length === 0) {
      notify("error", "Recipient is required");
      setComposeField("to");
      return;
    }

    if (!composeSubject.trim()) {
      notify("error", "Subject is required");
      setComposeField("subject");
      return;
    }

    if (!body) {
      notify("error", "Message body is required");
      setComposeField("body");
      return;
    }

    setComposeSendState("sending");
    notify("info", "Sending email...");

    try {
      const attachments = await buildOutgoingAttachments(
        composeAttachmentPaths,
      );
      const response = await sendEmail({
        from: composeFrom.trim(),
        to,
        subject: composeSubject.trim(),
        text: body,
        ...(attachments.length ? { attachments } : {}),
      });

      setComposeSendState("sent");
      setComposeModalOpen(false);
      notify("success", `Email sent: ${response.id}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to send email.";

      setComposeSendState("error");
      notify("error", message);
    }
  }, [composeAttachmentPaths, composeFrom, composeSubject, composeTo, notify]);

  const downloadSelectedAttachment = useCallback(async () => {
    if (!selectedEmail || !selectedAttachment) return;

    setAttachmentState({
      status: "loading",
      message: `Downloading ${selectedAttachment.filename}...`,
    });
    notify("info", `Downloading ${selectedAttachment.filename}...`);

    try {
      const filePath = await downloadAttachmentFile(
        selectedEmail.id,
        selectedAttachment,
      );

      setAttachmentState({
        status: "ready",
        message: `Downloaded to ${filePath}`,
      });
      notify("success", `Downloaded ${selectedAttachment.filename}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to download file.";

      setAttachmentState({
        status: "error",
        message,
      });
      notify("error", message);
    }
  }, [notify, selectedAttachment, selectedEmail]);

  useKeyboard((key) => {
    if (searchModalOpen) {
      if (key.name === "escape") {
        key.preventDefault();
        setSearchModalOpen(false);
        return;
      }

      if (key.name === "return") {
        key.preventDefault();
        selectEmail(searchResults[searchSelectedIndex]);
        setSearchModalOpen(false);
        return;
      }

      if (key.name === "up") {
        key.preventDefault();
        setSearchSelectedIndex((index) =>
          clampIndex(index - 1, searchResults.length),
        );
        return;
      }

      if (key.name === "down") {
        key.preventDefault();
        setSearchSelectedIndex((index) =>
          clampIndex(index + 1, searchResults.length),
        );
        return;
      }

      return;
    }

    if (composeModalOpen) {
      if (key.name === "escape") {
        key.preventDefault();
        setComposeModalOpen(false);
        return;
      }

      if (key.name === "tab" && key.shift) {
        key.preventDefault();
        focusPreviousComposeField();
        return;
      }

      if (key.name === "tab") {
        key.preventDefault();
        focusNextComposeField();
        return;
      }

      if (isSendShortcut(key)) {
        key.preventDefault();
        void sendComposedEmail();
        return;
      }

      return;
    }

    if (replyModalOpen) {
      if (key.name === "escape") {
        key.preventDefault();
        saveReplyDraft();
        setReplyModalOpen(false);
        return;
      }

      if (key.name === "tab" && key.shift) {
        key.preventDefault();
        focusPreviousReplyField();
        return;
      }

      if (key.name === "tab") {
        key.preventDefault();
        focusNextReplyField();
        return;
      }

      if (isSendShortcut(key)) {
        key.preventDefault();
        void sendReplyEmail();
        return;
      }

      return;
    }

    if (attachmentModalOpen) {
      if (key.name === "escape") {
        key.preventDefault();
        setAttachmentModalOpen(false);
        return;
      }

      if (key.name === "up") {
        key.preventDefault();
        setSelectedAttachmentIndex((index) =>
          wrapIndex(index - 1, selectedAttachments.length),
        );
        return;
      }

      if (key.name === "down") {
        key.preventDefault();
        setSelectedAttachmentIndex((index) =>
          wrapIndex(index + 1, selectedAttachments.length),
        );
        return;
      }

      if (key.name === "return" && selectedAttachment) {
        key.preventDefault();
        void downloadSelectedAttachment();
        return;
      }
    }

    if (key.name === "tab") {
      key.preventDefault();
      setActivePane((pane) => (pane === "inbox" ? "detail" : "inbox"));
      return;
    }

    if (key.name === "up") {
      key.preventDefault();

      if (activePane === "detail") {
        scrollSelectedDetail(-1, "absolute");
      } else {
        moveInboxSelection(-1);
      }

      return;
    }

    if (key.name === "down") {
      key.preventDefault();

      if (activePane === "detail") {
        scrollSelectedDetail(1, "absolute");
      } else {
        moveInboxSelection(1);
      }

      return;
    }

    if (key.name === "pageup" || key.name === "k") {
      key.preventDefault();
      scrollSelectedDetail(-0.5);
      return;
    }

    if (key.name === "pagedown" || key.name === "j") {
      key.preventDefault();
      scrollSelectedDetail(0.5);
      return;
    }

    if (key.name === "home" || (key.name === "up" && key.shift)) {
      key.preventDefault();
      scrollSelectedDetailTo(0);
      return;
    }

    if (key.name === "end" || (key.name === "down" && key.shift)) {
      key.preventDefault();
      scrollSelectedDetail(1, "content");
      return;
    }

    if (
      key.name === "q" ||
      key.name === "escape" ||
      (key.ctrl && key.name === "c")
    ) {
      process.exit(0);
    }

    if (key.name === "r") {
      key.preventDefault();
      openReplyModal();
    }

    if ((key.name === "a" || key.name === "i") && selectedEmail) {
      key.preventDefault();
      void openAttachmentModal();
    }

    if (key.name === "n") {
      key.preventDefault();
      openComposeModal();
    }

    if (key.name === "/") {
      key.preventDefault();
      openSearchModal();
    }
  });

  const renderDisplayLine = (line: EmailDisplayLine, lineIndex: number) => {
    if (line.kind === "image") {
      const image = selectedRenderedImages[line.imageIndex];
      const fallback = selectedInlineImages[line.imageIndex];

      if (!image) {
        return (
          <text
            key={`${selectedEmail?.id ?? "email"}-${lineIndex}`}
            fg={backgroundFg("#565f89")}
          >
            [loading image: {fallback?.alt || "image"}]
          </text>
        );
      }

      return (
        <box
          key={`${selectedEmail?.id ?? "email"}-${lineIndex}`}
          marginY={1}
          flexDirection="column"
        >
          {image.lines.map((row, rowIndex) => (
            <text
              key={`${selectedEmail?.id ?? "email"}-${lineIndex}-${rowIndex}`}
              wrapMode="none"
            >
              {row.map((pixel, pixelIndex) => (
                <span
                  key={`${selectedEmail?.id ?? "email"}-${lineIndex}-${rowIndex}-${pixelIndex}`}
                  fg={pixel.top}
                  bg={pixel.bottom}
                >
                  {"▀"}
                </span>
              ))}
            </text>
          ))}
        </box>
      );
    }

    if (line.kind === "link") {
      return (
        <text
          key={`${selectedEmail?.id ?? "email"}-${lineIndex}`}
          fg={backgroundFg("#9ece6a")}
          attributes={4}
          marginTop={lineIndex > 0 ? 1 : 0}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openUrl(line.href);
            notify("success", `Opened ${line.href}`);
          }}
        >
          {line.label}
        </text>
      );
    }

    const text = line.text;
    const matches = [...text.matchAll(URL_PATTERN)];

    if (matches.length === 0) {
      return (
        <text
          key={`${selectedEmail?.id ?? "email"}-${lineIndex}`}
          fg={backgroundFg("#c0caf5")}
          wrapMode="word"
        >
          {text || " "}
        </text>
      );
    }

    const parts: React.ReactNode[] = [];
    let cursor = 0;

    for (const match of matches) {
      const rawUrl = match[0]!;
      const index = match.index ?? 0;
      const url = normalizeUrl(rawUrl);
      const trailing = rawUrl.slice(url.length);

      if (index > cursor) {
        parts.push(text.slice(cursor, index));
      }

      parts.push(
        <text
          key={`${lineIndex}-${index}`}
          fg={backgroundFg("#7dcfff")}
          attributes={4}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openUrl(url);
            notify("success", `Opened ${url}`);
          }}
        >
          {url}
        </text>,
      );

      if (trailing) parts.push(trailing);
      cursor = index + rawUrl.length;
    }

    if (cursor < text.length) parts.push(text.slice(cursor));

    return (
      <box
        key={`${selectedEmail?.id ?? "email"}-${lineIndex}`}
        flexDirection="row"
        flexWrap="wrap"
      >
        {parts.map((part, index) =>
          typeof part === "string" ? (
            <text
              key={`${lineIndex}-text-${index}`}
              fg={backgroundFg("#c0caf5")}
            >
              {part}
            </text>
          ) : (
            part
          ),
        )}
      </box>
    );
  };

  return (
    <box width={"100%"} height={"100%"} flexDirection="row" gap={2}>
      <box
        width={36}
        border
        borderColor={
          activePane === "inbox"
            ? ACTIVE_PANE_BORDER_COLOR
            : INACTIVE_PANE_BORDER_COLOR
        }
        focusedBorderColor={ACTIVE_PANE_BORDER_COLOR}
        paddingX={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box
          height={2}
          flexDirection="column"
          onMouseDown={() => {
            void refreshInbox();
          }}
        >
          <ascii-font
            font="tiny"
            text="Milo"
            marginBottom={1}
            color={backgroundFg("#c0caf5")}
          />
        </box>
        <text
          marginTop={1}
          fg={backgroundFg(state.status === "error" ? "#f7768e" : "#9ece6a")}
          wrapMode="word"
          height={2}
        >
          {state.status === "loading"
            ? `${LOADER_FRAMES[loaderFrameIndex]} ${state.message}`
            : state.message}
        </text>
        <scrollbox
          ref={inboxScrollRef}
          marginTop={0}
          flexGrow={1}
          focused={activePane === "inbox"}
        >
          {emails.map((email) => {
            const selected = email.id === selectedEmail?.id;

            return (
              <box
                key={email.id}
                id={inboxRowId(email.id)}
                width={"100%"}
                paddingLeft={2}
                paddingX={1}
                paddingY={1}
                marginBottom={1}
                backgroundColor={selected ? "#1a1b26" : undefined}
                onMouseDown={() => {
                  setActivePane("inbox");
                  selectEmail(email);
                }}
              >
                <text
                  fg={backgroundFg(selected ? "#c0caf5" : "#a9b1d6")}
                  truncate
                >
                  {email.from}
                </text>
                <text
                  fg={backgroundFg(selected ? "#7aa2f7" : "#565f89")}
                  truncate
                >
                  {email.subject || "(no subject)"}
                </text>
                <text fg={backgroundFg("#565f89")} truncate>
                  {formatDate(email.created_at)}
                </text>
              </box>
            );
          })}
        </scrollbox>
      </box>

      <scrollbox
        ref={detailScrollRef}
        flexGrow={1}
        height={"100%"}
        border
        borderColor={
          activePane === "detail"
            ? ACTIVE_PANE_BORDER_COLOR
            : INACTIVE_PANE_BORDER_COLOR
        }
        focusedBorderColor={ACTIVE_PANE_BORDER_COLOR}
        paddingX={2}
        paddingY={1}
        focused={activePane === "detail"}
        onMouseDown={() => {
          setActivePane("detail");
        }}
        scrollY
        scrollX={false}
        contentOptions={{ flexDirection: "column" }}
      >
        {selectedEmail ? (
          <>
            <text fg={backgroundFg("#7aa2f7")} marginBottom={1} wrapMode="word">
              {selectedEmail.subject || "(no subject)"}
            </text>
            <text fg={backgroundFg("#c0caf5")}>
              From: {selectedDetail?.from ?? selectedEmail.from}
            </text>
            <text fg={backgroundFg("#c0caf5")}>
              To: {formatAddressList(selectedDetail?.to ?? selectedEmail.to)}
            </text>
            <text fg={backgroundFg("#c0caf5")}>
              Cc: {formatAddressList(selectedDetail?.cc ?? selectedEmail.cc)}
            </text>
            <text fg={backgroundFg("#c0caf5")} marginBottom={1}>
              Date: {formatDate(selectedEmail.created_at)}
            </text>
            {selectedAttachments.length > 0 ? (
              <box marginBottom={1} flexDirection="column">
                <text fg={backgroundFg("#9ece6a")}>
                  Attachments: {selectedAttachments.length}
                </text>
                {selectedAttachments.slice(0, 3).map((attachment) => (
                  <text
                    key={attachment.id}
                    fg={backgroundFg("#a9b1d6")}
                    truncate
                  >
                    {attachment.filename} ({formatFileSize(attachment.size)})
                  </text>
                ))}
              </box>
            ) : null}
            <box
              border={["top"]}
              paddingTop={1}
              marginTop={1}
              flexDirection="column"
            >
              {selectedDetail ? (
                displayLines.map((line, index) =>
                  renderDisplayLine(line, index),
                )
              ) : (
                <text fg={backgroundFg("#e0af68")}>
                  Loading selected email...
                </text>
              )}
            </box>
            <box
              border={["top"]}
              paddingTop={1}
              marginTop={1}
              flexDirection="column"
            >
              <text fg={backgroundFg("#7aa2f7")} marginBottom={1}>
                Replies
                {repliesLoading
                  ? " - loading..."
                  : ` (${selectedReplies.length})`}
              </text>
              {selectedReplies.length > 0 ? (
                selectedReplies.map((reply) => {
                  const previewLines = replyPreviewLines(reply);

                  return (
                    <box
                      key={`reply-${reply.id}`}
                      border={["left"]}
                      paddingLeft={1}
                      marginBottom={1}
                      flexDirection="column"
                    >
                      <text fg={backgroundFg("#a9b1d6")} truncate>
                        From: {reply.from}
                      </text>
                      <text fg={backgroundFg("#565f89")} truncate>
                        Date: {formatDate(reply.created_at)}
                      </text>
                      <text fg={backgroundFg("#7aa2f7")} truncate>
                        {reply.subject || "(no subject)"}
                      </text>
                      {previewLines.length > 0 ? (
                        previewLines.map((line, index) => (
                          <text
                            key={`${reply.id}-preview-${index}`}
                            fg={backgroundFg("#c0caf5")}
                            truncate
                          >
                            {line}
                          </text>
                        ))
                      ) : (
                        <text fg={backgroundFg("#565f89")}>
                          No preview available.
                        </text>
                      )}
                    </box>
                  );
                })
              ) : (
                <text fg={backgroundFg("#565f89")}>
                  {repliesLoading
                    ? "Checking this inbox for replies..."
                    : "No replies found in this inbox."}
                </text>
              )}
            </box>
          </>
        ) : (
          <box alignItems="center" justifyContent="center" flexGrow={1}>
            <text fg={backgroundFg("#565f89")}>
              {state.status === "loading"
                ? `${LOADER_FRAMES[loaderFrameIndex]} Loading emails...`
                : "No email selected."}
            </text>
          </box>
        )}
      </scrollbox>
      {attachmentModalOpen ? (
        <box
          position="absolute"
          top={"18%"}
          left={"28%"}
          width={"48%"}
          height={"52%"}
          border
          paddingX={2}
          paddingY={1}
          flexDirection="column"
          backgroundColor="#11111a"
          borderColor="#7aa2f7"
        >
          <text fg="#7aa2f7" marginBottom={1}>
            Attachments
          </text>
          <text
            fg={attachmentState.status === "error" ? "#f7768e" : "#9ece6a"}
            wrapMode="word"
            height={2}
          >
            {attachmentState.message}
          </text>
          <scrollbox
            ref={attachmentScrollRef}
            marginTop={1}
            flexGrow={1}
            focused
          >
            {selectedAttachments.map((attachment, index) => {
              const selected = index === selectedAttachmentIndex;

              return (
                <box
                  key={attachment.id}
                  id={attachmentRowId(attachment.id)}
                  width={"100%"}
                  paddingX={1}
                  paddingY={1}
                  marginBottom={1}
                  backgroundColor={selected ? "#1a1b26" : undefined}
                >
                  <text fg={selected ? "#c0caf5" : "#a9b1d6"} truncate>
                    {attachment.filename}
                  </text>
                  <text fg="#565f89" truncate>
                    {attachment.content_type || "file"} -{" "}
                    {formatFileSize(attachment.size)}
                  </text>
                </box>
              );
            })}
          </scrollbox>
          <text fg="#565f89">Enter downloads - Esc closes</text>
        </box>
      ) : null}
      {replyModalOpen && selectedEmail ? (
        <box
          position="absolute"
          top={"16%"}
          left={"24%"}
          width={"56%"}
          height={"62%"}
          border
          paddingX={2}
          paddingY={1}
          flexDirection="column"
          backgroundColor="#11111a"
          borderColor="#7aa2f7"
        >
          <text fg="#7aa2f7" marginBottom={1}>
            Reply
          </text>
          <text truncate>To: {replyToAddress}</text>
          <text marginBottom={1} truncate>
            Subject: {replySubject}
          </text>
          <box border paddingX={1} paddingY={1} flexGrow={1}>
            <textarea
              ref={replyTextareaRef}
              focused={replyField === "body"}
              initialValue={replyDraftsByEmailId[selectedEmail.id] ?? ""}
              placeholder="Write your reply..."
              backgroundColor="#11111a"
              focusedBackgroundColor="#11111a"
              textColor="#c0caf5"
              focusedTextColor="#c0caf5"
              wrapMode="word"
            />
          </box>
          <box border paddingX={1} height={3} marginTop={1}>
            <input
              ref={replyAttachmentsRef}
              focused={replyField === "attachments"}
              value={replyAttachmentPathsByEmailId[selectedEmail.id] ?? ""}
              placeholder="Attachment paths, comma separated"
              onInput={(value) => {
                setReplyAttachmentPathsByEmailId((current) => ({
                  ...current,
                  [selectedEmail.id]: value,
                }));
              }}
              onSubmit={focusNextReplyField}
            />
          </box>
        </box>
      ) : null}
      {composeModalOpen ? (
        <box
          position="absolute"
          top={"10%"}
          left={"22%"}
          width={"60%"}
          height={"76%"}
          border
          paddingX={2}
          paddingY={1}
          flexDirection="column"
          backgroundColor="#11111a"
          borderColor="#9ece6a"
        >
          <text fg="#9ece6a" marginBottom={1}>
            Compose
          </text>
          <box flexDirection="column" gap={1}>
            <box border paddingX={1} height={3}>
              <input
                ref={composeFromRef}
                focused={composeField === "from"}
                value={composeFrom}
                placeholder="From"
                onInput={setComposeFrom}
                onSubmit={focusNextComposeField}
              />
            </box>
            <box border paddingX={1} height={3}>
              <input
                ref={composeToRef}
                focused={composeField === "to"}
                value={composeTo}
                placeholder="To"
                onInput={setComposeTo}
                onSubmit={focusNextComposeField}
              />
            </box>
            <box border paddingX={1} height={3}>
              <input
                ref={composeSubjectRef}
                focused={composeField === "subject"}
                value={composeSubject}
                placeholder="Subject"
                onInput={setComposeSubject}
                onSubmit={focusNextComposeField}
              />
            </box>
          </box>
          <box border paddingX={1} paddingY={1} marginTop={1} flexGrow={1}>
            <textarea
              ref={composeBodyRef}
              focused={composeField === "body"}
              initialValue={composeBodySeed}
              placeholder="Write your email..."
              backgroundColor="#11111a"
              focusedBackgroundColor="#11111a"
              textColor="#c0caf5"
              focusedTextColor="#c0caf5"
              wrapMode="word"
            />
          </box>
          <box border paddingX={1} height={3} marginTop={1}>
            <input
              ref={composeAttachmentsRef}
              focused={composeField === "attachments"}
              value={composeAttachmentPaths}
              placeholder="Attachment paths, comma separated"
              onInput={setComposeAttachmentPaths}
              onSubmit={focusNextComposeField}
            />
          </box>
        </box>
      ) : null}
      {searchModalOpen ? (
        <box
          position="absolute"
          top={"14%"}
          left={"28%"}
          width={"46%"}
          height={"52%"}
          border
          paddingX={2}
          paddingY={1}
          flexDirection="column"
          backgroundColor="#11111a"
          borderColor="#7aa2f7"
        >
          <text fg="#7aa2f7" marginBottom={1}>
            Search
          </text>
          <box border paddingX={1} height={3}>
            <input
              ref={searchInputRef}
              focused
              value={searchQuery}
              placeholder="Search emails..."
              onInput={(value) => {
                setSearchQuery(value);
                setSearchSelectedIndex(0);
              }}
              onSubmit={() => {
                selectEmail(searchResults[searchSelectedIndex]);
                setSearchModalOpen(false);
              }}
            />
          </box>
          <text fg="#565f89" marginTop={1}>
            {searchResults.length} match{searchResults.length === 1 ? "" : "es"}
          </text>
          <scrollbox ref={searchScrollRef} marginTop={1} flexGrow={1}>
            {searchResults.map((email, index) => {
              const selected = index === searchSelectedIndex;

              return (
                <box
                  key={`search-${email.id}`}
                  id={searchRowId(email.id)}
                  width={"100%"}
                  paddingX={1}
                  paddingY={1}
                  marginBottom={1}
                  backgroundColor={selected ? "#1a1b26" : undefined}
                  onMouseDown={() => {
                    selectEmail(email);
                    setSearchModalOpen(false);
                  }}
                >
                  <text fg={selected ? "#c0caf5" : "#a9b1d6"} truncate>
                    {email.from}
                  </text>
                  <text fg={selected ? "#7aa2f7" : "#565f89"} truncate>
                    {email.subject || "(no subject)"}
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </box>
      ) : null}
      {notification ? (
        <box
          position="absolute"
          right={2}
          bottom={1}
          width={42}
          border
          paddingX={2}
          paddingY={1}
          backgroundColor={notificationBackground(notification.tone)}
          borderColor={notificationForeground(notification.tone)}
        >
          <text
            fg={notificationForeground(notification.tone)}
            bg={notificationBackground(notification.tone)}
            wrapMode="word"
          >
            {notification.message}
          </text>
        </box>
      ) : null}
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
