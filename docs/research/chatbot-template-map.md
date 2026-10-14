# chatbot-template map — what to copy, rewrite, drop for slopcad

Research on `github.com/shadcn-ui/chatbot-template` (clone at `/tmp/chatbot-template`, MIT).
Template stack: Next.js 16.3.6 + Vercel AI SDK v7 (`ai` + `@ai-sdk/react`) + shadcn "base-rhea"
style on **Base UI** (not Radix) + Tailwind v4. Target: TanStack Start + TanStack AI, components
destined for a shadcn-style registry. All paths below are relative to the template root unless
prefixed. Verified by reading every significant file; nothing guessed.

## 1. Architecture overview

Flat Next.js App Router app, no src/ dir, no database, no hooks (hooks/ and public/ are empty
`.gitkeep`). State lives entirely client-side in `useChat`.

| Path                                                                      | Purpose                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/layout.tsx`                                                          | Root layout: Geist fonts, `next-themes` ThemeProvider, SiteHeader.                                                                                                                                                   |
| `app/page.tsx`                                                            | Server component; renders `<Chat models={MODELS} />`. Whole app is one page.                                                                                                                                         |
| `app/api/chat/route.ts`                                                   | The only server route: POST handler, `streamText` + UI message stream response.                                                                                                                                      |
| `app/globals.css`                                                         | Tailwind v4 entry; imports `shadcn/tailwind.css` (ships `shimmer`, `scroll-fade-b`, `scrollbar-thin`, `data-autoscrolling:` variants) and `typeset.css`; theme tokens inline.                                        |
| `app/typeset.css`                                                         | 490 lines of shadcn/typeset markdown typography (`.typeset-docs` scope).                                                                                                                                             |
| `components/chat.tsx`                                                     | Client orchestrator: `useChat`, model state, empty state, scroller, error alert, wiring of all children.                                                                                                             |
| `components/chat-message.tsx`                                             | Role split (user bubble vs assistant part list) + `mergeTextParts`; switches on `part.type`.                                                                                                                         |
| `components/parts/`                                                       | One renderer per message part type (text, sources, web_search, github_repo, ask_user).                                                                                                                               |
| `components/prompt-form.tsx`                                              | Composer: textarea + model select + send/stop button. Pure props/callbacks.                                                                                                                                          |
| `components/question-card.tsx`                                            | Sticky-bottom questionnaire fed by pending `tool-ask_user` part.                                                                                                                                                     |
| `components/questionnaire-note`                                           | — (see `components/ui/questionnaire.tsx`, the real widget).                                                                                                                                                          |
| `components/suggestions.tsx`                                              | Empty-state prompt chips (hardcoded demo content).                                                                                                                                                                   |
| `components/model-select.tsx`                                             | Base UI Select over the model list.                                                                                                                                                                                  |
| `components/markdown-code.tsx`                                            | react-markdown wiring + react-shiki highlighter, copy button, `MarkdownPre` unwrap.                                                                                                                                  |
| `components/site-header.tsx`, `new-chat-button.tsx`, `theme-provider.tsx` | App chrome, not chat.                                                                                                                                                                                                |
| `components/ui/`                                                          | 15 shadcn primitives, base-rhea style: `message`, `bubble`, `message-scroller`, `questionnaire`, `input-group`, `drawer`, `item`, `empty`, `select`, `button`, `alert`, `spinner`, `input`, `textarea`, `separator`. |
| `lib/models.ts`                                                           | Hardcoded gateway model list + `isModelAllowed` + `DEFAULT_MODEL`.                                                                                                                                                   |
| `lib/utils.ts`                                                            | `cn` re-export from the `cn` package + `safeHttpUrl()` sanitizer.                                                                                                                                                    |
| `tools/`                                                                  | One file per tool; `index.ts` composes `getTools(modelId)` and derives all `ChatUIMessage` types via `InferUITools`.                                                                                                 |

Dependencies (`package.json`): `ai` ^7.0.118, `@ai-sdk/react` ^4.0.121, `@ai-sdk/anthropic`
^4.0.65, `@ai-sdk/openai` ^4.0.78, `@ai-sdk/gateway` ^4.0.96, `@shadcn/react` ^0.3.1 (message-scroller),
`@base-ui/react` ^1.8.0, `class-variance-authority` ^0.7.1, `cn` ^0.4.0, `lucide-react` ^1.48.0,
`next` 16.3.6, `next-themes` ^0.4.6, `react`/`react-dom` 19.3.0, `react-markdown` ^10.1.0,
`react-shiki` ^0.11.1, `remark-gfm` ^4.0.1, `tw-animate-css` ^1.4.0, `zod` ^4.6.5.
Dev: `tailwindcss` ^4, `@tailwindcss/postcss` ^4, `shadcn` ^4.21.0, prettier (+tailwind plugin), eslint.

## 2. Chat UI component inventory

| Component                               | Renders                                                                                                         | Props                                                                | Coupling                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `components/chat.tsx`                   | Whole conversation + empty state + error alert + composer mount                                                 | `{ models: GatewayModel[] }`                                         | Coupled: `useChat` from `@ai-sdk/react`, `lastAssistantMessageIsCompleteWithToolCalls` from `ai`, `ChatUIMessage` |
| `components/chat-message.tsx`           | User bubble or assistant part list; merges adjacent text parts                                                  | `{ message: ChatUIMessage; isStreaming?: boolean }`                  | Coupled by types only (`ChatMessagePart` from `tools/index.ts` → AI SDK `UIMessage`)                              |
| `components/prompt-form.tsx`            | Composer: textarea, model select, send/stop morph button                                                        | `{ models, model, onModelChange, isBusy, onSubmit(text), onStop() }` | Pure — zero AI SDK imports                                                                                        |
| `components/model-select.tsx`           | Select inside composer footer                                                                                   | `{ models, value, onValueChange }`                                   | Pure (typed on `GatewayModel`)                                                                                    |
| `components/suggestions.tsx`            | 4 outline-button prompt chips                                                                                   | `{ onSelect(prompt) }`                                               | Pure, but content hardcoded                                                                                       |
| `components/question-card.tsx`          | Sticky-bottom Q&A card with progress, choices, free-text fallback                                               | `{ part: AskUserToolPart; onAnswer(toolCallId, answers) }`           | Coupled: `part.state`, `part.input/output` shape                                                                  |
| `components/parts/text-part.tsx`        | Markdown via react-markdown + typeset                                                                           | `{ part: TextMessagePart }`                                          | Type-only                                                                                                         |
| `components/parts/sources-part.tsx`     | "Searched N websites" link-button → bottom drawer of deduped source items                                       | `{ parts: ChatMessagePart[] }`                                       | Type-only (`source-url` part); logic (dedupe, sanitize) portable                                                  |
| `components/parts/web-search-part.tsx`  | Status line: "Searching the web for X…" → "Searched the web for X"; error state                                 | `{ part: WebSearchToolPart }`                                        | Coupled: switches on `part.state` AI SDK state machine                                                            |
| `components/parts/github-repo-part.tsx` | Spinner "Looking up repo…" → stat line (stars/forks/language) or error                                          | `{ part: GithubRepoToolPart }`                                       | Coupled: same state machine                                                                                       |
| `components/parts/ask-user-part.tsx`    | Answered Q&A as ordered list (hidden while pending — the card handles that)                                     | `{ part: AskUserToolPart }`                                          | Coupled: `output-available` state                                                                                 |
| `components/ui/message.tsx`             | `Message/MessageGroup/MessageContent/Header/Footer/Avatar` layout shell                                         | `align: "start"\|"end"` + div props                                  | Pure                                                                                                              |
| `components/ui/bubble.tsx`              | Chat bubble, 7 cva variants, reactions slot; `BubbleContent` uses Base UI `useRender`                           | `variant`, `align`, `render`                                         | Pure but **Base UI** (`mergeProps`, `useRender`)                                                                  |
| `components/ui/message-scroller.tsx`    | Thin wrapper over `@shadcn/react/message-scroller`: Provider/Root/Viewport/Content/Item/Button + 3 hooks        | passthrough + `scrollAnchor`                                         | Pure; dependency `@shadcn/react` is framework-agnostic                                                            |
| `components/ui/questionnaire.tsx`       | 327-line multi-step questionnaire: progress, radio choices, free-text input, error, prev/next/submit            | compound components, items config                                    | Pure (only needs `buttonVariants`)                                                                                |
| `components/ui/input-group.tsx`         | Composer container: textarea + addon row + icon buttons                                                         | compound                                                             | Pure                                                                                                              |
| `components/markdown-code.tsx`          | Fenced code: shiki highlight, language label, copy button                                                       | react-markdown `code`/`pre` overrides                                | `useTheme` from `next-themes` (small edit)                                                                        |
| Streaming states                        | "Thinking…" shimmer row in `chat.tsx` (status === "submitted"); per-part spinners; `error` Alert above composer | —                                                                    | Coupled to `useChat` status enum                                                                                  |

No retry button, no file/image attachments, no reasoning/thinking part renderer, no artifacts,
no message actions (copy/edit/regenerate) anywhere in the template.

## 3. Server side

One route: `app/api/chat/route.ts` (POST).

- **Provider**: model is a raw gateway id string (`"anthropic/claude-sonnet-5"`) passed straight
  as `streamText({ model: modelId })` — the Vercel AI Gateway convention (`@ai-sdk/gateway` dep +
  `AI_GATEWAY_API_KEY` in `.env.example`; OIDC auto-auth on Vercel per `README.md`).
- **Model selection**: client sends `model` in the request body (`sendMessage(..., { body: { model } })`
  in `components/chat.tsx`); server allowlists it against `lib/models.ts` via `isModelAllowed`,
  falling back to `DEFAULT_MODEL`.
- **System prompt**: none. Grep for `system` over app/components/lib/tools returns zero hits.
- **Validation**: `validateUIMessages<ChatUIMessage>` with the tool map before trusting the body;
  400 on bad JSON/messages.
- **Tools** (`tools/`): `github_repo` executes server-side (GitHub REST fetch, 5s AbortSignal
  timeout combined with request abort); `ask_user` has **no execute** — human-in-the-loop, output
  supplied from the client via `addToolOutput`, auto-resumed with
  `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`; `web_search` is
  provider-native (`openai.tools.webSearch()` / `anthropic.tools.webSearch_20260209()`), chosen by
  model-id prefix in `tools/web_search.ts`. Tool name = filename (`tools/index.ts`).
- **Generation caps**: `stopWhen: isStepCount(5)`, `maxOutputTokens: 8192`,
  `maxDuration = 30`, `abortSignal: req.signal` (client disconnect cancels generation).
- **Transport**: AI SDK **UI Message Stream** (SSE data-stream protocol) via
  `createUIMessageStreamResponse(toUIMessageStream({ stream, sendSources: true, onError → scrubbed message }))`.
- **Persistence**: none — no DB, no localStorage, no conversation resume. History is client
  memory only.

## 4. Coupling classification

| File                                                                                                                      | Class             | Reason / action                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ui/message.tsx`                                                                                               | PORTABLE          | Pure layout, Tailwind tokens only.                                                                                                                                      |
| `components/ui/bubble.tsx`                                                                                                | PORTABLE*         | Pure UI; uses Base UI `mergeProps`/`useRender` — swap or keep if slopcad ships Base UI.                                                                                 |
| `components/ui/spinner.tsx`                                                                                               | PORTABLE          | Trivial.                                                                                                                                                                |
| `components/ui/questionnaire.tsx`                                                                                         | PORTABLE          | Self-contained (only `buttonVariants` + lucide). Highest-value single file.                                                                                             |
| `components/ui/input-group.tsx`, `alert`, `empty`, `item`, `select`, `button`, `drawer`, `textarea`, `input`, `separator` | PORTABLE*         | Stock shadcn base-rhea primitives — prefer slopcad's existing `packages/ui` equivalents; copy only gaps.                                                                |
| `components/ui/message-scroller.tsx`                                                                                      | PORTABLE*         | Wrapper over `@shadcn/react` package; portable if we add that dep (framework-agnostic).                                                                                 |
| `components/prompt-form.tsx`                                                                                              | PORTABLE          | Callback-driven, zero AI SDK imports.                                                                                                                                   |
| `components/model-select.tsx`                                                                                             | PORTABLE          | Swap `GatewayModel` type.                                                                                                                                               |
| `components/suggestions.tsx`                                                                                              | PORTABLE*         | Keep pattern; delete demo content.                                                                                                                                      |
| `components/markdown-code.tsx`                                                                                            | PORTABLE*         | Replace `next-themes` `useTheme` with slopcad's theme hook.                                                                                                             |
| `lib/utils.ts`                                                                                                            | PORTABLE          | `safeHttpUrl` is a keeper; `cn` should re-export slopcad's.                                                                                                             |
| `app/typeset.css`                                                                                                         | PORTABLE          | shadcn/typeset typography asset.                                                                                                                                        |
| `components/chat-message.tsx`                                                                                             | TRANSPORT-COUPLED | Switches on AI SDK `part.type` strings; logic maps 1:1, types don't.                                                                                                    |
| `components/parts/*` (all 5)                                                                                              | TRANSPORT-COUPLED | Switch on AI SDK part state machine (`input-streaming`/`input-available`/`output-available`/`output-error`) and typed `input`/`output`; rendering is the portable part. |
| `components/question-card.tsx`                                                                                            | TRANSPORT-COUPLED | Reads pending tool part state + shape.                                                                                                                                  |
| `components/chat.tsx`                                                                                                     | TRANSPORT-COUPLED | `useChat`, `addToolOutput`, `sendAutomaticallyWhen`, status enum — rewrite around TanStack AI's chat state.                                                             |
| `tools/index.ts`                                                                                                          | TRANSPORT-COUPLED | `InferUITools`/`UIMessage` type derivation.                                                                                                                             |
| `tools/ask_user.ts`, `tools/github_repo.ts`                                                                               | TRANSPORT-COUPLED | `tool()` from `ai`; zod schemas + execute bodies port to TanStack AI tool defs.                                                                                         |
| `tools/web_search.ts`                                                                                                     | DROP              | Provider-native AI SDK tool objects; TanStack AI equivalent differs entirely.                                                                                           |
| `app/api/chat/route.ts`                                                                                                   | SERVER-COUPLED    | Next route handler; rewrite as TanStack Start server route/tRPC, keep the validation + caps + abort pattern.                                                            |
| `app/layout.tsx`, `app/page.tsx`, `components/site-header.tsx`, `new-chat-button.tsx`, `theme-provider.tsx`               | DROP              | Next-specific app chrome; slopcad has its own shell/theming.                                                                                                            |
| `lib/models.ts`                                                                                                           | DROP (content)    | Mechanism (allowlist + default) is 8 lines; the ids are hardcoded gateway ids.                                                                                          |
| `app/globals.css`                                                                                                         | DROP              | Template token sheet; slopcad has its own. But note its `@import "shadcn/tailwind.css"` supplies utilities the components depend on.                                    |

