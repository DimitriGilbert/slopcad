<!--
| field | value |
|---|---|
| title | Improving My Game With Tester Feedback |
| videoId | 3aFYEyCoC4A |
| url | https://www.youtube.com/watch?v=3aFYEyCoC4A |
| published | 2024-06-29 |
| duration | 17:49 (1069s) |
| transcript source | YouTube auto-generated English captions |
| method | yt-dlp --write-auto-sub/--write-sub (en), VTT parsed to plain text |
| fetched | 2026-10-07 |
| approx chars | 21992 |
| borderline | true |
-->

# Improving My Game With Tester Feedback

[00:02] Hey what’s up guys and welcome back. Today we’re&nbsp; going to be working on Steam Engine Simulator’s&nbsp;&nbsp;

[00:07] new DLC. But first I’d like to thank BeamNG,&nbsp; Reyna, Maisteer, Joe and Bacteria Rancher for&nbsp;&nbsp;

[00:14] supporting me at the Master Mechanic level on&nbsp; Patreon and Brilliant for sponsoring this video.

[00:20] Brilliant dot org is a great platform&nbsp; that offers a wide variety of amazing,&nbsp;&nbsp;

[00:24] interactive courses. These courses have&nbsp; high quality, hands-on practice problems&nbsp;&nbsp;

[00:29] and demonstrations to make sure that you fully&nbsp; understand the subject matter they cover. So&nbsp;&nbsp;

[00:34] it’s not just memorization or information being&nbsp; presented on the screen, comprehension and real&nbsp;&nbsp;

[00:39] learning is the goal. Learning a little each&nbsp; day is a great habit to develop and will help&nbsp;&nbsp; you take your software skills to the next level.&nbsp; Probability is an important concept to understand&nbsp;&nbsp; for a lot of different software techniques and&nbsp; this course, “Predicting with Probability” is&nbsp;&nbsp;

[00:49] a great introduction to the topic. Overall, it’s a&nbsp; really great service and I highly recommend trying&nbsp;&nbsp;

[00:54] it out. To try all of Brilliant’s features for&nbsp; free for 30 days, visit brilliant.org/angethegreat&nbsp;&nbsp;

[01:01] or click on the link in the description.&nbsp; You’ll also get 20% off Brilliant’s annual&nbsp;&nbsp;

[01:05] premium subscription. Once again, thanks&nbsp; to Brilliant for sponsoring this video.

[01:10] Alight so this is what the DLC looked like the last time&nbsp; we talked about it. I said at the end of&nbsp;&nbsp;

[01:15] that video that: “we’re only missing a small&nbsp; gauge cluster and the mailbox feature and&nbsp;&nbsp;

[01:20] it’ll be ready for release.” I probably&nbsp; shouldn’t have said this so confidently though.

[01:25] Shortly after that video, I released a build to my&nbsp; testing group and what ensued was complete chaos.&nbsp;&nbsp;

[01:31] The Discord chat was immediately flooded with&nbsp; irate gamers. Some of the complaints were minor,&nbsp;&nbsp;

[01:37] like “the wires being too wobbly” or confusion&nbsp; about why the generator kept spinning even&nbsp;&nbsp;

[01:43] when the engine was disconnected. Things that I&nbsp; thought would be intuitive turned out to really&nbsp;&nbsp;

[01:48] not be for the majority of players. For example,&nbsp; I thought it was obvious that profitability would&nbsp;&nbsp;

[01:54] depend mostly on fuel economy. But virtually no&nbsp; one from the testing group picked up on this.&nbsp;&nbsp;

[02:00] Instead they accumulated 100s of thousands&nbsp; of dollars in debt while keeping the heat&nbsp;&nbsp;

[02:04] level way too high, which inevitably ended up&nbsp; blowing up their boilers, making them even more&nbsp;&nbsp;

[02:09] frustrated. And yes, you can blow up your boiler&nbsp; now but we’ll talk about that later in the video.

