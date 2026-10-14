<!--
| field | value |
|---|---|
| title | Improving My Engine Sound Simulator With Real Data |
| videoId | sUdnJTC2w9I |
| url | https://www.youtube.com/watch?v=sUdnJTC2w9I |
| published | 2025-10-25 |
| duration | 27:07 (1627s) |
| transcript source | YouTube auto-generated English captions |
| method | yt-dlp --write-auto-sub/--write-sub (en), VTT parsed to plain text |
| fetched | 2026-10-07 |
| approx chars | 20910 |
| borderline | false |
-->

# Improving My Engine Sound Simulator With Real Data

[00:03] Hey what’s up guys. Today we’re finally back&nbsp; to working on Engine Simulator but before we&nbsp;&nbsp;

[00:07] do that I’d like to thank BeamNG, Rena, Maisteer,&nbsp; Joe and Bacteria Rancher for supporting me at the&nbsp;&nbsp;

[00:14] master mechanic level on Patreon. This is the&nbsp; POWERFIST 212 which is sort of the Canadian&nbsp;&nbsp;

[00:25] version of the Predator 212. It’s a single&nbsp; cylinder engine and we’re going to be using&nbsp;&nbsp;

[00:30] it today to conduct basic testing and collect data&nbsp; we can compare my engine simulation to. To measure&nbsp;&nbsp;

[00:36] the sound pressure emitted from the exhaust, I&nbsp; bought this measurement microphone. In theory,&nbsp;&nbsp;

[00:41] microphones are linear measurement devices which&nbsp; convert a sound pressure to a voltage. Now, there&nbsp;&nbsp;

[00:47] may be some non-linearity in my USB interface or&nbsp; anywhere else in the recording chain, but for my&nbsp;&nbsp;

[00:53] purposes, this should be accurate enough. The&nbsp; only thing left to do is calibrate the setup,&nbsp;&nbsp;

[00:58] which is what this sound level calibrator is&nbsp; for. It outputs a 1 kHz sine wave and generates&nbsp;&nbsp;

[01:03] a known sound pressure within this cavity.&nbsp; All we need to do is insert the microphone,&nbsp;&nbsp;

[01:09] turn on the calibrator, record a few seconds&nbsp; of audio, and now we have a reference waveform&nbsp;&nbsp;

[01:14] that we can use to calculate the microphone’s&nbsp; pressure sensitivity and calibrate our readings.&nbsp;&nbsp;

[01:19] We’re more interested in the overall waveform&nbsp; for this video and not necessarily amplitude,&nbsp;&nbsp;

[01:24] but calibrated amplitude measurements did help&nbsp; me to confirm that the simulator’s predictions&nbsp;&nbsp;

[01:29] aligned with real engines. So here’s my low budget&nbsp; test rig. After filling up with gas and setting up&nbsp;&nbsp;

[01:36] my control station we were ready for some testing.&nbsp; For the first few tests, I left the stock muffler&nbsp;&nbsp;

[01:42] on the engine. This engine uses a governor which&nbsp; is a speed regulating device. It can be bypassed&nbsp;&nbsp;

[01:56] pretty easily by just sticking your hand under the&nbsp; gas tank and moving the throttle manually, but I&nbsp;&nbsp;

[02:02] don’t recommend this because the engine is not&nbsp; designed to rev past 3800 rpm. To make a better&nbsp;&nbsp;

[02:10] comparison, I replaced the OEM muffler with an&nbsp; aftermarket straight pipe exhaust. You’ll notice&nbsp;&nbsp;

[02:17] that it changes the exhaust sound considerably&nbsp; and this is even more obvious at lower RPM.&nbsp;&nbsp;

[02:52] You can hear a direct comparison between muffled&nbsp; and unmuffled exhaust in this demonstration.&nbsp;&nbsp;

[03:06] The engine is also considerably louder&nbsp; when under load. For legal reasons,&nbsp;&nbsp;