## 5. Copy candidates (registry-style set)

A chat registry package would contain, in dependency order:

1. `ui/message.tsx` — verbatim; point `cn` at `@slopcad/ui`'s util.
2. `ui/bubble.tsx` — verbatim if Base UI is acceptable; else replace `useRender`/`mergeProps`
   (only used by `BubbleContent`) with a plain `div` + `asChild`-style slot from slopcad's stack.
3. `ui/spinner.tsx` — verbatim.
4. `ui/questionnaire.tsx` — verbatim minus `buttonVariants` import path; its only external deps
   are React, lucide, cva.
5. `ui/message-scroller.tsx` — add `@shadcn/react` (peer of the template's message-scroller
   primitive); keep the wrapper's Tailwind (`scrollbar-thin`, `scroll-fade-b`,
   `data-autoscrolling:`) — confirm those utilities exist in slopcad's CSS entry or vendor the
   handful from `shadcn/tailwind.css`.
6. `prompt-form.tsx` — verbatim; it is already registry-clean (callbacks only).
7. `model-select.tsx` — verbatim after redefining the models type.
8. `parts/text-part.tsx` + `markdown-code.tsx` — copy together; swap `next-themes` useTheme for
   slopcad's; keep `MarkdownPre` unwrap trick.
9. `chat-message.tsx`, `parts/*`, `question-card.tsx` — copy as **patterns**, retyping `part`
   props against TanStack AI message part types; the state-machine switches need TanStack AI's
   equivalent states mapped before the paste compiles.
