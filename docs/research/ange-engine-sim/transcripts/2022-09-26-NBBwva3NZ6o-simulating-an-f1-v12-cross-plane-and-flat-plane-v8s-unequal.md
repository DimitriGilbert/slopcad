<!--
| field | value |
|---|---|
| title | Simulating an F1 V12, cross-plane and flat-plane V8s, unequal length headers and more |
| videoId | NBBwva3NZ6o |
| url | https://www.youtube.com/watch?v=NBBwva3NZ6o |
| published | 2022-09-26 |
| duration | 15:55 (955s) |
| transcript source | NoteGPT (notegpt.io), YouTube en_auto captions |
| method | agent-browser Chromium, same-origin fetch notegpt.io/api/v2/video-transcript |
| fetched | 2026-10-07 |
| approx chars | 9215 |
| borderline | false |
-->

# Simulating an F1 V12, cross-plane and flat-plane V8s, unequal length headers and more

[00:00] hey guys welcome back last time I demonstrated some small engines all the way up to five cylinders and today we're picking up where we left off but before we do that I want to talk about some developments since my last video was released I've been seeing a lot of people making YouTube videos with engine simulator showcasing their creations and I just want to say this is honestly something that I never expected to happen and everyone in the community has been really great I've noticed some people getting into arguments in the comments about crediting me and as I've stated it really doesn't matter credit is appreciated but not mandatory but everyone so far has been really good about it so thanks a lot guys all right with that out of the way the first thing I have to do is apologize to Subaru owners I realized my last video must have been very traumatic since I neglected to account for unequal length headers which give some Subarus their

[00:54] distinctive sound well the simulation now supports unequal length headers so let's try this again first just for the sake of comparison I'm going to demonstrate a Subaru with equal length headers

[01:20] foreign

[01:29] now let's try unequal length headers which causes the exhaust Pulses from One bank to arrive later than the other and this creates a sort of Rumble sound in the exhaust let's see what that sounds like

[01:54] foreign

[02:13] I know it's not perfect but I think you can definitely hear the rumble now but let me know what you think in the comments some people have also commented on the volumetric efficiency being too high for a lot of engines and this is true you can specify values in the simulator that will lead to unrealistically high flow rates in the engine which is part of the problem also it might seem counter-intuitive but you can actually have higher than 100 volumetric efficiency in real life with a naturally aspirated engine but that's sort of besides the point anyway it's very hard to tune all of these parameters perfectly and I don't have the equipment to measure them directly so some of the numbers that you see are not going to be correct I've calibrated everything a bit better for this video but it's still not perfect all right now that we got that out of the way let's start looking at some more engines we're going to start with

[03:05] perhaps the most famous inline 6 engine and a lot of people suggested this the 2JZ this engine was first produced by Toyota in 1991 and since then has practically achieved legendary status there's a big modding scene around two Jay-Z's so I was able to find quite a bit of information about them in terms of layout they're a pretty standard inline six with a firing order of one five three six two four all right let's see what that sounds like [Music]

[03:42] foreign

[03:49] [Music] next we're going to be doing a study of v6s but before we talk about that I want to talk a little bit about even firing versus uneven firing engines an even firing engine has the cylinder firing events spaced evenly in the cycle so our 2JZ for example is even firing and you can see that the exhaust pulses are evenly spaced a 90 degree V Twin on the other hand is not an even firing engine let's say that cylinder 1 Fires at zero degrees cylinder 2 will then fire 450 degrees later instead of 360. and then to complete the cycle cylinder 1 will fire 270 degrees later this uneven firing changes the sound of the engine slightly v6s are interesting because there are a few V angles that have been used by manufacturers first let's take a look at a 60 degree V6 and see what that sounds like foreign