[02:15] In general, testers found the game stressful&nbsp; and unintuitive and complained that the&nbsp;&nbsp;

[02:20] difficulty progression was suboptimal. In case&nbsp; it wasn’t obvious, this game was not supposed&nbsp;&nbsp;

[02:24] to be a rage game, so the way players were&nbsp; reacting to it was not at all what I wanted.

[02:30] It was a complete disaster. This group&nbsp; was about as biased in my favor as&nbsp;&nbsp;

[02:35] possible since they were my own Patreon&nbsp; supporters. Paying customers on Steam who&nbsp;&nbsp;

[02:39] were not so invested in the project&nbsp; and weren’t as knowledgeable about&nbsp;&nbsp;

[02:43] engines as my testing group would&nbsp; likely have torn this game apart.

[02:48] Now, getting negative feedback like this&nbsp; wasn’t fun, but that was far from my&nbsp;&nbsp;

[02:52] biggest concern which was the effect this was&nbsp; going to have on Engine Simulator’s timeline.&nbsp;&nbsp;

[02:57] A large proportion of you watching are more&nbsp; interested in my main project Engine Simulator,&nbsp;&nbsp;

[03:02] which is what my channel is known for. A lot&nbsp; of my Patreon supporters are eagerly awaiting&nbsp;&nbsp;

[03:08] Engine Simulator updates. The simulation&nbsp; prototype that I demonstrated in my last&nbsp;&nbsp;

[03:12] video works really well and it’s just waiting to&nbsp; be made into the final product. No one wants to&nbsp;&nbsp;

[03:18] continue working on Engine Simulator more than I&nbsp; do, but the reality is, I just couldn’t do that.

[03:24] This DLC already had around 40,000 wishlists on&nbsp; Steam and at least a few thousand people actively&nbsp;&nbsp;

[03:30] following its progress on YouTube, Steam and&nbsp; Discord. Canceling it wasn’t an option without&nbsp;&nbsp;

[03:36] upsetting a lot of people and throwing away&nbsp; hundreds of hours of development time. However,&nbsp;&nbsp;

[03:41] releasing the product as it was, would&nbsp; have been even WORSE than canceling it.&nbsp;&nbsp;

[03:46] The hostility that I deal with on Steam is&nbsp; already enough that I dislike posting on the&nbsp;&nbsp;

[03:50] platform. I can’t imagine what I’d have&nbsp; to deal with after people both paid for&nbsp;&nbsp;

[03:55] this product and continued to spend 12 hours&nbsp; getting nowhere before demanding a refund.

[04:01] So I was stuck with a set of bad&nbsp; options and multiple large groups&nbsp;&nbsp;

[04:04] of people who all wanted different things&nbsp; from me. It was hard to tell if ANYTHING&nbsp;&nbsp;

[04:08] I was doing was making anyone happy. For&nbsp; example, in my last video about this DLC,&nbsp;&nbsp;

[04:14] the top comment was a suggestion for a&nbsp; completely different DLC. For the first&nbsp;&nbsp;

[04:20] time in my short game development career, the&nbsp; pressure was getting to be a bit too much.

[04:27] Alright, so now that we know what happened, we need to figure&nbsp; out how to solve this problem. And to do that,&nbsp;&nbsp;

[04:32] we need to come to terms with some&nbsp; realities first. No matter what I do,&nbsp;&nbsp;

[04:36] I won’t be able to keep everyone happy. I know&nbsp; this might seem perplexing to some of you,&nbsp;&nbsp;

[04:41] but it’s important to me to release this&nbsp; product in a state that I’m happy with&nbsp;&nbsp;

[04:45] and I want to do that before&nbsp; moving on to Engine Simulator.

[04:49] If you’re frustrated that I’m not working on&nbsp; exactly what you want me to be working on,&nbsp;&nbsp;

[04:54] I get it. I do get a surprising number&nbsp; of people asking or demanding that I&nbsp;&nbsp;

[04:59] work on a particular thing, which is a&nbsp; bit disappointing for me but it shows&nbsp;&nbsp;