10. `lib/utils.ts#safeHttpUrl` — lift into shared utils.

Assumptions to verify per file: `@/*` path alias (template tsconfig maps `@/*` → repo root),
`cn` from `@/lib/utils` (template re-exports the `cn` npm package, slopcad likely has its own),
Base UI vs Radix (template is Base UI everywhere: `button`, `select`, `drawer`), Tailwind v4
CSS-first config, and the `shadcn/tailwind.css` utility layer (`shimmer`, `scroll-fade-b`).

## 6. Defaults & hardcoding audit — do NOT port

- `lib/models.ts` — model ids `"anthropic/claude-sonnet-5"`, `"openai/gpt-5.6-terra"`;
  `DEFAULT_MODEL = MODELS[0].id`. Model list must come from slopcad config, not a const array.
- `app/api/chat/route.ts` — Vercel AI Gateway implicit provider (bare model string as `model:`),
  `MAX_OUTPUT_TOKENS = 8192`, `isStepCount(5)`, `maxDuration = 30`, scrubbed
  `onError: "Something went wrong. Please try again."`, and the comment documenting that the
  route is public/unauthenticated (slopcad has Better Auth — route must not be public).
- `tools/web_search.ts` — provider prefix switches `modelId.startsWith("openai/")` /
  `startsWith("anthropic/")` and the dated `anthropic.tools.webSearch_20260209()` API pin.
