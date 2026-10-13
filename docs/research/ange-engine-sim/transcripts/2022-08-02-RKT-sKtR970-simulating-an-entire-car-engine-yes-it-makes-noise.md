<!--
| field | value |
|---|---|
| title | Simulating an Entire Car Engine (yes, it makes noise) |
| videoId | RKT-sKtR970 |
| url | https://www.youtube.com/watch?v=RKT-sKtR970 |
| published | 2022-08-02 |
| duration | 12:04 (724s) |
| transcript source | YouTube auto-generated English captions |
| method | yt-dlp --write-auto-sub/--write-sub (en), VTT parsed to plain text |
| fetched | 2026-10-07 |
| approx chars | 8734 |
| borderline | false |
-->

# Simulating an Entire Car Engine (yes, it makes noise)

[00:34] oh hey what's up guys and welcome back what you just watched was a real-time internal combustion

[00:40] engine simulation that i've been working on for the past few months now i've always been

[00:45] pretty disappointed with the quality of car engine sounds in games and when i used to

[00:49] play playstation 2 back in the day and knew absolutely nothing about programming i often

[00:55] wondered why it wasn't possible to just realistically simulate the entire engine well i figured

[01:02] that it was finally time to answer this question for myself so here's a prime example of one

[01:07] of these bad car engine sounds [Music]

[01:21] now i know that most of these are optimized for performance so i don't expect them to

[01:25] be perfect but i still think that they can be improved but what exactly makes it bad

[01:30] in the first place well first of all engines sound different under different conditions

[01:36] so for example an engine is going to sound different when it's idling compared to when

[01:40] it's under heavy load or when it's decelerating and i feel like this is often overlooked in

[01:45] a lot of these games engines also have non-linear response characteristics and what i mean by

[01:51] this is that the gas pedal does not dictate a speed to the engine like it might in the

[01:57] case of electric motors it simply opens some throttle plates and allows the engine to freely

[02:02] choose its own speed and this is obviously regulated by how much air is going into the

[02:07] engine in real life this looks kind of like this [Music]

[02:17] notice how the engine might take some time to react to that input and there are a lot

[02:20] of complex factors that give every engine sort of a unique character my goal with this

[02:26] project was to replicate all of this complexity in digital form and create a virtual engine

[02:32] that i can interact with in real time so let me explain how this works so the first thing

[02:38] is a rigid body simulator simulates all of the interactions between the internal components

[02:43] like the crankshaft and connecting rods and pistons usually this is called your rotating

[02:48] assembly i wrote this physics engine a few months ago and i made a video about it if

[02:53] you're interested now i want to emphasize that this is not some sort of visualization

[02:59] this is totally legit it is a rigid body simulation and just to prove it i can remove some of

[03:05] the links and all of a sudden we have whatever this is so in other words all of the forces

[03:11] between the links including things like inertia and even the sliding friction between the

[03:16] cylinder walls and the pistons are taken into consideration in this simulation i also implemented

[03:22] a physically realistic fluid simulation to handle the airflow between the cylinders and

[03:27] the other parts of the engine i tried to take as few shortcuts as possible so there aren't

[03:34] really any tricks or shenanigans here the air molecules and the bulk velocity of that

[03:39] air is simulated in a realistic way as it travels through the engine and a physically

[03:44] accurate amount of energy is released when that fuel is burned even the speed of the

[03:49] flame propagation in the cylinder is very accurately simulated this entire simulation

[03:55] by the way has to run at around 80 000 frames per second to remain stable so it had to be

[04:00] heavily optimized and i'll show you what happens if it runs any slower basically your engine

[04:05] just grenades into the fourth dimension immediately

[04:17] the pressure wave that is created in the exhaust system is sent directly to a separate thread

[04:21] that then converts it into an audio signal the final audio signal consists of some plain

[04:27] white noise a little bit of equalization and a filter which approximates the sound propagation

[04:33] pattern within the exhaust system so here's a demonstration starting with the base pressure

[04:38] wave which kind of sounds a little bit uninteresting and once all of the added processing is there

[04:44] you can see that it sounds a little bit more familiar [Music]

[04:57] [Music] foreign

[05:17] [Music]

[05:27] oh

[05:37] the simulation is actually so accurate that it can predict horsepower curves given a set

[05:42] of engine specifications usually to within 10 percent and i'll show you how that works

[05:47] in a minute these engine specifications are defined in a piranha script where you can

[05:53] connect multiple individual components together to form a complete engine piranha is my own

[05:58] custom scripting language that i made and i use it on some of my other projects as well

[06:03] you can learn about it in my other videos on my channel alright so let's see a basic

[06:08] demonstration we can start with a stock engine that you might find in a 1970s truck specifically

[06:14] this is a 454 which stands for 454 cubic inches or 7.4 liters i've actually built one of these

[06:23] myself so i know quite a bit about them all the parameters that i put into the simulation

[06:28] are taken from real world data all right first we'll press a to turn the ignition on and

[06:35] then we'll press s to engage the starter just like in a real engine

[06:42] by pressing various keys on the keyboard i can open or close the throttle which of course

[06:47] causes the engine to change speeds by pressing the d key i can enable the dynamometer so

[06:53] we can measure the torque and horsepower of this engine

[07:06] hmm

[07:16] if we look up the original figures given by gm in 1974 we can see that they are very close

[07:22] to the predicted values in the simulation even the curves are roughly the same shape

[07:27] with both peak torque and peak power happening at roughly the same engine speed now by just

[07:34] changing the parts in the engine you can actually change the way that it sounds so if i put

[07:39] in some high performance parts and a cam shaft with a slightly different lobe profile you

[07:44] can see that the engine both produces more power but also sounds noticeably different

[07:50] i did not change any of the audio synthesis settings this is based only on the internal

[07:58] components of the engine

[08:07] to get a better feeling for the power of the engine i also implemented this vehicle simulation

[08:12] with a clutch transmission and drivetrain simulation it also approximates the rolling

[08:18] resistance of the vehicle as well as air resistance in my opinion the biggest improvement over many of the models that i've seen is the engine

[08:42] braking sound which sounds really good so engine braking or overrunning is when you

[08:47] run the engine faster than it should be given the throttle position which produces a sort

[08:52] of braking effect and you can kind of think of it as like negative horsepower and this

[08:58] also noticeably changes the tone of the engine

[09:27] so far in this video i've only shown v8 engines but that's not the only thing that this simulator

[09:32] can do it's actually completely generic so you could simulate a v6 an inline four you

[09:40] can even simulate uh non-standard engine configurations like a v3 or you could even have six cylinders

[09:48] on one side and four on the other it doesn't really matter it can handle pretty much anything

[09:53] so if you have any ideas for specific engines that you want me to test please write them

[09:57] in the comments and i'll definitely be making a follow-up video to this just to prove that

[10:03] it actually does work i entered the parameters of this kohler v-twin engine and you typically

[10:09] find these things on sawmills or wood chippers and other industrial equipment i'm very familiar

[10:15] with this particular engine in real life and i can confirm that the simulation produces

[10:20] a very accurate replication of the sound and the horsepower figures are pretty much exactly

[10:26] the same as in real life

[10:48] now as much as i would have liked to discuss all of the technical details of this project

[11:12] there would have been just way too much to cover in a single video i literally read entire

[11:17] textbooks while researching this and i've also read a lot of research papers i genuinely

[11:23] have no idea if anyone would even be interested in these details so please let me know if

[11:29] you are also at the time of releasing this video the code is open source on my github

[11:34] so check it out if you're interested the link to that is in the description i hope you guys

[11:39] liked the video and thanks for watching [Music]

[11:51] you
