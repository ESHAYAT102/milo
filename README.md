# Milo

A keyboard-first terminal email client for Resend.

Milo is a TUI inbox for reading received emails, searching through them, downloading attachments, replying, and composing new mail without leaving your terminal.

## Screenshot

![Milo screenshot](./image.png)

## Install

```bash
bun i -g @esyt/milo
```

If you are working from source:

```bash
bun i
bun dev
```

## Setup

Milo uses Resend for inbox access and sending.

```bash
export RESEND_API_KEY="re_..."
export POP_FROM="you@yourdomain.com"
```

`RESEND_API_KEY` is required. `POP_FROM` is used as the sender for compose/reply flows and should be an address or domain verified in Resend.

## Usage

```bash
milo
```

## Features

- Read received emails from Resend.
- Switch between inbox and message panes with `Tab`.
- Use arrow keys in the active pane: inbox selection on the left, message scrolling on the right.
- Scroll the selected email with `j` / `k` or `PageUp` / `PageDown`.
- Click inbox rows with the mouse.
- Search emails with `/`.
- Download received attachments to `~/Downloads`.
- Compose new emails with `n`.
- Reply to selected emails with `r`.
- Send email with `Ctrl-S`.
- Send outgoing attachments from local file paths.
- Refresh the inbox by clicking the Milo logo.
- Quit with `q`, `Esc`, or `Ctrl-C`.

## Keyboard Shortcuts

| Key                     | Action                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `Tab`                   | Switch between inbox and selected email panes                  |
| `Up` / `Down`           | Move through inbox or scroll selected email in the active pane |
| `j` / `k`               | Scroll selected email                                          |
| `PageUp` / `PageDown`   | Scroll selected email faster                                   |
| `Home` / `End`          | Jump to top or bottom of selected email                        |
| `/`                     | Search emails                                                  |
| `Enter`                 | Open highlighted search result or download selected attachment |
| `n`                     | Compose a new email                                            |
| `r`                     | Reply to the selected email                                    |
| `a` or `i`              | Show received attachments                                      |
| `Tab` / `Shift-Tab`     | Move between compose/reply fields                              |
| `Ctrl-S` / `Ctrl-Enter` | Send compose/reply email                                       |
| `q`                     | Quit                                                           |
| `Esc`                   | Close modal or quit                                            |

## Attachments

When composing or replying, add attachments by entering comma-separated local file paths:

```text
~/Downloads/report.pdf, /tmp/screenshot.png
```

Milo reads the files locally, encodes them, and sends them with Resend.