[05:03] that people actually care about&nbsp; my work which is not a bad thing.

[05:07] Likewise, it seemed like the testers really&nbsp; didn’t enjoy this DLC, but at least now,&nbsp;&nbsp;

[05:12] they actually cared about the outcome of&nbsp; the game. In all previous versions, testers&nbsp;&nbsp;

[05:18] were mostly neutral, maybe even disengaged.&nbsp; The game was at least engaging players now,&nbsp;&nbsp;

[05:24] which was a step in the right direction. We&nbsp; just need to take the hundreds of points of&nbsp;&nbsp;

[05:28] feedback, and try to improve it while&nbsp; keeping the schedule under control.

[05:33] We’ll focus on its two major issues:&nbsp;

[05:36] The initial learning curve being too steep The difficulty progression not being very&nbsp;&nbsp;

[05:42] satisfying and leaving players bored&nbsp; at some points and frustrated at others

[05:48] Let’s look at the learning curve first. I tried&nbsp; to avoid including a tutorial in the game by&nbsp;&nbsp;

[05:53] making intuitive mechanics that required little&nbsp; to no explanation. The game’s primary loop that I&nbsp;&nbsp;

[05:59] mentioned in the last video mirrored real-life&nbsp; economic principles and worked like this:

[06:05] Lower fuel usage allows lower energy prices&nbsp;

[06:08] Lower energy prices increase&nbsp; demand for migration to the city&nbsp;

[06:13] Greater populations require more&nbsp;energy and larger of energy amounts can be produced more&nbsp;&nbsp;

[06:18] efficiently due to an economy of scale effect Higher efficiency allows lower fuel usage&nbsp;

[06:23] and the cycle continues, until&nbsp; the maximum population is reached

[06:27] I really overestimated how “obvious” this&nbsp; mechanic was to players. The game seemed&nbsp;&nbsp;

[06:33] perfectly understandable and logical to me since&nbsp; I developed it, but expecting players to figure it&nbsp;&nbsp;

[06:39] out immediately was probably not reasonable. Most&nbsp; kept the electricity price too high for too long,&nbsp;&nbsp;

[06:45] accumulating 100s of thousands of dollars without&nbsp; progressing. Others focused on just running the&nbsp;&nbsp;

[06:52] engine at whatever heat level worked, which was&nbsp; usually many times the required level for the&nbsp;&nbsp;

[06:57] conditions they were operating under. Some players&nbsp; completely misinterpreted the goal of the game and&nbsp;&nbsp;

[07:02] instead of maximizing population, maximized profit&nbsp; by adjusting the electricity price to always&nbsp;&nbsp;

[07:08] exceed their expenses, instead of adjusting their&nbsp; fuel use to keep expenses below their income.

[07:14] It was also unclear to players how all the&nbsp; controls were meant to be used. The intention&nbsp;&nbsp;

[07:19] was to present a set of basic controls and leave&nbsp; it to the player to figure out how to use them to&nbsp;&nbsp;

[07:24] achieve the game’s goal. However, most players&nbsp; didn’t seem to enjoy this process of discovery.

[07:30] To fix this problem, we can do what&nbsp; most games do and start with an easy&nbsp;&nbsp;

[07:33] section that introduces the player&nbsp; to the game’s controls and goals.

[07:38] I added a task list and a letter viewer to&nbsp; this empty area. Some of the visuals are&nbsp;&nbsp;

[07:43] still temporary so just ignore those for now.&nbsp; Having a list of tasks that need to be done and&nbsp;&nbsp;

[07:49] completing those tasks seems to be enjoyable&nbsp; and much easier to understand for players. I&nbsp;&nbsp;

[07:55] also created a simple mission tree to organize all&nbsp; of these tasks like most other games do. This is&nbsp;&nbsp;

[08:02] a generic system which will make it easier to&nbsp; implement the rest of the game’s story later.

