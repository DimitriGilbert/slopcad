# Global report — what AngeTheGreat's corpus teaches a simulation builder

Synthesis of the 26-video catalog in `reports/report-C1.md` (276 findings, each citing
`transcripts/<file> @ [mm:ss]` with a verbatim quote). Anchors below reference findings by
section and title in that report; every anchor resolves to a transcript citation there.

## Executive summary

AngeTheGreat's body of work is a decade-long proof that credible simulation is built as
data-driven cores (gas vessels + connections, parts + attachment points) wrapped in
relentless honesty: every simplification named, every degraded mode disclosed, every
claim sized against measurement or literature rather than vibes. His engines are
mechanism-first — rigid bodies, real gas bookkeeping, composition and friction in the
loop — because emergent correctness (ram effect, scavenging, condensation vacuums,
misfiring idles) is the whole product, and it only emerges from physically based state.
His numerics trajectory shows the real discipline: a cheap harness before a product UI,
pinned-workload benchmarks, algorithm fit re-decided on evidence rather than micro-
optimization, and mathematical limits stated publicly instead of hidden. Finally, the
output modality governs the engineering — audio forced 44 kHz solves and micrometer-
scale kinematic precision ("way way beyond most video games") — which is exactly the
kind of requirement our S-laws should force into the open before a solver is written.

## Cross-cutting themes (and how strongly they are evidenced)

- **Honesty as engineering discipline (very strong; every video)** — placeholder models
  labeled with upgrade paths, unsolved discrepancies named, capability declines stated
  with workarounds, approximations quoted from their sources, adaptive quality deleted
  because it changed results. Anchors: report-C1 §Numerics "Simulation quality is not a
  graphics setting"; §Testing "Accept 'a quite adequate first approximation'";
  §Lessons "Missing capability = stated workaround", "Label experimental output as
  experimental", "Disclose degraded-mode artifacts".
- **Physically derived state beats scripted behavior (very strong; all engine videos)** —
  kinetic-energy gas state, molecule bookkeeping, bulk velocity, species tracking; each
  yields unscripted phenomena (ram effect, scavenging, condensation vacuum, closed-
  throttle failure). Anchors: §Combustion "Track kinetic energy, not P and T separately",
  "Molecule + energy transfer is enough", "Bulk velocity is a separate directional state",
  "Generality pays unexpected dividends: the condensation vacuum", "A sim that works too
  well is wrong".
- **Validation is multi-instrument (strong; grows over time)** — energy-conservation
  oracles → canonical cases (Riemann/shock tube) → analytic structures → calibrated
  microphone measurements → cross-implementation convergence → perceptual review at
  scale (7,000 clips). Anchors: §Testing "Energy conservation is the cheap stability
  oracle", "Validate CFD with the shock tube", "Calibrated physical measurement as ground
  truth", "Convergence across independent implementations", "The labor of perceptual
  tuning".
- **Solver economics: fit over speed, evidence over preference (strong; devlogs 2023+)** —
  Gaussian elimination → Gauss-Seidel → CG (won for trusses, failed for velocity
  constraints) → sparse GS; decisions reversed with test benches; warm starts and
  matrix-free products. Anchors: §Numerics "Conjugate gradient was the 10x answer",
  "The CG win did not transfer to engines", "Never materialize A = JᵀWJ", "Warm-start
  iterative solves"; §Architecture "Reverse a performance decision with new evidence".
- **Architecture for iteration: prototype benches, shared cores, testbed spin-offs
  (strong)** — throwaway benches before product UI; one simulation core under two shipped
  products; mini-projects harden the production kernel. Anchors: §Testing "Prototype on a
  throwaway bench", "Mini projects as solver testbeds"; §Architecture "One simulation
  core under two products".
- **Performance engineering as a user-facing discipline (strong)** — real-time-factor
  gauges, audio-buffer "gas tank", meters-of-tubing headroom, overloads with audible
  signatures. Anchors: §Architecture "Measure the system, not the module", "State
  headroom as concrete capacity", "Overload has an audible failure signature"; §UI/UX
  "Performance telemetry as 'almost a mechanic'".
- **The realism frontier is transient and mechanical (strong, stated explicitly)** —
  low-inertia throttle response "immediately gives away that it's synthetic"; idle is
  hardest (turbulence + mechanical noise); friction sound from first principles.
  Anchors: §Lessons "Low-inertia, throttle-sensitive engines are the synthetic giveaway";
  §UI/UX "Idle is the hardest sound", "Friction sound from first principles".
- **Product lessons from shipping (moderate; the borderline/Steam videos)** — retention
  needs a loop that exercises the simulator's core skill; free-product sloppiness is not
  paid-product sloppiness; be prepared for success. Anchors: §Lessons "Retention is the
  product metric", "Choose the game loop that exercises the core concept",
  "Be prepared for success".