[03:11] I don’t want to show how the engine was&nbsp; loaded but let’s just say it involved&nbsp;&nbsp;

[03:15] some wood and a lot of smoke. Notice&nbsp; the difference in absolute magnitude&nbsp;&nbsp;

[03:24] between the engine running with no load&nbsp; and when fully loaded at the same RPM.&nbsp;&nbsp;

[03:38] Alright, now that we have some reference audio,&nbsp;&nbsp; let’s move over to the simulation realm. We’re&nbsp; going to be comparing two simulators today,&nbsp;&nbsp;

[03:46] the old Engine Simulator and the&nbsp; new version I’m working on. First,&nbsp;&nbsp;

[03:50] let’s listen to the audio from the old Engine&nbsp; Simulator so we know our starting point.&nbsp;&nbsp;

[04:09] I wouldn’t say that it’s that bad, especially&nbsp; considering how simple the simulation is. But,&nbsp;&nbsp;

[04:14] the inaccuracies definitely show up most when&nbsp; the engine is idling and decelerating. Clearly&nbsp;&nbsp;

[04:20] those are the conditions under which the gas&nbsp; dynamics in the exhaust become more important.&nbsp;&nbsp;

[04:25] This requires a more advanced fluid&nbsp; simulation to capture. I already implemented&nbsp;&nbsp;

[04:31] a decent high resolution fluid simulation, but&nbsp; there are some issues with it. I was under a&nbsp;&nbsp;

[04:36] lot of time pressure so I couldn’t put the&nbsp; level of care into it that I really wanted&nbsp;&nbsp;

[04:40] to. It worked and made decent audio, but&nbsp; I didn’t fully understand what I was doing&nbsp;&nbsp;

[04:45] which prevented me from improving it or adding&nbsp; more complex components like tube junctions.&nbsp;&nbsp;

[04:52] So, I went back to basics and studied fluid&nbsp; simulations much more rigorously. This took&nbsp;&nbsp;

[04:58] hundreds of hours of work and today we’re going to&nbsp; look at this new fluid simulation layer by layer&nbsp;&nbsp;

[05:03] to understænd it and its limitations. First let’s&nbsp; start off with the simplest possible simulation.&nbsp;&nbsp;

[05:09] For the interior of the tube we’re going to use a&nbsp; very simplistic differential equation solver. For&nbsp;&nbsp;

[05:15] the ends of the tube which are counterintuitively&nbsp; the most difficult part to simulate, we’re going&nbsp;&nbsp;

[05:19] to start with the very approximate valve and&nbsp; outlet model I used in my previous Engine&nbsp;&nbsp;

[05:24] Simulator video. I’ll play a calibrated recording&nbsp; of the real POWERFIST first for reference.&nbsp;&nbsp;

[05:54] The most obvious issue is that it sounds a bit&nbsp; muffled. A more precise way to put it is that the&nbsp;&nbsp;

[06:00] output is missing high frequency detail as though&nbsp; it was low-pass filtered at some point. This is&nbsp;&nbsp;

[06:05] unfortunately just a mathematical reality of how&nbsp; fluid simulations work. In this case we are using&nbsp;&nbsp;

[06:12] a very simplistic partial differential equation&nbsp; solver which introduces a lot of artificial&nbsp;&nbsp;

[06:17] dissipation into the solution. By artificial&nbsp; dissipation I mean that the signal is becoming&nbsp;&nbsp;

[06:22] rounded over at the edges as though it’s worn down&nbsp; or eroded. There are two main techniques we can&nbsp;&nbsp;

[06:28] use to rectify this. We can either subdivide the&nbsp; simulation into a finer grid, or we can just use&nbsp;&nbsp;

[06:34] a better solver. The first option is simpler,&nbsp; but requires more computation because we need&nbsp;&nbsp;

[06:41] more cells, but since the method is cheap, it&nbsp; doesn’t seem like such a big deal. However,&nbsp;&nbsp;