[08:08] The first section consists of a few tutorial&nbsp; missions. The goals are mostly understandable&nbsp;&nbsp;

[08:13] from the task list alone but the complete&nbsp; details are given to the player through&nbsp;&nbsp;

[08:18] short letters from the game’s NPCs which will also give some background

[08:22] and history about the town. The&nbsp;town’s mayor and a local mechanic are&nbsp;&nbsp;

[08:26] the first two NPCs to make an appearance and&nbsp; they run you through some routine tasks like&nbsp;&nbsp;

[08:31] fixing the power lines, fixing a ruptured&nbsp; boiler and adjusting the engine’s controls.

[08:37] To teach the player about operating the steam&nbsp; engine, I went a step further and added an AI&nbsp;&nbsp;

[08:42] that can run the steam engine autonomously.&nbsp; I could have hacked the simulation to force&nbsp;&nbsp;

[08:46] particular speeds or values at particular times,&nbsp; but I think the AI approach is much more powerful.

[08:54] Firstly, it proves to the player through&nbsp; direct demonstration that the game is&nbsp;&nbsp;

[08:58] possible with the right inputs. It can also work as a copilot,&nbsp;&nbsp;

[09:02] allowing the player to control a few of&nbsp; the settings while it handles the rest.&nbsp;&nbsp;

[09:07] This allows the game to slowly transfer&nbsp; responsibilities to the player as they&nbsp;&nbsp;

[09:11] become more familiar with the game. The AI can also be used for automated&nbsp;&nbsp;

[09:18] testing that would have otherwise&nbsp; taken me hours of manual gameplay.

[09:23] It’s oddly satisfying to watch the AI adjust&nbsp; the steam engine in response to changing load,&nbsp;&nbsp;

[09:29] so I might use it for something in the&nbsp; future, maybe as a separate game mode.&nbsp;&nbsp;

[09:33] If you’re wondering how this AI works, it’s a&nbsp; pretty simple feedback loop system. The output&nbsp;&nbsp;

[09:38] parameters that we are interested in are&nbsp; water temperature, engine speed and water&nbsp;&nbsp;

[09:42] level. Each of these outputs is primarily&nbsp; controlled by the heat level, throttle valve&nbsp;&nbsp;

[09:48] and water valve respectively. We also have two&nbsp; safety devices, the relief valve and the brake,&nbsp;&nbsp;

[09:55] which can be used to prevent boiler overpressure&nbsp; and engine overspeeding. These safety controls&nbsp;&nbsp;

[10:00] do reduce efficiency when they’re enabled, so&nbsp; they’re only used in exceptional circumstances.

[10:06] Each of the feedback loops senses the&nbsp; output and incrementally adjusts the&nbsp;&nbsp;

[10:10] input until that output value is reached.&nbsp; In the case of engine speed for example,&nbsp;&nbsp;

[10:15] if it starts dropping below the target speed,&nbsp; the throttle setting will be increased. When&nbsp;&nbsp;

[10:21] the throttle valve is open, more steam will flow&nbsp; out from the boiler which will cool the water,&nbsp;&nbsp;

[10:26] likely causing an increase in the heat&nbsp; setting from the heat feedback loop. The&nbsp;&nbsp;

[10:30] systems mostly do not know about each other and&nbsp; work independently to keep everything balanced.

[10:37] Next we’re going to take a look at fixing the&nbsp; game’s difficulty progression. One of my testers&nbsp;&nbsp;

[10:42] kindly put together this chart illustrating the&nbsp; problem. We can safely assume that the left half&nbsp;&nbsp;

[10:47] of the chart refers to the steep learning&nbsp; curve which should be mitigated by the&nbsp;&nbsp;

[10:52] tutorial that we added earlier. The progression&nbsp; from 4000-12000 people seems pretty reasonable&nbsp;&nbsp;

[10:59] until we see some of the modifications&nbsp; that another tester added to this graph.&nbsp;&nbsp;

[11:04] It seems that the real issue here&nbsp; is that the game is too easy and&nbsp;&nbsp;

