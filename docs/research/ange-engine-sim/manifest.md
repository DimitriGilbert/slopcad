# Manifest — AngeTheGreat engine-simulation transcript corpus

Source channel: **AngeTheGreat** (`UCV0t1y4h_6-2SqEpXBXgwFQ`, https://www.youtube.com/@AngeTheGreat). Fetched: **2026-10-07**.

## Enumeration

- RSS feed (`youtube.com/feeds/videos.xml?channel_id=UCV0t1y4h_6-2SqEpXBXgwFQ`) returned **15 entries** (feed cap confirmed).
- Full public catalogue: **39 videos**, obtained from the channel's `/videos` tab listing (one flat listing request, no pagination bursts).
- Filter: engine-simulation and closely related simulation-engineering videos (engine simulator series, physics/numerics/solver devlogs, related simulation tools). 13 clearly-unrelated videos excluded (graphics/rendering devlogs, ray-tracer, Vulkan renderer, game-content devlogs, channel analytics, the procedural office-horror game).
- Selected candidates: **26** (20 core + 6 marked `borderline`).
- Note: the public videos tab shows Engine Simulator Devlogs 1, 3, 4, 5, 6 — no "Devlog 2" exists in the public catalogue.

## Fetch methods (audit)

- `yt-dlp` (default flags, no cookies/auth): used for **20** transcripts early in the run, before the owner directive to stop. All direct-YouTube requests from this tool have ceased; files kept as instructed.
- `notegpt.io` transcript service via agent-browser (fresh profile, no cookies/auth): used for the **6** videos yt-dlp failed on (throttled mid-run). One same-origin API call each.
- Earlier failed service attempts (1 curl request each): `youtubetranscript.com` (their upstream YouTube fetch was blocked server-side), `tactiq-apps-prod.tactiq.io` (requires app-check token), `youtubetotranscript.com` (Cloudflare Turnstile, not passable headless).
- Failures: **none** — all 26 candidates fetched.

## Corpus

26 transcripts, chronological. `method` = which route produced the file; all are YouTube English auto-captions converted to plain text with coarse `[mm:ss]` paragraph markers.

| # | published | videoId | title | dur | borderline | fetched | bytes | method | file |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2020-07-05 | `7GSUEqUoR5s` | Physics Engine Improvements // C++ Game Devlog #3 | 6:06 | true | yes | 5,121 | notegpt.io | `transcripts/2020-07-05-7GSUEqUoR5s-physics-engine-improvements-c-game-devlog-3.md` |
| 2 | 2022-01-31 | `TtgS-b191V0` | Building a Physics Engine with C++ and Simulating Machines | 11:23 | false | yes | 33,249 | yt-dlp | `transcripts/2022-01-31-TtgS-b191V0-building-a-physics-engine-with-c-and-simulating-machines.md` |
| 3 | 2022-08-02 | `RKT-sKtR970` | Simulating an Entire Car Engine (yes, it makes noise) | 12:04 | false | yes | 9,247 | yt-dlp | `transcripts/2022-08-02-RKT-sKtR970-simulating-an-entire-car-engine-yes-it-makes-noise.md` |
| 4 | 2022-08-29 | `WPCMNnM6D0k` | Simulating VTEC, a radial-5 engine and more with my engine simulator (there is sound) | 17:07 | false | yes | 3,676 | notegpt.io | `transcripts/2022-08-29-WPCMNnM6D0k-simulating-vtec-a-radial-5-engine-and-more-with-my-engine-si.md` |
| 5 | 2022-09-26 | `NBBwva3NZ6o` | Simulating an F1 V12, cross-plane and flat-plane V8s, unequal length headers and more | 15:55 | false | yes | 9,809 | notegpt.io | `transcripts/2022-09-26-NBBwva3NZ6o-simulating-an-f1-v12-cross-plane-and-flat-plane-v8s-unequal.md` |
| 6 | 2022-10-17 | `2bJTkBsiTPc` | Engine Sim: Procedurally Generating Audio Using a Real-time Fluid Simulation (Technical Breakdown) | 20:19 | false | yes | 56,151 | yt-dlp | `transcripts/2022-10-17-2bJTkBsiTPc-engine-sim-procedurally-generating-audio-using-a-real-time-f.md` |
| 7 | 2022-12-09 | `KdAn2YKry30` | Simulating a Rotary Engine (yes, it braps) | 16:30 | false | yes | 13,027 | notegpt.io | `transcripts/2022-12-09-KdAn2YKry30-simulating-a-rotary-engine-yes-it-braps.md` |
| 8 | 2023-01-21 | `dzfjwXtATJA` | Simulating a Steam Engine with C++ (with sound) | 18:41 | false | yes | 44,370 | yt-dlp | `transcripts/2023-01-21-dzfjwXtATJA-simulating-a-steam-engine-with-c-with-sound.md` |
| 9 | 2023-02-23 | `DP83LxQm1jM` | Making a Terrible Racing Game with Great Audio (Engine Simulator) | 14:00 | false | yes | 13,813 | yt-dlp | `transcripts/2023-02-23-DP83LxQm1jM-making-a-terrible-racing-game-with-great-audio-engine-simula.md` |
| 10 | 2023-03-18 | `oulfRfqTxJA` | Making My Physics Engine 10x Faster and Simulating Trusses | 11:28 | false | yes | 34,963 | yt-dlp | `transcripts/2023-03-18-oulfRfqTxJA-making-my-physics-engine-10x-faster-and-simulating-trusses.md` |
| 11 | 2023-04-12 | `n5CIlrOMKiU` | Simulating a V69 Engine for Research Purposes (warning: video contains math) | 13:55 | false | yes | 38,930 | yt-dlp | `transcripts/2023-04-12-n5CIlrOMKiU-simulating-a-v69-engine-for-research-purposes-warning-video.md` |
| 12 | 2023-04-28 | `4U41OxHiqI8` | Gas Engine Simulation in an EV Dirt Bike (it vrooms) | 9:30 | false | yes | 24,866 | yt-dlp | `transcripts/2023-04-28-4U41OxHiqI8-gas-engine-simulation-in-an-ev-dirt-bike-it-vrooms.md` |
| 13 | 2023-05-29 | `nh06yWG87rc` | The Engine Editor - Engine Simulator Devlog 1 | 13:16 | false | yes | 41,233 | yt-dlp | `transcripts/2023-05-29-nh06yWG87rc-the-engine-editor-engine-simulator-devlog-1.md` |
| 14 | 2023-07-01 | `JGiNLkgNC7s` | My Dumb Steam Game Got 90,000 Downloads in 30 Days | 14:14 | true | yes | 14,151 | notegpt.io | `transcripts/2023-07-01-JGiNLkgNC7s-my-dumb-steam-game-got-90-000-downloads-in-30-days.md` |
| 15 | 2023-09-07 | `rGNUHigqUBM` | Real-time Trumpet Simulation [C++/Vulkan] [WARNING: Flashing Lights] | 22:02 | false | yes | 60,437 | yt-dlp | `transcripts/2023-09-07-rGNUHigqUBM-real-time-trumpet-simulation-c-vulkan-warning-flashing-light.md` |
| 16 | 2023-09-24 | `FJatcAkC8XI` | Initial Audio Testing - Engine Simulator Devlog 3 | 14:41 | false | yes | 35,644 | yt-dlp | `transcripts/2023-09-24-FJatcAkC8XI-initial-audio-testing-engine-simulator-devlog-3.md` |
| 17 | 2023-10-31 | `-XHnDPCgIWk` | Real-time Engine Tuning - Engine Simulator Devlog 4 | 18:41 | false | yes | 32,776 | yt-dlp | `transcripts/2023-10-31--XHnDPCgIWk-real-time-engine-tuning-engine-simulator-devlog-4.md` |
| 18 | 2023-11-30 | `oUrYlZQVHvo` | Simulating a Chainsaw (Attempt 1) - Engine Simulator Devlog 5 | 15:35 | false | yes | 33,938 | yt-dlp | `transcripts/2023-11-30-oUrYlZQVHvo-simulating-a-chainsaw-attempt-1-engine-simulator-devlog-5.md` |
| 19 | 2024-01-31 | `ndUyNJEk4ng` | Major Improvements to Steam Engine Simulator | 11:06 | true | yes | 32,677 | notegpt.io | `transcripts/2024-01-31-ndUyNJEk4ng-major-improvements-to-steam-engine-simulator.md` |
| 20 | 2024-02-29 | `w8a9B2BgYSA` | Making a DLC for My Dumb Steam Game | 11:55 | true | yes | 37,227 | notegpt.io | `transcripts/2024-02-29-w8a9B2BgYSA-making-a-dlc-for-my-dumb-steam-game.md` |
| 21 | 2024-05-03 | `J11c8mMN1PA` | Multicylinder Engine Simulation - Engine Simulator Devlog 6 | 20:26 | false | yes | 16,366 | notegpt.io | `transcripts/2024-05-03-J11c8mMN1PA-multicylinder-engine-simulation-engine-simulator-devlog-6.md` |
| 22 | 2024-06-29 | `3aFYEyCoC4A` | Improving My Game With Tester Feedback | 17:49 | true | yes | 22,634 | yt-dlp | `transcripts/2024-06-29-3aFYEyCoC4A-improving-my-game-with-tester-feedback.md` |
| 23 | 2024-08-07 | `qj5F_s3veiU` | Adding Mechanical Sound Simulation to My Audio Engine | 18:50 | false | yes | 16,942 | yt-dlp | `transcripts/2024-08-07-qj5F_s3veiU-adding-mechanical-sound-simulation-to-my-audio-engine.md` |
| 24 | 2024-10-31 | `6MTY2U4ZhIA` | Steam Engine Simulator is Almost Done (for real this time) | 27:37 | true | yes | 76,115 | yt-dlp | `transcripts/2024-10-31-6MTY2U4ZhIA-steam-engine-simulator-is-almost-done-for-real-this-time.md` |
| 25 | 2025-10-25 | `sUdnJTC2w9I` | Improving My Engine Sound Simulator With Real Data | 27:07 | false | yes | 21,566 | yt-dlp | `transcripts/2025-10-25-sUdnJTC2w9I-improving-my-engine-sound-simulator-with-real-data.md` |
| 26 | 2026-05-05 | `82PUQ3Of9JM` | Creating Engine Simulator's Engine Editor | 12:17 | false | yes | 30,269 | yt-dlp | `transcripts/2026-05-05-82PUQ3Of9JM-creating-engine-simulator-s-engine-editor.md` |

**Total: 759,197 bytes (0.76 MB) across 26 files.**

Notes on quality:

- All transcripts carry `[mm:ss]` markers per paragraph (coarse timestamps survived everywhere; cite position as `file @ [mm:ss]`).
- `WPCMNnM6D0k` (VTEC) is legitimately sparse (3.7 KB for 17 min): long engine-sound demo segments with `[Music]` markers; paragraph timestamps run continuously 00:00–16:14, nothing missing.
- Auto-caption text: no punctuation/capitalization; speaker is Ange throughout.

## Proposed chunking for the cataloging wave

Corpus is 0.76 MB total, under the 1 MB single-chunk budget → **one chunk**; no file is split.

| chunk | files | bytes |
|---|---|---|
| **C1** | all 26 transcript files, chronological order as listed above | 759,197 |

Cataloging can run as a single agent over C1. If chunks are ever regenerated (corpus grows past 1 MB): whole transcript files per chunk, chronological order, split only at paragraph boundaries with `part n/m` + byte ranges.