[06:46] for complicated reasons the performance&nbsp; cost actually grows non-linearly as the&nbsp;&nbsp;

[06:52] resolution increases, quickly making this approach&nbsp; impractical. Brute forcing a bad technique into&nbsp;&nbsp;

[06:58] producing sharp output obviously isn’t ideal,&nbsp; so we’ll instead look to more advanced methods.&nbsp;&nbsp;

[07:04] High resolution solvers allow us to get sharper&nbsp; results with the main downside being a slightly&nbsp;&nbsp;

[07:09] higher computational demand per cell. This doesn’t&nbsp; matter though, because we can just use fewer cells&nbsp;&nbsp;

[07:15] to get the same result so they actually end up&nbsp; being faster. By default, these methods are not&nbsp;&nbsp;

[07:21] stable though and introduce spurious oscillations&nbsp; into the solution. You can see them here forming&nbsp;&nbsp;

[07:26] near large gradients. This doesn’t negatively&nbsp; impact the audio even though the solution is&nbsp;&nbsp;

[07:32] visually obscured. The real problem is that the&nbsp; oscillations grow and eventually cause numerical&nbsp;&nbsp;

[07:38] instability which then spreads to the rest of the&nbsp; simulation. These oscillations are unavoidable and&nbsp;&nbsp;

[07:44] this can be proven mathematically. However, we&nbsp; can circumvent this issue using flux or gradient&nbsp;&nbsp;

[07:50] limiters. A gradient limiter is a mathematical&nbsp; device that pre-processes the simulation input&nbsp;&nbsp;

[07:56] to filter out large discontinuities, though&nbsp; this is somewhat of an oversimplification&nbsp;&nbsp;

[08:01] as it can also exaggerate certain features. To&nbsp; visualize how it works, imagine that we have a&nbsp;&nbsp;

[08:07] 1-dimensional simulation which is composed of&nbsp; finite volume cells. If we plot pressure and&nbsp;&nbsp;

[08:13] assume that it’s uniform in each cell, we end up&nbsp; with a piecewise-constant reconstruction of our&nbsp;&nbsp;

[08:18] domain. Using this input will yield a stable but&nbsp; diffusive solution where a lot of high frequency&nbsp;&nbsp;

[08:25] detail is lost. In other words, the solution looks&nbsp; softer with less defined features. [demo] Using&nbsp;&nbsp;

[08:31] a linear piecewise reconstruction gives a more&nbsp; mathematically accurate solution but introduces&nbsp;&nbsp;

[08:37] spurious oscillations. Applying a gradient limiter&nbsp; to the slopes of each segment produces a generally&nbsp;&nbsp;

[08:44] accurate reconstruction with only extreme&nbsp; gradients being attenuated. This results in a&nbsp;&nbsp;

[08:50] solution that doesn’t have spurious oscillations&nbsp; and is visually more correct. Unfortunately,&nbsp;&nbsp;

[08:56] there is a cost to gradient limiters. Just&nbsp; because a signal looks clean and stable,&nbsp;&nbsp;

[09:00] does not necessarily mean it sounds better.&nbsp; I set up this demonstration which shows what&nbsp;&nbsp;

[09:05] happens when we transmit a signal through a&nbsp; tube. Subjectively, the output of the naive,&nbsp;&nbsp;

[09:11] unstable method sounds fairly clean like a signal&nbsp; that was run through a low-pass filter. The&nbsp;&nbsp;

[09:16] gradient-limited solution, however, has noticeable&nbsp; high frequency artifacts. There are numerous&nbsp;&nbsp;

[09:35] gradient limiters, all with slightly different&nbsp; advantages and disadvantages and I implemented&nbsp;&nbsp;

[09:40] pretty much all of the commonly used variants.&nbsp; But, they all exhibit some form of artifacting.&nbsp;&nbsp;

[09:47] This is all simply to say: we are reaching&nbsp; mathematical limits to how accurate and sharp&nbsp;&nbsp;