[11:08] does not present enough challenges&nbsp; in the middle of the progression.

[11:12] So why did this happen, especially when&nbsp; I put in so much effort in the last video&nbsp;&nbsp;

[11:17] to specifically prevent this from happening?&nbsp; Well, the early game frustration definitely&nbsp;&nbsp;

[11:22] didn’t help but beyond that, I think there&nbsp; were some flaws in the approach I used. So,&nbsp;&nbsp;

[11:27] I developed a new model which&nbsp; should solve these issues.

[11:31] To understand this new approach, we first need&nbsp; to understand what we’re even measuring here.&nbsp;&nbsp;

[11:35] The game is about engine efficiency, so we&nbsp; need to compare the player’s performance&nbsp;&nbsp;

[11:40] with some sort of benchmark. The problem&nbsp; is that we’re using a real simulation,&nbsp;&nbsp;

[11:45] so we don’t know or have direct control over&nbsp; its exact performance characteristics. Just&nbsp;&nbsp;

[11:51] like last time, we need to study the engine&nbsp; and characterize its behavior. I added some&nbsp;&nbsp;

[11:57] debugging features to help with this and&nbsp; eliminate as much human error as possible,&nbsp;&nbsp;

[12:02] which I think may have skewed some of my&nbsp; results from last time. The end result was&nbsp;&nbsp;

[12:07] a function that maps power demand to the&nbsp; minimum required heat setting at steady&nbsp;&nbsp;

[12:12] state. This establishes an upper limit for&nbsp; how efficiently the engine can be operated.

[12:18] We can use this to calculate the theoretical&nbsp; lowest cost that energy can be sold at. The&nbsp;&nbsp;

[12:24] problem is that this value varies with power&nbsp; demand. Just feeding the current power demand&nbsp;&nbsp;

[12:29] into this model to get the lowest possible&nbsp; price gives us an instantaneous value&nbsp;&nbsp;

[12:34] which can fluctuate drastically. I tested many&nbsp; solutions to this and ultimately decided on using&nbsp;&nbsp;

[12:40] a rolling 24 hour average. While implementing&nbsp; this, I realized that there was a serious flaw&nbsp;&nbsp;

[12:47] in the previous model. Simply time-averaging&nbsp; the power demand and then feeding that into&nbsp;&nbsp;

[12:53] the market price model doesn’t give the average&nbsp; market price over that period, which explains why&nbsp;&nbsp;

[12:59] the game was so easy before. I won’t go into the&nbsp; math behind this but I will heart any comments on&nbsp;&nbsp;

[13:05] this video which give the correct mathematical&nbsp; explanation for why this is wrong and how to&nbsp;&nbsp;

[13:10] correct it. It’s not too hard to figure out&nbsp; and it was a pretty careless error on my part.

[13:15] The NPCs will explain how this energy price&nbsp; mechanic works as part of the player’s training,&nbsp;&nbsp;

[13:21] but to make it even more clear, the metrics&nbsp; are visualized with these approval bars,&nbsp;&nbsp;

[13:26] showing affordability, reliability,&nbsp; popularity and overall demand.

[13:32] Using the AI that I created earlier, I was able&nbsp; to verify that the model was correct and roughly&nbsp;&nbsp;

[13:37] followed the AI’s performance. The AI isn’t&nbsp; perfect but likely performs better than most&nbsp;&nbsp;

[13:43] humans. Now that we have a precise benchmark&nbsp; to compare the player’s performance to,&nbsp;&nbsp;

[13:48] we can precisely adjust the difficulty&nbsp; by varying the leeway given to the player&nbsp;&nbsp;

[13:53] as the city gets bigger. The game might start&nbsp; with a 20% unfair advantage against the market&nbsp;&nbsp;

[13:59] which goes to 0% as the city grows, effectively&nbsp; making the game harder and harder. I don’t want&nbsp;&nbsp;

[14:05] to leave the difficulty progression entirely up to&nbsp; this though which brings us to our next feature.

