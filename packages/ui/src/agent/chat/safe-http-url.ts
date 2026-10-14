/**
 * Ported from shadcn-ui/chatbot-template (`lib/utils.ts#safeHttpUrl`), MIT
 * License — Copyright (c) 2026 shadcn,
 * https://github.com/shadcn-ui/chatbot-template.
 *
 * Unmodified. Guards URLs that originate from model output before they are
 * rendered as links: only http(s) URLs pass, so `javascript:`-style injection
 * through streamed text is refused with `undefined`.
 */

export function safeHttpUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