[05:25] even though a 60 degree V angle is optimal for balance some manufacturers have made 90 degree v6s you might be asking yourself why this would ever make sense well it's mainly for practical reasons and mostly from American manufacturers Americans like their V8s and while some people joke that v6s are just V8s with two missing cylinders in some cases this is quite literally what they were instead of designing an entirely new block American manufacturers just took their existing small block V8 platforms which of course have 90 degree V angles and remove two cylinders to make a V6 block in some earlier v6s even the shared crank pins were retained from the V8 design which meant that they did not even fire evenly so let's listen to one of these odd fire V6 engines as they're called

[06:45] these engines have a very distinctive sound because of their uneven firing and are a bit unbalanced some manufacturers corrected this by splitting the rod journals allowing the engine to fire evenly let's see what that sounds like

[07:23] next we're going to look at V8 engines now a lot of you wanted to see a demo comparing a flat plane to a cross-plane V8 and the names for these two layouts come from the shapes of the crankshafts in a flat plane V8 all Rod journals are on the same plane so the crank appears flat whereas in a cross-plane V8 the rod journals are separated from each other by 90 degrees let's listen to an extremely popular cross-plane American V8 engine the GM LS motor or at least my version of an LS motor two things to notice are the rumble sound caused by unequal length headers and the odd firing order which does not alternate evenly between the left and right Bank notice how at some points two cylinders in the same bank fire sequentially this does not happen in flat plane V8s as we'll see

[08:25] oh

[08:35] foreign

[08:54] V8s are more common from European manufacturers like Ferrari although more recently some American manufacturers have been using them as well I decided to demo a European flat plane V8 since many American flat plane V8s use exhaust system trickery to make them sound more like cross-plane V8s to appeal to American buyers who are more familiar with that sound European flat plane V8s typically have equal length headers and that makes them sound exotic in North America [Music] whoa

[09:39] [Music] all right [Music] next let's take a look at a nine cylinder radial engine it's fairly similar to the five-cylinder radio that I showed in my last video but of course it has four extra cylinders this large donut shaped device here is actually a single connecting rod which is special and different from the other ones and all the other rods actually connect to this one instead of the crankshaft and the reason for that is because there's there just isn't really a good way of connecting them all to a single crank pin and this solves that problem [Music] foreign

[10:51] [Music]

[11:09] this next one was requested by quite a few people it is a famous 10-cylinder Toyota engine that you can find in the Lexus LFA this is an even firing V10 which revs very quickly and one thing that I'm working on is getting that rasp that you often hear from high performance engines like this it's something that I'm working on for the final release of engine simulator anyway see what you think

[11:40] wow

[11:52] [Music] [Music] foreign ly let's look at some v12s 12 cylinders are pretty close to the limit of what the simulator can currently handle on my Hardware so I've had to lower the simulation resolution a little bit you guys probably remember if you reduce the frequency too much what happens from my first video about engine simulator anyway let's try a famous V12 the Rolls-Royce Merlin which was used in British World War II fighter planes like the Spitfire these engines were usually supercharged but since the simulation doesn't yet support forced induction we'll have to keep it naturally aspirated

[12:49] [Music]

[13:17] all right the final thing we're going to look at is a Formula One V12 in particular this is the typo zero four four slash one I have no idea how this is meant to be said but that's how I say it uh from the early 90s it has a slightly odd 75 degree V angle which is different from the 60 degree V of the Rolls-Royce engine that we looked at earlier this engine definitely pushes the limits of what the program can do because it's very mechanically complex and it spins very quickly and what tends to happen is the faster an engine spins the more distance each of the individual components covers per frame and it just makes the physics simulation harder to solve and more inaccurate actually as it spins faster but it seems to handle it reasonably well just with a few artifacts here and there so let me know what you guys think foreign

[14:50] foreign

[15:02] all right guys obviously there's still a lot of work to do and this is still very much a prototype I've already started working on the real engine simulator and I really appreciate all the support I've been getting on patreon if you want to get a copy of the game and support the project the link to my patreon can be found in the description in the next few weeks I plan to publish one more video where I talk about all of the technical details of the project since a lot of the software developers in my audience requested it after that I'll be focusing on developing engine simulator and putting out Dev logs when I have a chance hope you guys enjoyed the video and thanks for watching [Music]

[15:52] foreign