- `.env.example` — `AI_GATEWAY_API_KEY` (gateway credential assumption).
- `components/chat.tsx` — vendor copy in the UI: empty-state description "Responses stream
  through the Vercel AI Gateway."; "Thinking…" placeholder text.
- `components/suggestions.tsx` — four demo prompts (story, Next.js release, vercel/next.js stats,
  dinner plan) tied to the demo tools.
- `components/markdown-code.tsx` — shiki themes pinned to `"github-dark"`/`"github-light"` and a
  hardcoded `bg-[oklch(0.985_0_0)]` code background.
- `app/globals.css` — `.typeset-docs` pins `--typeset-size: 15px`, leading 1.75 (design choice,
  not a default to inherit blindly).

## 7. UI/UX ideas worth keeping

- **Typed part-switch rendering** (`chat-message.tsx`): an assistant message renders as a vertical
  stack of typed parts; one component per `part.type`, keyed by `toolCallId`. Unknown parts render
  `null`. Adding a tool = new part component + one `case`. A designer can reproduce this as
  "message = ordered list of self-contained blocks".
- **Tool progress as a status line that becomes history** (`web-search-part.tsx`,
  `github-repo-part.tsx`): while running, a muted icon + "Searching the web for '…'…" line with a
  spinner; on completion the same line flips to past tense ("Searched the web…") and stays inline —
  the conversation keeps a compact audit trail instead of a modal spinner.