[14:12] I won’t give away too many spoilers, but&nbsp; let’s just say, the player will need to react&nbsp;&nbsp;

[14:16] to problems that become progressively more&nbsp; challenging. For example, a drought natural&nbsp;&nbsp;

[14:21] disaster will prevent the player from being&nbsp; able to fill the boiler with water. They can,&nbsp;&nbsp;

[14:26] however, prepare for this by filling the&nbsp; boiler beforehand enough to survive through&nbsp;&nbsp;

[14:31] the disaster. This is just one of many&nbsp; other challenges like throttle failure,&nbsp;&nbsp;

[14:36] sudden increases in demand which&nbsp; will force the player to think&nbsp;&nbsp;

[14:40] creatively and break the monotony of&nbsp; the predictable day/night demand cycle.

[14:45] These challenges will follow the game’s storyline&nbsp; which I don’t want to reveal too much about,&nbsp;&nbsp;

[14:50] but it’s another way of more precisely adjusting&nbsp; the difficulty curve as the game progresses.

[14:56] There were many other minor points&nbsp; of feedback from testers which I&nbsp;&nbsp;

[14:59] also addressed. I’ll list just&nbsp;a few of the larger changes in this video: like for example

[15:04] I added some sound effects for power outages, repairs, gear shifts and other events.&nbsp;&nbsp;

[15:10] [Powering up sound]

[15:15] [Powering down sound]

[15:19] [Clicking sounds]

[15:24] [Lever sounds]

[15:30] [Ratchet and impact wrench] Testers often missed cable snapping events and&nbsp;&nbsp;

[15:36] an audio notification should help with this. [Cables snapping]

[15:44] I added boiler&nbsp;explosions because they’ve been heavily&nbsp; requested since the game released and I&nbsp;&nbsp;

[15:50] felt that the game didn’t have enough negative&nbsp; consequences for overheating the boiler

[15:54] at least for the DLC. For the base game mode it doesn't really factor into it that much, but it is there by popular demand.

[16:05] In total, this project consists of around 86,000&nbsp; lines of code. About half of that is for the game&nbsp;&nbsp;

[16:12] engine and physics engine which I had already&nbsp; written before. The remaining 42,000 lines is&nbsp;&nbsp;

[16:17] specific to this project. Line count isn’t a&nbsp; great metric to evaluate project scale, but&nbsp;&nbsp;

[16:24] the point is that creating highly quality software&nbsp; with attention to detail takes a lot of time and&nbsp;&nbsp;

[16:29] effort. I know it looks simple but I really don’t&nbsp; think development could be sped up, at least from&nbsp;&nbsp;

[16:34] a single person team like myself. Using a&nbsp; game engine like Unreal wouldn’t help since&nbsp;&nbsp;

[16:39] this project is not game engine bottlenecked.&nbsp; My game engine has performed perfectly well and&nbsp;&nbsp;

[16:44] this game has been tested on 100s of thousands of&nbsp; computers at this point. I have all the debugging&nbsp;&nbsp;

[16:49] tools I need to make the game, it just really&nbsp; does take a lot of effort if you want everything

[16:55] to be perfect and I really want people to feel like (for the money that they're paying) they're actually

[17:00] getting something good, especially considering that the base game was free. If you're interested

[17:04] in what my day-to-day development progress looks&nbsp; like, I post detailed daily updates on Discord,&nbsp;&nbsp;

[17:09] so feel free to join the Engine Simulator discord&nbsp; server. The link to that is in the description.

[17:15] I’d like to thank all my Patreon supporters&nbsp; for being very patient with my perfectionism&nbsp;&nbsp;

[17:20] and making this project possible. They&nbsp; will all of course be getting a free&nbsp;&nbsp;

[17:24] copy of this DLC. And of course thanks&nbsp; to Brilliant for sponsoring this video&nbsp;&nbsp;

[17:29] and thank you for watching,&nbsp; I’ll see you all next time.