[09:52] the simulation can be. To make sure this was&nbsp; actually a theoretical limit and not simply an&nbsp;&nbsp;

[09:58] implementation error, I implemented multiple fluid&nbsp; simulation techniques which theoretically must all&nbsp;&nbsp;

[10:04] converge to the same solution, and they do, albeit&nbsp; at different rates. Many of these techniques do&nbsp;&nbsp;

[10:10] not have any code or conceptual commonalities yet&nbsp; they still give the same answer. So it is very&nbsp;&nbsp;

[10:16] very unlikely for all of them to be implemented&nbsp; wrong in the same exact way. Therefore,&nbsp;&nbsp;

[10:22] we can rule out any major implementation errors&nbsp; in the simulation. Most of the artifacts that&nbsp;&nbsp;

[10:28] remain likely cannot be fixed without much more&nbsp; advanced methods, or they must be worked around&nbsp;&nbsp;

[10:34] cleverly. After adding the high resolution solver,&nbsp; the audio from our simulated POWERFIST doesn’t&nbsp;&nbsp;

[10:41] sound as muffled as it did before. For most of the&nbsp; comparisons going forward, I’m going to show the&nbsp;&nbsp;

[10:45] audio from the previous step first, followed&nbsp; by the audio clip showing the improvements.&nbsp;&nbsp;

[11:16] Instead of sounding muffled, it now sounds like&nbsp; we’ve boarded an alien intergalactic vessel,&nbsp;&nbsp;

[11:21] obviously with aliens still on board. I want&nbsp; to emphasize that the simulation is definitely&nbsp;&nbsp;

[11:27] implemented correctly. I didn’t purposefully&nbsp; make it sound ridiculous for dramatic effect.&nbsp;&nbsp;

[11:32] The confusion that you’re experiencing right now&nbsp; is the same confusion I experienced while working&nbsp;&nbsp;

[11:37] on this. Imagine spending hundreds of hours&nbsp; building a simulation, making sure it was correct,&nbsp;&nbsp;

[11:44] only to find that this is the output. Clearly,&nbsp; something is missing but you don’t know what it&nbsp;&nbsp;

[11:49] is. This trial and error process of figuring&nbsp; out what needed to be added to the simulation&nbsp;&nbsp;

[11:55] is where the vast majority of my time went. To&nbsp; give you some idea of how much work this took,&nbsp;&nbsp;

[12:00] I have rendered almost 7000 individual&nbsp; audio clips using this simulation and&nbsp;&nbsp;

[12:05] I’ve listened to every single one. That’s around&nbsp; 30 hours of just listening to clips like this.&nbsp;&nbsp;

[12:19] There were definitely times while working on this&nbsp; project where I started to believe that my goals&nbsp;&nbsp;

[12:42] were impossible to achieve and it’s part of the&nbsp; reason why this video took so long to create.&nbsp;&nbsp;

[12:48] For the rest of the video, just keep in mind&nbsp; you really have to wait until the end for the&nbsp;&nbsp;

[12:53] simulation to reach its final form. And even then,&nbsp; just remember it’s still a simulation and it will&nbsp;&nbsp;

[12:58] never be exactly like real life. I know a lot of&nbsp; people have very high expectations for my work at&nbsp;&nbsp;

[13:04] this point, but I’m sorry to say that we might&nbsp; be reaching theoretical limits in what can be&nbsp;&nbsp;

[13:09] achieved. Anyway, let’s try to fix this audio. The&nbsp; most logical place to start would be the valves&nbsp;&nbsp;

[13:15] and outlets because the boundary condition for&nbsp; valves I created previously is definitely wrong&nbsp;&nbsp;

[13:21] and I knew it at the time. It was just meant&nbsp; to be a simple, temporary implementation until&nbsp;&nbsp;

[13:26] I replaced it with something more accurate. The&nbsp; model I replaced it with is a classic valve model&nbsp;&nbsp;