- **Human-in-the-loop questionnaire** (`question-card.tsx` + `ui/questionnaire.tsx`): when the
  model needs clarification, a rounded card pins (`sticky bottom-2`) above the composer showing
  numbered questions, each with exactly three choice chips plus a free-text "Type another answer…"
  input, multi-question progress bar, prev/next, and an "Answer" submit. While inputs stream in it
  shows a shimmer "Preparing a question…". After answering, the card disappears and the Q&A is
  committed into the message as a muted question / bold answer ordered list (`ask-user-part.tsx`),
  and the chat auto-continues.
- **Deferred sources drawer** (`sources-part.tsx`): citations are stripped from the text flow and
  collected into one "Searched N websites" link under the finished message (only rendered once
  streaming completes), opening a bottom drawer of hostname-titled link rows with external-link
  glyphs; URLs deduped and passed through `safeHttpUrl` so model output can't inject `javascript:`.
- **Empty state as the composer's lobby** (`chat.tsx` + `suggestions.tsx`): centered "What can I
  help with?" heading with 3-4 outline suggestion chips that dispatch a full prompt on click.
- **Submitted-state shimmer row** (`chat.tsx`): between "sent" and "first token", a standalone
  scroller row shows a shimmering "Thinking…" instead of an empty gap.
- **Scroll ergonomics** (`ui/message-scroller.tsx`, `chat.tsx`): each user message is the scroll
  anchor; items use `content-visibility: auto` for long-thread perf; a floating scroll-to-end
  button fades/scales in only when scrolled away, with `scroll-fade-b` mask at the viewport bottom.
- **Composer micro-behavior** (`prompt-form.tsx`): Enter sends, Shift+Enter newlines, IME
  composition guarded (`isComposing`); one button that morphs ArrowUp "Send" ↔ Square "Stop
  generating" with `aria-label`s; model picker embedded in the composer's footer row (config lives
  where you type, not in a header); request errors surface as a destructive Alert directly above
  the composer.
- **Typography** (`app/typeset.css`, `text-part.tsx`): assistant markdown rendered inside a
  `.typeset.typeset-docs` scope (15px/1.75 prose scale) while chrome stays UI-sized; fenced code
  gets a language label and ghost copy button overlaid on the highlighter, with nested `<pre>`
  unwrapped.

---

## Addendum (2026-10-04, post adversarial review — finding M1 of `plan-adversarial-review.md`)

Sections 4 and 5 above are STALE for five files. This repo's `packages/ui/src/components/`
ALREADY ships the template's own `message.tsx`, `bubble.tsx`, `message-scroller.tsx`,
`input-group.tsx`, and `empty.tsx` (same lineage — initial-commit era, diffs are import
paths + minor style drift), and `@base-ui/react` + `@shadcn/react` are already
`packages/ui` dependencies. Consequences:

- The "Replace Base UI usages with packages/ui equivalents" instruction was wrong —
  `packages/ui` IS Base UI-based. Nothing to replace.
- Reclassify those five files from PORTABLE to **REUSE (already in repo)** — do not
  port a second copy.
- The genuine gaps remain: `ui/spinner.tsx`, `prompt-form.tsx` (note: imports
  `ModelSelect`/`GatewayModel` — adaptation required), `app/typeset.css`,
  `lib/utils.ts#safeHttpUrl`, and optionally `ui/questionnaire.tsx`.
- `@shadcn/react` subpath imports (`/message-scroller`) already resolve inside
  `packages/ui`; apps-level code should use the `@slopcad/ui` re-exports rather than
  importing the subpath directly.
