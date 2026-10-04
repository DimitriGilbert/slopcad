/**
 * The text part renderer (PLAN-AGENT-CHAT Phase 4.3): assistant markdown in
 * the chatbot template's typography contract — content renders inside the
 * Phase 4.1 `.typeset` scope (the vendored shadcn/typeset stylesheet; the
 * template's 15px docs pin rides the scope's own `--typeset-size` variable
 * rather than the dropped `.typeset-docs` class) while chat chrome stays
 * UI-sized, and GFM tables/strikethrough/task lists/autolinks are on via
 * `remark-gfm`.
 *
 * Fenced code blocks are rebuilt from the `pre` override (react-markdown v10
 * hands the override the already-rendered `<code>` element, so the block is
 * re-assembled with a language label and a copy button — no syntax
 * highlighter dependency; the label + copy affordance is the requirement,
 * and theme tokens color the surface). This file is the shadcn chatbot
 * template's `text-part.tsx` + `markdown-code.tsx` pair, retyped onto the
 * TanStack AI part model.
 */

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@slopcad/ui/components/button";
import type { AgentChatMessagePart } from "./part-types";

/** Concatenates an element tree's text content (the code string to display/copy). */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return Children.toArray(node)
    .map((child) => nodeText(child))
    .join("");
}

/** Reads the fenced block's language off a `language-*` class list. */
function languageOfClass(className: string | undefined): string | null {
  const match = /language-([\w-]+)/u.exec(className ?? "");
  return match === null ? null : (match[1] ?? null);
}

function CopyCodeButton({ code }: { code: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // The clipboard is unavailable in some contexts; the copy affordance
      // simply does nothing rather than reporting a failure the user cannot
      // act on.
    }
  }, [code]);

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy code"}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        void onCopy();
      }}
    >
      <Icon aria-hidden="true" className="size-3" />
    </Button>
  );
}

/** One fenced code block: label + copy affordance over a scrollable plain `<pre>`. */
function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string | null;
}): ReactElement {
  return (
    <div className="not-typeset relative mt-[1.25em] w-full max-w-full overflow-hidden rounded-sm border border-border bg-card">
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border/60 pl-2 pr-1">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {language ?? ""}
        </span>
        <CopyCodeButton code={code} />
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * The `pre` override: react-markdown wraps fenced blocks in
 * `pre > code(this file's code override)`, so the rendered `<code>` element
 * is rebuilt here as the labeled block — avoiding a nested `<pre>`.
 */
function MarkdownPre({ children }: { children?: ReactNode }): ReactNode {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const language = languageOfClass(child.props.className);
    const code = nodeText(child.props.children).replace(/\n$/, "");
    return <MarkdownCodeBlock code={code} language={language} />;
  }
  return <>{children}</>;
}

/** The `code` override: inline code passes through (the `pre` override rebuilds blocks). */
function MarkdownCode({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code">): ReactNode {
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

/** Renders one text part as markdown (GFM) inside the typeset scope. */
export function AgentTextPart({
  part,
}: {
  part: Extract<AgentChatMessagePart, { type: "text" }>;
}): ReactElement | null {
  if (part.content.trim().length === 0) return null;
  return (
    <div className="typeset px-1.5 [--typeset-size:0.9375rem]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ code: MarkdownCode, pre: MarkdownPre }}
      >
        {part.content}
      </ReactMarkdown>
    </div>
  );
}