## Takeaways mapped against ROADMAP-SIM

### Phase 61 (spine) — what he validates

- Determinism is a product feature, not an internal property: adaptive simulation
  quality changed results per machine and was removed entirely (§Numerics "Simulation
  quality is not a graphics setting"). Our fixed-quality, bitwise-deterministic stance
  (S2) is what he converged on after shipping the alternative.
- Performance telemetry belongs in the user surface (§UI/UX "Performance telemetry";
  §Architecture "Debug on machines you don't own"); the spine's `data-sim-*` counter
  work should grow into a budget panel, and the RT-factor-vs-100% framing is the right
  user vocabulary.
- Headroom communication works when stated in concrete capacity ("20 or so meters of
  tubing"; §Architecture "State headroom as concrete capacity") — our budgets law could
  adopt "cells at interactive rate" phrasing in docs.

### Phase 63/66 (flow) — validate, then exploit parallelism

- Lead the known-cases gallery with the shock tube (Riemann) fixture, not the airfoil
  (§Testing "Validate CFD with the shock tube").
- Expect and publish the dissipation/dispersion tradeoff: naive schemes low-pass the
  field, refinement cost grows non-linearly, high-resolution schemes oscillate by
  theorem and need limiters (§Numerics "Artificial dissipation", "High-resolution
  schemes oscillate by theorem"). Our grid-convergence self-check should report
  perceived-quality effects, not only numeric drift.
- A second, structurally independent kernel that converges to the same answer is the
  strongest bug-excluder he found (§Testing "Convergence across independent
  implementations") — for us, a cheap alternative formulation of the BGK step could
  serve as that oracle supplement.
- Hyperbolic causality gives cell independence for free; keep data resident in the
  vectorized/WGSL layout because transfer overhead is the hidden cost (§Numerics
  "Hyperbolic PDEs have finite causality"; §Architecture "SIMD transfer overhead is
  real").

### Phase 65 (thermal/radiation) — the subtle-effects warning

- Wall heat transfer barely moved aggregate accuracy but dominated perceived output
  quality in his case; papers that omitted it undersold it (§Numerics "Wall heat
  transfer matters to sound even when accuracy papers skip it"). For our CHT phase:
  keep radiation/losses in even when energy-balance fixtures pass without them, and
  validate material/surface-finish effects explicitly.
- Fouling/wear as simulated state creates honest efficiency narratives (§Friction
  "Water fouling", "Component wear") — relevant to equilibrium-boundary scenarios
  reaching believable wall temperatures.

### Phase 67 (dynamics/friction) — his strongest validation of our ruling

- Friction belongs in the step, as forces, not post-passes: force-limited constraints
  produce slip emergence (§Friction "Tires are force-limited constraints"); per-
  constraint forces are first-class outputs reused for structural analysis and
  mechanical sound (§Testing "Solver reaction forces are a free structural analysis";
  §UI/UX "Constraint forces are free sound drivers"). This is exactly §7.10's ruling.
- Warm-started iterative solves, sparse/matrix-free patterns, and knowing when the
  algorithm (not the code) is wrong are the portable numerics for our TS reference
  kernel (§Numerics "Warm-start iterative solves", "Never materialize A", "Stop
  optimizing when the algorithm is the wrong one").
- Boundary-condition literacy is a fixture requirement: the "wrong" truss was right
  physics with a pinned-instead-of-slider support (§Testing "The simulation was right;
  the boundary condition was wrong") — our conservation/dissipation fixtures must pin
  BCs as deliberately as equations.
- Coupled systems split by spring coupling trade accuracy for scale, stated openly
  (§Architecture "Split coupled systems with a spring", "Accept and disclose the
  coupling tradeoff") — a template for our quasi-static coupling honesty notes.

### Phase 68 (combustion, Woschni/FMEP/brake) — direct precedent

- The 0D chamber blueprint: vessels + valves, kinetic-energy state, molecule/energy
  conservation, textbook orifice flow (§Combustion "Gas network = discrete vessels",
  "Track kinetic energy", "Valve flow from a textbook") — validates our Wiebe/
  progress-variable plan as the right family, and his species-tracking failure mode
  (engine ran with the throttle closed until AFR became state; §Combustion "A sim that
  works too well is wrong") argues for a mixture/composition scalar from day one plus a
  closed-throttle fixture.
- Part-load parasitic losses (friction dominating at low output) are the physics that
  makes brake quantities and efficiency trends honest — §7.10's Chen–Flynn FMEP is his
  emergent game mechanic too (§Friction "Part-load inefficiency is real physics that
  becomes game design").
- His misfire work (probabilistic model from published AFR/dilution data; §Combustion
  "Misfire is a mixture phenomenon") is a plausible post-v1 extension along the
  Livengood–Wu line; watch, don't scope.
- What he'd challenge: our roadmap's "never a fitted burn curve" is stricter than his
  early combustion (instantaneous energy release at TDC as a labeled placeholder;
  §Architecture "Combustion placeholder") — his defense would be purpose-relative
  standards ("a tube game for vroom vroom sounds"; §Numerics "Brute-force stability
  hacks are acceptable when labeled"). Our answer stands: engineering-adjacent claims
  need correlation-grade heat release, and his own later work (Benson boundary, real
  valve model) moved the same direction.

### Phase 69 (structural)

- Reaction-force stress output with stated error bounds ("not 100 accurate... a lot of
  different solutions") validated against truss theory is a legitimate coarse tier —
  supports our comparative/staircase-banded positioning (§Testing "Solver reaction
  forces are a free structural analysis").
- His BC lesson (slider vs pin) is the fixture-design caution for our cantilever/ring
  fixtures; and stress output becoming damage/failure features (§Architecture "Stress
  output is the door to failure physics") previews what FoS summaries could unlock.

### Phase 70 (optimization)

- Characterize the machine before optimizing against it: a measured map "power demand →
  minimum heat at steady state" became the benchmark (§Testing "Difficulty needs a
  measured benchmark") — for us, run the objective landscape once per scenario family
  and publish it.
- Never average a nonlinearity's input (§Testing "Averaging a nonlinearity's input is
  not averaging its output") — objective extraction over time histories must integrate
  the nonlinearity, not its driver.
- An autonomous baseline operator is a cheap regression harness and model validator
  (§Testing "An autonomous AI operator validates both model and game") — a scripted
  pilot over scenario fixtures would strengthen our e2e beyond render checks.

### S-laws (incl. S9 regime honesty)

- S2/S5 (determinism, CPU oracle): validated — fixed quality, replayable state logs,
  timeline scrubbing to individual timesteps (§Testing "Deterministic replay tests";
  §UI/UX "Time is scrubbable").
- S9 (regime honesty): his whole voice is S9 — Reynolds-number-scaled noise, admitted
  1D dimensionality limits ("debatable whether one-dimensional techniques are even
  still applicable"), mathematical limits taught publicly (§Combustion "1D CFD has a
  dimensionality honesty limit"; §Numerics "Name the unsolved discrepancies"). Our
  qualitative flags should carry his concreteness: name the artifact, name the cause,
  name the fix path.
- Additions worth stealing: a purpose-built file format + reset states + undo/redo
  from the spine (§Architecture "Authoring data persists"; §UI/UX "Reset state as the
  recovery primitive"), and authoring data as authored positions rather than solved
  placements (§Architecture "Author initial positions explicitly").

## Adopt / avoid / watch

**Adopt**

- Pinned-workload benchmarking and system-level RT-factor telemetry as the perf
  vocabulary (§Testing "Optimize by measurement"; §Architecture "Measure the system").
- Labeled placeholders with named upgrade paths for every provisional model
  (§Numerics "Placeholders must be labeled as placeholders").
- Energy/conservation audits as the cheapest solver oracle, extended with dissipation
  accounting (§Testing "Energy conservation is the cheap stability oracle").
- Mini-project testbeds before integrating any new solver into the workbench
  (§Testing "Mini projects as solver testbeds").
- Ablation-ladder validation for coupled physics: enable one coupling at a time and
  A-B the outputs (§Lessons "The ablation ladder").

**Avoid**

- Adaptive simulation quality or any silent accuracy knob that changes results per
  machine (§Numerics "Simulation quality is not a graphics setting").
- Post-processing/synthesis layered over a too-coarse solver to fake fidelity — it
  hides model flaws and shows (§Architecture "Audio post-processing was hiding model
  coarseness").
- Hand-authoring huge configs; generate them with throwaway scripts (§Architecture
  "Generate huge configs with throwaway scripts").
- Announcing done-ness before user testing, or release dates that aren't certain
  (§Testing "Never announce 'almost done'"; §Numerics "Only promise release dates you
  are certain of").

**Watch**

- His junction handling and larger-engine scaling (deferred from the real-data video;
  report-C1 §Numerics "Boundary conditions are the hardest part") — directly relevant
  when Phase 66 faces multi-branch domains.
- His convergence-properties solver for nonlinear boundary conditions (§Numerics
  "Boundary conditions are the hardest part of 1D gas dynamics") — a 100-hour
  isolated problem that our orifice/valve fixtures should expect to become.
- Whether his feedback-loop AI operator generalizes into our e2e fixtures as a
  scenario pilot (§Testing "An autonomous AI operator validates both model and game").
- Species/composition state in our 0D engine cycle: he needed it before the engine was
  physically believable; plan the scalar in from the start (§Combustion "A sim that
  works too well is wrong").