[13:32] described by Benson, one of the forefathers&nbsp; of engine simulations. Benson also gave an&nbsp;&nbsp;

[13:38] algorithm to solve the non-linear equations of&nbsp; this model, but I couldn’t get it to work well,&nbsp;&nbsp;

[13:43] so I created my own algorithm with better&nbsp; performance and convergence properties. I say&nbsp;&nbsp;

[13:48] this very casually, but this on its own took over&nbsp; a hundred hours of work and I might discuss this&nbsp;&nbsp;

[13:54] algorithm in its own video at some point. So here&nbsp; is what it sounds like with this new valve model.&nbsp;&nbsp;

[14:25] The sound has improved slightly, but our&nbsp; simulation does not have enough dissipation,&nbsp;&nbsp;

[14:30] leading to this excessive resonance. Real&nbsp; tubes dissipate energy via friction and heat&nbsp;&nbsp;

[14:35] loss. If we add the friction and heat transfer&nbsp; simulation from the last prototype I built,&nbsp;&nbsp;

[14:41] it does sound a bit better. I realized, however,&nbsp; that the heat transfer model was implemented&nbsp;&nbsp;

[15:03] incorrectly. I overlooked this at the time because&nbsp; I didn’t think that heat transfer had significant&nbsp;&nbsp;

[15:09] effects on sound. Some papers even omitted&nbsp; heat transfer and claimed that it didn’t affect&nbsp;&nbsp;

[15:14] accuracy that much. This might be true in terms of&nbsp; overall accuracy, but I did notice that it had a&nbsp;&nbsp;

[15:21] significant impact on the subjective quality of&nbsp; the sound as can be heard in this audio sample.&nbsp;&nbsp;

[15:55] The simulator is also capable of handling&nbsp; different materials with different heat&nbsp;&nbsp;

[15:59] conductance properties and even the surface finish&nbsp; can be specified which can be used to model things&nbsp;&nbsp;

[16:04] like cast iron manifolds. The next issue to&nbsp; address is turbulence or the lack thereof.&nbsp;&nbsp;

[16:13] Turbulent flows form at the valve, within the pipe&nbsp; itself and at the outlet and I believe this is&nbsp;&nbsp;

[16:19] partially responsible for the characteristic,&nbsp; fuzzy pulsing sound that engines generate.&nbsp;&nbsp;

[16:26] Turbulence is extremely complicated and&nbsp; impossible to fully simulate in 1 dimension,&nbsp;&nbsp;

[16:31] but I implemented a simple model anyway. It needs&nbsp;&nbsp; a bit of tweaking and it is pretty&nbsp; subtle but I think it’s fine for now.&nbsp;&nbsp;

[17:05] So, as far as following the primary literature&nbsp; on engine simulations, this is as far as it’ll&nbsp;&nbsp;

[17:10] take us. However, something is not quite right.&nbsp; This problem becomes evident if we try driving&nbsp;&nbsp;

[17:16] an audio signal into a tube. It sounds very&nbsp; strange and what’s even stranger is that this&nbsp;&nbsp;

[17:34] problem only becomes worse as the simulation&nbsp; quality is increased. So what’s going on here?&nbsp;&nbsp;

[17:49] If we look at a spectrogram of the signal, we see&nbsp; these lines at regularly spaced intervals. These&nbsp;&nbsp;

[17:58] correspond to the resonant frequencies of the tube&nbsp; which primarily depend on the tube’s length. For&nbsp;&nbsp;

[18:04] example, here’s a long tube. And here’s a short&nbsp; tube. I have these lengths of tubing and you’ll&nbsp;&nbsp;

[18:18] notice that talking into them in real life&nbsp; doesn’t cause them to resonate as intensely.&nbsp;&nbsp;

[18:30] I noticed something similar in the data collected&nbsp; from the POWERFIST test. You can clearly see a&nbsp;&nbsp;

