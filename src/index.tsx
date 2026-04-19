#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { Buffer } from "node:buffer";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InputRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";

const RESEND_API_BASE = "https://api.resend.com";
const INBOX_LIMIT = 50;
const LOADER_FRAMES = ["⡁⠀⢈", "⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹"];

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

function cleanHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function emailBody(email: EmailDetail | undefined): string {
  if (!email) return "";

  if (email.text?.trim()) {
    return email.text.trim();
  }

  if (email.html?.trim()) {
    return cleanHtml(email.html);
  }

  return "This email does not include a text or HTML body.";
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
  const inboxScrollRef = useRef<ScrollBoxRenderable | null>(null);
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
  const bodyLines = useMemo(
    () => emailBody(selectedDetail).split("\n"),
    [selectedDetail],
  );
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
    });
  }, [selectedEmail?.id]);

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

    if (!replyFromAddress.trim()) {
      notify(
        "error",
        "Set POP_FROM or select an email with a To address",
      );
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
      const response = await sendEmail({
        from: replyFromAddress,
        to: [replyToAddress],
        subject: replySubject,
        text: body,
        ...(attachments.length ? { attachments } : {}),
        ...(selectedEmail.message_id
          ? {
              headers: {
                "In-Reply-To": selectedEmail.message_id,
                References: selectedEmail.message_id,
              },
            }
          : {}),
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

      const nextIndex = clampIndex(
        selectedIndex + direction,
        emails.length,
      );

      setSelectedIndex(nextIndex);
    },
    [emails.length, selectedIndex],
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

    if (
      key.name === "q" ||
      key.name === "escape" ||
      (key.ctrl && key.name === "c")
    ) {
      process.exit(0);
    }

    if (key.name === "up") {
      key.preventDefault();
      moveInboxSelection(-1);
    }

    if (key.name === "down") {
      key.preventDefault();
      moveInboxSelection(1);
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

  return (
    <box
      width={"100%"}
      height={"100%"}
      flexDirection="row"
      gap={2}
      backgroundColor={modalOpen ? "#08080d" : undefined}
    >
      <box
        width={36}
        border
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        backgroundColor={modalOpen ? "#0d0d14" : undefined}
      >
        <box
          onMouseDown={() => {
            void refreshInbox();
          }}
        >
          <ascii-font font="tiny" text="Milo" />
        </box>
        <text
          marginTop={2}
          fg={state.status === "error" ? "#f7768e" : "#9ece6a"}
          wrapMode="word"
          height={2}
        >
          {state.status === "loading"
            ? `${LOADER_FRAMES[loaderFrameIndex]} ${state.message}`
            : state.message}
        </text>
        <scrollbox ref={inboxScrollRef} marginTop={1} flexGrow={1} focused>
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
                  selectEmail(email);
                }}
              >
                <text fg={selected ? "#c0caf5" : "#a9b1d6"} truncate>
                  {email.from}
                </text>
                <text fg={selected ? "#7aa2f7" : "#565f89"} truncate>
                  {email.subject || "(no subject)"}
                </text>
                <text fg="#565f89" truncate>
                  {formatDate(email.created_at)}
                </text>
              </box>
            );
          })}
        </scrollbox>
      </box>

      <box
        flexGrow={1}
        border
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        backgroundColor={modalOpen ? "#0d0d14" : undefined}
      >
        {selectedEmail ? (
          <>
            <text fg="#7aa2f7" marginBottom={1} wrapMode="word">
              {selectedEmail.subject || "(no subject)"}
            </text>
            <text>From: {selectedDetail?.from ?? selectedEmail.from}</text>
            <text>
              To: {formatAddressList(selectedDetail?.to ?? selectedEmail.to)}
            </text>
            <text>
              Cc: {formatAddressList(selectedDetail?.cc ?? selectedEmail.cc)}
            </text>
            <text marginBottom={1}>
              Date: {formatDate(selectedEmail.created_at)}
            </text>
            {selectedAttachments.length > 0 ? (
              <box marginBottom={1} flexDirection="column">
                <text fg="#9ece6a">
                  Attachments: {selectedAttachments.length}
                </text>
                {selectedAttachments.slice(0, 3).map((attachment) => (
                  <text key={attachment.id} fg="#a9b1d6" truncate>
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
                bodyLines.map((line, index) => (
                  <text key={`${selectedEmail.id}-${index}`}>
                    {line || " "}
                  </text>
                ))
              ) : (
                <text fg="#e0af68">Loading selected email...</text>
              )}
            </box>
          </>
        ) : (
          <box alignItems="center" justifyContent="center" flexGrow={1}>
            <text fg="#565f89">
              {state.status === "loading"
                ? `${LOADER_FRAMES[loaderFrameIndex]} Loading emails...`
                : "No email selected."}
            </text>
          </box>
        )}
      </box>
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
          backgroundColor="#11111a"
          borderColor={
            notification.tone === "error"
              ? "#f7768e"
              : notification.tone === "success"
                ? "#9ece6a"
                : "#7aa2f7"
          }
        >
          <text
            fg={
              notification.tone === "error"
                ? "#f7768e"
                : notification.tone === "success"
                  ? "#9ece6a"
                  : "#7aa2f7"
            }
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
