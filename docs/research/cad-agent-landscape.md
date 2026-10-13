# CAD AI Agent Landscape (research, October 2026)

Context: slopcad is adding an in-app AI agent with full access to every CAD command, multi-angle
image feedback of the current model, BYOK multi-provider LLM calls, user-editable system prompt,
and reasoning-effort control. This doc defines the competitive bar (what shipped across the
industry by late 2026) and the open edges slopcad can own.

All claims carry a citation. Items marked **[unverified]** rest on a single or secondary source
and could not be confirmed from primary material.

---

## Executive summary

- Every major CAD vendor now ships an AI assistant, but almost none of them are true agents over
  geometry yet. The shipped reality in late 2026 is: (1) blind Q&A copilots with citations
  (Onshape AI Advisor), (2) one-click AI automation of specific chores — constraints
  (Fusion AutoConstrain), drawings (Fusion, SOLIDWORKS LEO), rendering/objects (SketchUp) — and
  (3) newly, agentic parametric editing reached via code: PTC's FeatureScript MCP Server (May 2026)
  and Autodesk's Inventor Assistant driving APIs/iLogic (announced AU 2026).
- The industry converged on **code-first agentic CAD**: the agent writes the tool's parametric
  language (FeatureScript, KCL, iLogic, Python) and the kernel executes it. Fabbaloo's June 2026
  assessment: text-to-CAD is "getting more real, but it's not there yet" — the AI writes a CAD
  script, then geometry is validated (https://www.fabbaloo.com/blog/2026/6/26/text-to-cad-is-getting-more-real-but-its-not-there-yet).
- **Vision feedback is nearly absent in vendor products.** The viewport-screenshot feedback loop
  is proven in the open-source Blender MCP ecosystem (agent captures the viewport after each edit)
  but no major CAD vendor documents their assistant looking at renders. Onshape's shipped advisor
  explicitly advertises "cannot see your data."
- **BYOK is essentially unheard of in first-party CAD assistants.** Vendors are single-provider,
  vendor-hosted (Onshape on Amazon Bedrock; SketchUp on a credit system). The only BYO-model path
  today is MCP: connect your own Claude/ChatGPT/Gemini client to the vendor's server.
- Who is furthest ahead: **PTC/Onshape** (only vendor exposing an official MCP tool surface to
  external agent clients) and **Autodesk** (broadest automation portfolio + agentic PLM + a
  standalone "agent-first" Assistant announced for 2027). Among AI-natives, **Adam** (adam.new)
  is the most direct competitor to slopcad's thesis: an agent that edits real parametric feature
  trees inside Onshape/Fusion, with its own open-source text-to-CAD language (CADAM), REST API,
  and MCP server.

Screenshots inspected (downloaded and read visually):

1. Onshape AI Advisor (og:image from onshape.com/en/features/ai-advisor) — floating chat panel,
   "Beta" chip, inline citation markers, disclaimer "AI generative content can make mistakes",
   and a green trust badge: "Onshape AI Advisor **cannot see your data**." Blind Q&A.
2. blender-mcp running in a Codex-style client (README assets/codex-screenshot.png) — chat on the
   left, a live pane on the right labeled "Seen by the assistant · Refresh" showing the model,
   captioned "Attached to your next message. Click more objects, or empty space to attach just the
   view." Footer shows model picker ("GPT-6.1 Sol Light") and an "Approve for me" control.
3. Adam Copilot "part editing" (adam.new/images/adam-site/copilot-part-editing.png) — a sectioned
   socket + rubber-mount part beside a full 16-feature parametric tree (sketches, revolves,
   fillets, thread group, patterns, booleans) — evidence of feature-tree-level agentic editing.

---

## 1. Autodesk Fusion / Inventor / Vault

- **Agent surface.** Autodesk Assistant (first introduced 2024 for Fusion and Construction Cloud,
  https://www.graitec.com/blog/ai-powered-workflows-3-momentous-takeaways/) has expanded. At AU
  2026 (Sep 15, 2026) Autodesk announced: **AutoTimeline** (converts imported dumb geometry into
  editable parametric parts), **AutoAssemble** (brings parts into assemblies), **System Modeler**
  (reusable manufacturing automations: machine setup, toolpaths), and an **agentic PLM experience**
  in Fusion (https://adsknews.autodesk.com/en/news/autodesk-ai-design-manufacturing-au-2026).
  **AutoConstrain** (AI-applied sketch constraints/dimensions) is already shipped and "widely
  adopted" per the same source. The **Inventor** Assistant "unlocks Inventor's APIs and iLogic to
  analyze models, modify parameters and components, create model states, and automate repetitive
  tasks" — i.e., true parametric mutation via API. **Vault** Assistant does natural-language
  search/part reuse. A community post (Apr 2026) reports the Fusion assistant helping with
  geometry creation and click-heavy workflows (https://forums.autodesk.com).
  A standalone, **"agent-first" Assistant spanning products/projects was announced for 2027**
  (https://aecmag.com, Sep 15 2026; summarized at https://scouts.yutori.com) **[unverified —
  secondary summaries only]**.
- **Feedback loop.** No documented vision/renders back to the model in any primary source.
  Drawing automation "examines 3D models" internally (https://demm.co.nz, Oct 2024), but the
  assistant's perception mechanism is not disclosed.
- **Model/provider policy.** Vendor-hosted only; no provider or BYOK disclosure found.
- **Controls.** No system-prompt editing, model selection, or reasoning-effort controls found.
- **Error handling.** Not documented for the assistant.
- **Safety model.** Not documented per-feature; drawing automation is one-click direct output.
  A "Fusion Agent API" as a named product: **not found** — the closest things are the Inventor
  Assistant's API/iLogic access, official Fusion Manage MCP documentation ("connect an AI client
  to Autodesk products using a Model Context Protocol server"), and Anthropic's Claude Fusion
  connector (MCP-based, "Claude for Creative Work", Aug 2025; creative-tool connectors extended
  Apr 2026 per https://www.promptinjection.net and https://www.mastra.ai roundups).
- **Maturity.** AutoConstrain + drawing automation: shipped GA. AutoTimeline/AutoAssemble/agentic
  PLM/Inventor+Vault Assistant: announced at AU 2026 with no public dates (adsknews, above).

## 2. Onshape (PTC)

- **Agent surface.** **AI Advisor** (announced Apr 2025,
  https://www.airframer.com/news/ptc-continues-onshape-momentum-with-release-of-ai-capabilities;
  embedded directly in the design environment Oct 2025,
  https://www.digitalengineering247.com) is a context-aware conversational assistant for feature
  help and workflow guidance — Q&A, not model mutation. The **FeatureScript MCP Server**
  (announced May 2026, PR Newswire via
  https://www.executivebiz.com; detailed Aug-Sep 2026,
  https://www.onshape.com/en/blog/how-to-get-started-with-the-onshape-featurescript-mcp) connects
  external coding LLMs to FeatureScript so agents can "build, test, and refine custom CAD
  features" — the agent writes parametric custom-feature code, not raw geometry ops. PTC is also
  seeding **Onshape Labs**, an early-access program for AI incl. "AI agents and automation …
  with full visibility and control" (Jul 2026, https://www.coherentmarketinsights.com) **[unverified — single secondary source]**.
- **Feedback loop.** AI Advisor is explicitly blind — the shipped panel states "Onshape AI
  Advisor cannot see your data" (screenshot, onshape.com/en/features/ai-advisor). The MCP route's
  perception is whatever the external client brings (code + screenshots via the user's agent).
- **Model/provider policy.** Advisor runs on AWS Amazon Bedrock (PTC/AWS collaboration,
  https://www.metrology.news, Sep 2024). FeatureScript MCP is **bring-your-own LLM client**:
  "Claude, ChatGPT, Gemini, etc." (onshape.com blog, Mar 2026). This is the industry's first
  official vendor MCP surface for CAD feature authoring.
- **Controls.** Model choice = whichever client you connect (de facto BYOK via MCP). No in-app
  system-prompt or reasoning-effort controls found.
- **Error handling.** Community threads describe iterating with the agent to debug FeatureScript
  (https://forum.onshape.com, Sep 2026) — errors surface as code the user/agent refines.
- **Safety model.** Generated features land as normal Onshape custom features (reviewable,
  editable); Onshape's cloud rollback/versioning applies. "Full visibility and control" is PTC's
  stated Labs principle.
- **Maturity.** AI Advisor: GA. FeatureScript MCP Server: GA per May 2026 press release. Labs:
  early access.

## 3. SOLIDWORKS / Dassault Systèmes (3DEXPERIENCE)

- **Agent surface.** Dassault's **Virtual Companions** — **Aura** (Q&A/onboarding), **LEO**
  (engineering design), **Marie** — globally available on 3DEXPERIENCE SaaS (announced Jul 29,
  2026; https://www.mst-us.ai; commentary: https://www.cimdata.com "3DEXPERIENCE World 2026: The
  AI Journey"). LEO: automatic 2D drawing generation from 3D parts (sheet formatting, view
  placement, tolerances — users report a ~70% head start), predictive command suggestions, model
  diagnosis of imported geometry, assembly assistance, DFM-style design review, grounded Q&A
  (https://linecad.com; https://dailycadcam.com, May 2026). **AI macro generation** shipped in
  SOLIDWORKS 2026 FD03 (https://www.solidxperts.com/en/ai-in-solidworks-whats-new-in-fd03/,
  Aug 2026). SOLIDWORKS 2027 Preview shows **asking LEO to generate a drawing** conversationally
  (https://linecad.com, Sep 2026). Dassault also demonstrated **STEP → editable parametric part**
  conversion via LEO (linecad.com) — converging on the same "parametricize dumb geometry" play as
  Autodesk.
- **Feedback loop.** Not documented; LEO "recognizes" models and shows drawing previews in demos
  (GoEngineer event transcript, https://goengineer.registration.goldcast.io), but no stated
  render-to-model perception loop.
- **Model/provider policy.** Vendor-hosted; no disclosure.
- **Controls.** None found.
- **Error handling.** "Model diagnosis" of imported/failed geometry is an explicit LEO feature.
- **Safety model.** Drawing generation and suggestions are user-applied; no autonomous writes found.
- **Maturity.** Companions GA on SaaS; LEO drawing creation and several features are **beta**
  (SOLIDWORKS 2026 FD01; expansion planned 2027 — https://wogo.ai, https://linecad.com).

## 4. Rhino / Grasshopper (McNeel)

- **Agent surface.** No first-party assistant as of Oct 2026. McNeel's blog discussed building
  "the gold standard for LLM integration in Rhino and Grasshopper" (https://blog.rhino3d.com,
  May 2026) **[unverified — direction, not a shipped product]**. The real action is community
  MCP servers: **veoery/GH_mcp_server** (LLMs create/edit parametric Grasshopper definitions,
  31 stars, https://github.com/veoery/GH_mcp_server), **tanishqbhattad/rhino-mcp** (AI-assisted
  architectural modeling in Rhino 8 with Claude, ChatGPT, Codex, Gemini or local Ollama,
  https://github.com/tanishqbhattad/rhino-mcp), **GOLEM-3DMCP-Rhino** ("105 tools for geometry,
  surfaces…" over Rhino 8, https://github.com/TheKingHippopotamus/GOLEM-3DMCP-Rhino-), plus
  agent-skills collections for AEC (https://github.com/daniel-locatelli/skills) and academic
  LLM-driven procedural mesh modeling (Mesh-Log, https://www.researchgate.net, Sep 2026).
- **Feedback loop.** Repo descriptions emphasize geometry/tool control; viewport image capture is
  present in some forks but not consistently documented **[unverified per-server]**.
- **Policy/controls/safety.** BYO client by construction (Claude Desktop, Cursor, Ollama…).
  Changes are live edits in the running Rhino session; undo via the host app. No approval gates
  documented.
- **Maturity.** Community/hobbyist grade; no vendor product.

## 5. Blender ecosystem (the de-facto open lab for CAD-style agents)

- **Agent surface.** **ahujasid/blender-mcp** (https://github.com/ahujasid/blender-mcp) — the
  canonical MCP server + addon letting agents create/inspect/modify scenes; MCP Market catalogs
  "550+ actions" (https://mcpmarket.com). Multi-agent frameworks built on top of Blender's MCP +
  Python API are an active topic on Blender's own devtalk
  (https://devtalk.blender.org, Feb 2026).
- **Feedback loop.** The strongest proven vision loop in the wild: a
  `blender_capture_viewport` / `get_viewport_screenshot` tool captures the viewport "to visually
  verify changes after every modification," fast capture or full render
  (https://glama.ai/mcp/servers listing). The README's flagship screenshot shows the agent's chat
  beside a live "Seen by the assistant" viewport pane, with per-turn view attachment.
  Anthropic shipped Blender/Autodesk/Adobe connectors for Claude in its Apr–May 2026 creative-software
  push (https://www.promptinjection.net; https://www.mastra.ai).
- **Policy/controls/safety.** BYO model entirely (any MCP client). In the Codex screenshot, an
  "Approve for me" control gates agent actions. Errors surface as Python exceptions back to the
  agent for self-correction.
- **Maturity.** Community, but polished enough that vendor products now imitate its patterns.

## 6. Shapr3D, FreeCAD, SketchUp

- **Shapr3D.** No AI assistant shipped as of Oct 2026. Its "AI" story is an **adaptive UI** that
  predicts/activates modeling commands from context (https://blog.wor-con.com). Repeated searches
  surfaced no text-to-CAD or agent announcement **[verified absence — as of research date]**.
- **FreeCAD.** Purely community, and busy: **ghbalf/freecad-ai** — natural language → Python code
  that builds models, also runnable headlessly so coding agents drive FreeCAD
  (https://github.com/ghbalf/freecad-ai; trending on GitHub per trendshift.io; forum:
  https://forum.freecad.org/t=107571). A tool-calling assistant workbench (dock widget, LLM picks
  from 21 → 48+ predefined tools to resize/reposition/replace geometry,
  https://forum.freecad.org/t=103482). **ContextForm FreeCAD MCP** — copilot driven via Claude
  Desktop (requires FreeCAD 1.0+). **blwfish/freecad-mcp** — "32 tools for AI-assisted 3D CAD
  modeling" (https://github.com/blwfish/freecad-mcp, 56 stars).
- **SketchUp (Trimble).** Shipped AI in Pro 2026.1 (Aug 2026): **AI Render** (generative renders
  from the viewport), **AI Assistant** (in-app help), and **Generate Object** (text-to-object
  placement), monetized via a credit system (~10 credits/render, ~30/object generation
  per community docs; announcements at Trimble Dimensions Nov 2025 with Q4-2025→2026 rollout —
  https://forums.sketchup.com; https://constructionequipmentguide.com). Trimble is inviting
  extension developers to connect to its AI frameworks (May 2026,
  https://forums.sketchup.com). Generate Object is content generation, not parametric editing.

## 7. AI-native CAD startups (late 2026)

- **Adam (adam.new, formerly adamcad.com)** — "The AI workspace for hardware teams." Copilot
  plugins that work **inside Onshape and Autodesk Fusion** (plus a Rhino plugin, a desktop
  connector for local CAD, and Arena PLM integration); docs describe "reviewing and changing CAD
  via supported Onshape, Fusion, and desktop CAD applications"
  (https://adam.new/, https://docs.adam.new/). Also ships **CADAM**, an open-source text-to-CAD
  language/model generator, a versioned REST API with OpenAPI specs, **an MCP server** for Adam
  projects, and OAuth (RFC 8414/9728) — https://adam.new/. Marketing imagery shows agentic editing
  of a 16-feature parametric tree. A site page references "running OpenAI's GPT-6 Astra in
  SolidWorks, Onshape, and Fusion" **[unverified marketing]**. Pricing pages exist; no public
  model policy beyond that page. The closest analogue to slopcad's agent: agentic, parametric,
  multi-CAD, API-first.
- **Zoo (zoo.dev, formerly KittyCAD)** — AI-native **Zoo Design Studio**: the **Zookeeper**
  conversational agent writes **KCL** (open-source CAD scripting language) alongside
  point-and-click tools; Text-to-CAD API (cloud geometry engine, streams renders; "reasoning
  mode" added); desktop apps for Mac/Win/Linux; open-source
  (https://zoo.dev/blog/introducing-text-to-cad; https://app.zoo.dev). Community forum (Aug 2026)
  shows the agent integrating with user selections and failing gracefully when selections can't
  resolve to KCL (https://community.zoo.dev) — evidence of a tight editor↔agent loop, though a
  documented multi-angle render feedback feature was **not** found.
- **Leo AI (getleo.ai)** — standalone copilot for mechanical engineers (claims 50k+ engineers):
  builds assemblies and concept imagery from prompts, runs engineering calculations with
  citations, searches 120M+ vendor parts, grounds in company PLM (SOLIDWORKS PDM, Inventor,
  Fusion, NX, Teamcenter, SAP); SOC 2; "zero training on your data"; Onshape direct integration
  endorsed by Jon Hirschtick as "upcoming" (https://www.getleo.ai/). Strong on knowledge/PLM,
  not shown as a geometry-editing agent.
- **Backflip AI** — founded by Markforged's Greg Mark and David Benhaim; ~$30M raised; launched
  2025 generating 3D models from text/images, now positioned around **scan/mesh → editable
  parametric CAD** with a Fusion plugin (https://yespress.io; https://issuu.com X3DMEDIA, Feb 2025) **[unverified details — secondary sources only]**.
- **MecAgent (mecagent.com)** — embedded CAD copilot currently in **SOLIDWORKS and Inventor**,
  with CATIA/Fusion/NX/Solid Edge/Onshape listed as planned; mission "automate anything in your
  CAD software"; V2.0.0 demos reference "Astra on CAD"
  (https://www.4-cad.cz, Oct 2026) **[partial — vendor/reseller sources]**.
- **Generative Engineering** — UK startup, $4M seed (Nov 2023), AI for engineering design
  (https://startupintros.com). **[unverified current product state]**
- Market framing: roundups of AI-native design tools cluster into text-to-CAD, geometry repair,
  and DFM review (https://axomap.com).

## 8. MCP servers for CAD/geometry (community + official)

Official vendor surfaces:

- **Onshape FeatureScript MCP Server** (custom-feature authoring; BYO client) — the only official
  vendor MCP aimed at geometry-adjacent authoring (PTC, May 2026, PR Newswire/executivebiz.com).
- **Autodesk Fusion Manage MCP** docs for connecting AI clients (Autodesk help domain).
- **Claude ↔ Fusion connector** via MCP (Anthropic "Claude for Creative Work", Aug 2025).

Community (GitHub, stars as of Oct 2026):

- `mixelpixx/KiCAD-MCP-Server` (2,561★) — LLMs drive KiCad EDA directly.
- `daobataotie/CAD-MCP` (579★) — AutoCAD automation via MCP.
- `jdilla1277/agentcad` (144★) — CAD CLI + MCP server purpose-built for AI agents.
- `AnCode666/multiCAD-mcp` (126★) — drive multiple CAD packages from Claude Desktop/Cursor.
- `U-C4N/Autocad-MCP` (117★) — 122 tools; dual live-COM + headless ezdxf engines.
- `pzfreo/build123d-mcp` (102★) — build123d parametric modeling "to improve AI cognition."
- `armpro24-blip/cad-cae-copilot` (64★) — AI-native CAD/CAE workbench, build123d/OpenCASCADE.
- `blwfish/freecad-mcp` (56★), `veoery/GH_mcp_server` (31★), `tanishqbhattad/rhino-mcp` (26★),
  `GOLEM-3DMCP-Rhino` (105 Rhino tools, 14★).
- `ahujasid/blender-mcp` — the reference implementation for viewport-vision agents (see §5).

Pattern across all of them: expose the tool's **native parametric/scripting language** as MCP
tools, let a BYO agent client drive it, and (in the mature ones) **capture viewport images** so
the agent can verify its own work.

---

## Feature matrix

Legend: ✔ shipped · ◐ partial/beta/announced · ✘ not found/not documented · n/a not applicable.
"Vision" = documented render/screenshot of the model fed back to the AI.

| Product                           | Agent acts on geometry                                | Parametric/feature-tree edit                   | Vision feedback                               | Model policy                           | System prompt | Reasoning effort                     | Approval flow                   | Maturity                         |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- | -------------------------------------- | ------------- | ------------------------------------ | ------------------------------- | -------------------------------- |
| **Autodesk Fusion**               | ◐ AutoConstrain/AutoTimeline/AutoAssemble automations | ◐ via AutoTimeline; assistant assists geometry | ✘                                             | Vendor-hosted                          | ✘             | ✘                                    | ✘ (one-click tools)             | GA features + 2026 announcements |
| **Autodesk Inventor Asst.**       | ✔ drives APIs/iLogic                                  | ✔ parameters/components/model states           | ✘                                             | Vendor-hosted                          | ✘             | ✘                                    | ✘                               | Announced AU 2026                |
| **Onshape AI Advisor**            | ✘ (Q&A only)                                          | ✘                                              | ✘ ("cannot see your data")                    | Vendor (Bedrock)                       | ✘             | ✘                                    | n/a                             | GA                               |
| **Onshape FeatureScript MCP**     | ◐ custom features (code)                              | ◐ FeatureScript code, not tree ops             | Via external client                           | **BYO client** (Claude/ChatGPT/Gemini) | Via client    | Via client                           | Feature lands as normal feature | GA (May 2026)                    |
| **SOLIDWORKS LEO + companions**   | ◐ drawings, macros, diagnosis, STEP→parametric        | ◐ macro gen; conversion                        | ✘                                             | Vendor-hosted                          | ✘             | ✘                                    | ✘                               | Companions GA; drawing gen beta  |
| **Siemens NX Copilot**            | ◐ NL command interface                                | ✘                                              | ✘                                             | Vendor-hosted                          | ✘             | ✘                                    | ✘                               | Rolling out since Jul 2025       |
| **SketchUp AI**                   | ◐ Generate Object (mesh content)                      | ✘                                              | ◐ renders _from_ viewport, not _to_ agent     | Vendor (credits)                       | ✘             | ✘                                    | ✘                               | Shipped 2026.1                   |
| **Shapr3D**                       | ✘ (predictive UI only)                                | ✘                                              | ✘                                             | n/a                                    | ✘             | ✘                                    | ✘                               | No AI assistant                  |
| **FreeCAD (community)**           | ✔ code-gen + tool-calling                             | ✔ Python/tools                                 | ◐ some servers                                | BYO client                             | Via client    | Via client                           | ✘                               | Community                        |
| **Blender + blender-mcp**         | ✔ full scene ops                                      | n/a (mesh, not parametric)                     | **✔ viewport capture loop**                   | **BYO client**                         | Via client    | Via client                           | ✔ client-side approve           | Community, polished              |
| **Zoo Design Studio (Zookeeper)** | ✔ KCL generation                                      | ✔ KCL parametric                               | ◐ selections/inline; multi-angle undocumented | Vendor + open-source client            | ✘             | ◐ "reasoning mode" (Text-to-CAD API) | ✘                               | GA desktop app                   |
| **Adam (adam.new)**               | ✔ edits parts in Onshape/Fusion                       | ✔ feature tree (shown)                         | ◐ undocumented                                | ◐ GPT-6 Astra page [unverified]        | ✘             | ✘                                    | ◐ "reviewing and changing"      | Live product; new                |
| **Leo AI (getleo.ai)**            | ◐ assemblies/concepts                                 | ✘                                              | ✘                                             | Vendor-hosted                          | ✘             | ✘                                    | ✘                               | GA, commercial                   |
| **Backflip**                      | ◐ text/image/scan → CAD                               | ◐ parametric output                            | ✘                                             | Vendor-hosted                          | ✘             | ✘                                    | ✘                               | Live, Fusion plugin              |

---

## "The bar" — table stakes for a credible CAD agent in late 2026

1. **Embedded conversational surface in the CAD viewport** — a docked chat with citations and
   model-aware context (Onshape AI Advisor, LEO, Autodesk Assistant all ship this; the panel is
   commodity).
2. **Agent writes the tool's parametric language, kernel executes** — FeatureScript (PTC), KCL
   (Zoo), iLogic (Inventor Assistant), Python (FreeCAD), CAD scripts generally (Fabbaloo's
   "text-to-CAD" thesis). If your agent can only emit meshes or black-box STEP, you're behind.
3. **Parametricize dumb geometry** — AI conversion of imported/dumb geometry into constrained,
   editable features (Fusion AutoConstrain/AutoTimeline, LEO STEP conversion). Now table stakes
   at the incumbents, announced or beta.
4. **Automated drawing generation** — one-click (Fusion) or conversational (SOLIDWORKS 2027
   preview) 2D drawing synthesis from the 3D model. The single most-demoed CAD AI feature of
   2025–2026.
5. **MCP exposure of the tool surface** — vendors either ship an official server (PTC, Autodesk
   Fusion Manage, Claude Fusion connector) or get community ones anyway (FreeCAD, Rhino, Fusion).
   An agent locked inside one vendor chat bubble is now the _conservative_ option.
6. **Vision feedback on the viewport** — proven pattern (blender-mcp captures after every
   modification; the Codex screenshot shows a "Seen by the assistant" pane with per-turn
   attachment). Vendors haven't shipped it, which makes it a differentiator rather than a bar —
   but users of agent tooling now expect the agent to _check its own work visually_.
7. **Human approval / visibility of agent actions** — "full visibility and control" (PTC Labs),
   client-side "Approve for me" (Codex/blender-mcp). Agents that silently mutate models are
   non-starters.
8. **Grounded Q&A on the user's own data + engineering knowledge** — Leo (PLM grounding, cited
   calculations), LEO (docs-grounded), Vault Assistant (part reuse search). Assistants are
   expected to answer _with citations_, not vibes.

## "The edge" — what slopcad's agent can own, ranked

Nothing verified in this research shows any shipped product combining all of: full command
surface, in-app multi-angle vision, BYOK multi-provider, editable system prompt, reasoning-effort
control. Each of the following is a gap against at least the entire incumbent field; honest
caveats after each.

1. **Multi-angle vision as a first-class agent sense.** The only proven vision loop is the
   community Blender MCP (single viewport capture). Zoo's vision behavior is undocumented;
   vendors' assistants are blind or undisclosed. A browser CAD can render deterministic
   multi-angle image sets per edit and feed them back automatically — no one documents this.
   _Caveat:_ Adam/Zoo may do this without documenting it; slopcad's version must be demonstrably
   reliable (angled pairs, orthographic + iso, after every command batch), not just present.
2. **BYOK multi-provider inside a first-party CAD app.** Today BYO-models exist only via MCP to
   an external client (PTC's MCP, Blender/FreeCAD servers). No vendor assistant lets you pick
   OpenAI vs Anthropic vs Google vs local in-app. In-app BYOK collapses setup to zero.
   _Caveat:_ PTC's MCP route partially neutralizes this for power users; the win is for the
   mainstream user who won't configure Claude Desktop.
3. **User-editable system prompt + reasoning-effort control.** No surveyed product exposes either
   (all vendor assistants are fixed-persona, fixed-inference-budget). These are cheap to build,
   defensible as "the CAD prompt is part of the document," and directly serve expert users.
   _Caveat:_ low novelty in isolation; differentiating only in combination with 1–2.
4. **Full-surface parity: the agent can do everything the human can.** Every incumbent assistant
   exposes a curated subset (drawings here, constraints there; FeatureScript MCP covers custom
   features, not tree operations). slopcad's JSX→CadCommand compiler means the agent's vocabulary
   _is_ the app's vocabulary — one source of truth, no tool-subset drift.
   _Caveat:_ incumbents would claim their SDK is equally complete; slopcad's advantage is that
   the surface is small, typed, and deterministic enough for an LLM to actually cover it all.
5. **Propose-then-approve with semantic diffs of the model program.** Because models are code,
   agent proposals can be reviewed as readable JSX diffs before applying — a cleaner approval UX
   than feature-tree mutation in history-based CAD (where "what changed" is genuinely hard to
   show; hence Onshape's "visibility and control" promises staying vague). Paired with undo,
   this is a safety story incumbents can't easily retrofit.
   _Caveat:_ Codex-style "approve for me" already sets user expectations; the _diff of a CAD
   program_ is the novel part.
6. **Compile-and-render error loop as agent feedback.** Geometry command failures, compiler
   errors, and render results all become structured, machine-readable feedback to the agent for
   self-correction. Incumbent equivalents ("model diagnosis", "guide you if you get stuck" —
   SimScale forum) are assistive, not closed-loop. Deterministic JSX re-execution also enables
   property checks (mass, clearance, manifoldness) as agent-verifiable assertions.
   _Caveat:_ research systems already do geometric validation (Fabbaloo's "programmatic geometry
   validation"); the edge is shipping it as product.
7. **The workspace as context: agent sees sketches, selections, feature history, and renders in
   one prompt assembly.** Zoo's forum errors show even the best AI-native struggles to map
   selections → program. A code-first app can attach the exact source span for a selected face.
   _Caveat:_ unglamorous; valuable because it raises answer quality on every other capability.
8. **Browser-native shareability of agent sessions** (replay a prompt→diff→render sequence).
   Nothing surveyed documents replayable agent-by-model sessions. _Caveat:_ speculative;
   validate demand before building.

Gaps where slopcad will be _behind_ the bar (be honest internally): automated 2D drawing
generation (items 4), AI parametricization of imported dumb geometry (3), DFM/manufacturability
review, PLM/vendor-parts grounding, and ecosystem integrations (Onshape/Fusion plugins) — all
shipped or announced elsewhere. The strategy this implies: win on the agent loop (1, 2, 5, 6)
where nobody has shipped, and treat 3/4 as roadmap items, not launch requirements.

---

### Source index (primary where possible)

- Autodesk AU 2026 announcements: https://adsknews.autodesk.com/en/news/autodesk-ai-design-manufacturing-au-2026
- Autodesk Assistant origins (2024): https://www.graitec.com/blog/ai-powered-workflows-3-momentous-takeaways/
- Fusion drawing automation (2024): https://demm.co.nz (covered via https://www.scoop.co.nz)
- Standalone agent-first Assistant (2027): https://aecmag.com (Sep 15, 2026) via https://scouts.yutori.com [secondary]
- Onshape AI Advisor: https://www.onshape.com/en/features/ai-advisor (page + og:image screenshot inspected)
- Onshape AI Advisor on Bedrock: https://www.metrology.news (Sep 2024); embedded in design env: https://www.digitalengineering247.com (Oct 14, 2025)
- FeatureScript MCP Server: PTC press release May 12, 2026 (via https://www.executivebiz.com); https://www.onshape.com/en/blog/how-to-get-started-with-the-onshape-featurescript-mcp; community: https://forum.onshape.com (Sep 16, 2026), https://www.chiefdelphi.com (Aug 22, 2026)
- Onshape Labs: https://www.coherentmarketinsights.com (Jul 2026) [secondary, single source]
- Dassault Virtual Companions (Aura/LEO/Marie): https://www.mst-us.ai (Jul 29, 2026); https://www.cimdata.com (3DEXPERIENCE World 2026 commentary)
- LEO capabilities + SW2026/2027 beta: https://linecad.com (Sep 2026); https://dailycadcam.com (May 2026); https://www.solidxperts.com/en/ai-in-solidworks-whats-new-in-fd03/ (Aug 2026); https://wogo.ai
- Siemens NX copilot: https://www.industrialtechnology.co.uk (Jul 2, 2025)
- SketchUp AI 2026.1 + credits: https://forums.sketchup.com (May 20, 2026 + 2026 threads); https://constructionequipmentguide.com (Dimensions 2025)
- Shapr3D adaptive UI: https://blog.wor-con.com
- FreeCAD ecosystem: https://github.com/ghbalf/freecad-ai; https://forum.freecad.org/t=103482; https://forum.freecad.org/t=107571; https://github.com/blwfish/freecad-mcp
- Blender MCP: https://github.com/ahujasid/blender-mcp (README screenshot inspected); https://glama.ai (viewport capture tool); https://devtalk.blender.org (Feb 2026); https://mcpmarket.com
- Anthropic creative connectors: https://www.promptinjection.net (Apr 30, 2026); https://www.mastra.ai (May 6, 2026)
- Adam: https://adam.new/ ; https://docs.adam.new/ ; copilot screenshot: https://adam.new/images/adam-site/copilot-part-editing.png (inspected)
- Zoo: https://zoo.dev/blog/introducing-text-to-cad ; https://app.zoo.dev ; https://community.zoo.dev (Aug 2026)
- Leo AI: https://www.getleo.ai/
- Backflip: https://yespress.io ; https://issuu.com (X3DMEDIA, Feb 2025) [secondary]
- MecAgent: https://www.4-cad.cz (Oct 2026) [reseller]
- Text-to-CAD maturity assessment: https://www.fabbaloo.com/blog/2026/6/26/text-to-cad-is-getting-more-real-but-its-not-there-yet
- Community MCP repos: github.com links in §8 (star counts via GitHub API, Oct 4, 2026)