[18:35] peak at the fundamental frequency of the exhaust&nbsp; tube, but no other harmonics seem to be present.&nbsp;&nbsp;

[18:49] My theory is that the simulation of the tube&nbsp; boundary is too perfect and virtually any&nbsp;&nbsp;

[18:54] input signal excites basically all resonant&nbsp; frequencies at the same time. In reality,&nbsp;&nbsp;

[19:00] high frequency components do not get reflected&nbsp; as efficiently preventing the formation of&nbsp;&nbsp;

[19:05] high frequency standing waves. I created a&nbsp; model that accounts for this and it improved&nbsp;&nbsp;

[19:10] the predicted waveform considerably. Now&nbsp; let’s compare our final simulated result&nbsp;&nbsp;

[19:26] to the real recordings. It’s a bit hard&nbsp; because the real engine produces a lot of&nbsp;&nbsp;

[19:31] mechanical noise. I’m going to alternate&nbsp; between the muffled and unmuffled output,&nbsp;&nbsp;

[19:36] which helped me to mentally isolate the exhaust&nbsp; sound which is what we’re interested in.&nbsp;&nbsp;

[22:17] Alright, let’s try a slightly more complicated&nbsp; engine. In my second-ever Engine Simulator video,&nbsp;&nbsp;

[22:22] I showed a Harley Davidson engine. This&nbsp; was probably one of the worst engines&nbsp;&nbsp;

[22:26] in that video because the simulator just&nbsp; wasn’t capable of modelling the complex&nbsp;&nbsp;

[22:30] dynamics in the exhaust tubes. So let’s see&nbsp; if it sounds better in the new simulation.&nbsp;&nbsp;

[23:44] Alright, I had a whole section of this video&nbsp; dedicated to discussing pipe junctions and&nbsp;&nbsp;

[23:49] larger engines but I decided to cover&nbsp; it in a separate video instead because&nbsp;&nbsp;

[23:53] it still needs a bit of work. However,&nbsp; I will share some short clips of a few&nbsp;&nbsp;

[23:57] engines that use the new junction simulation.&nbsp; Please remember these are works-in-progress.&nbsp;&nbsp;

[25:34] We will come back to improving the simulation&nbsp; and the audio output, but we’ve run out of time&nbsp;&nbsp;

[25:38] in this phase of development and I need to move&nbsp; on to something else. It’s also extremely tedious&nbsp;&nbsp;

[25:43] to continue testing in this haphazard environment.&nbsp; We really need a user interface to design engines,&nbsp;&nbsp;

[25:50] set up test cases and of course so we can actually&nbsp; get this simulation released on Steam. So that’s&nbsp;&nbsp;

[25:55] what I’ll work on next and I do plan to return&nbsp; to a semi-regular upload schedule. I do have the&nbsp;&nbsp;

[26:01] store page set up if you guys want to wishlist the&nbsp; game. I know that a lot of people want a release&nbsp;&nbsp;

[26:06] date but I only give release dates that I’m 100%&nbsp; sure are doable and it’s too early to make any&nbsp;&nbsp;

[26:11] predictions with confidence. Once the program is&nbsp; released though, I will continue to refine the&nbsp;&nbsp;

[26:17] simulation and add features but for now, it’s&nbsp; functionally complete and supports everything&nbsp;&nbsp;

[26:22] I need it to support for an initial release.&nbsp; Thanks to my dad and my brother for helping&nbsp;&nbsp;

[26:27] me set up and record the engine testing segment.&nbsp; My brother has actually started his own YouTube&nbsp;&nbsp;

[26:33] channel which I strongly recommend checking&nbsp; out. The link to that is in the description.&nbsp;&nbsp;

[26:37] Thanks to my Patreon supporters for making this&nbsp; whole project possible and being very patient&nbsp;&nbsp;

[26:43] with my perfectionism. And of course, thank&nbsp; you for watching. I’ll see you all next time.
