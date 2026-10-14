<!--
| field | value |
|---|---|
| title | Making a Terrible Racing Game with Great Audio (Engine Simulator) |
| videoId | DP83LxQm1jM |
| url | https://www.youtube.com/watch?v=DP83LxQm1jM |
| published | 2023-02-23 |
| duration | 14:00 (840s) |
| transcript source | YouTube auto-generated English captions |
| method | yt-dlp --write-auto-sub/--write-sub (en), VTT parsed to plain text |
| fetched | 2026-10-07 |
| approx chars | 13275 |
| borderline | false |
-->

# Making a Terrible Racing Game with Great Audio (Engine Simulator)

[00:00] Hey what's up guys? In today's video we're going to build a simple racing game with Engine

[00:04] Simulator and a new game engine that I've created, but first, I'd like to thank BeamNG,

[00:10] Rena, Goldwolf and Maisteer for supporting me at the Master Mechanic level on Patreon.

[00:16] Thanks also to Squarespace for sponsoring this video. More about them later.

[00:21] By the way, yes that is actually the real BeamNG I've gotten quite a lot of comments asking

[00:26] about that. They've been an active supporter since my Patreon first launched and I've spoken

[00:31] to their CEO and some of their developers on a video call and I can honestly say that

[00:36] their entire team is amazing. I can tell that they really care about the community and want

[00:40] to help smaller creators like myself. Anyway, they didn't ask me to say this, I just thought

[00:45] I would clarify since some of you were wondering. If you're new to the channel, a few months

[00:51] ago I released this video about a real-time internal combustion engine simulator that

[00:55] generates audio. That video did a lot better than I was expecting and we got enough funding

[01:01] on Patreon to start developing the prototype Engine Simulator into a complete tool which

[01:06] will have a much more polished 3D graphical interface, better audio generation and overall

[01:11] just be a better product. Starting off with a foundation, we need a game engine. The free

[01:17] version of Engine Simulator uses a game engine called Delta Studio which was a project I

[01:22] started in high school. Those were very different times and I've learned a lot since then so

[01:27] let's just say it's not the best game engine ever made and I want to make sure that this

[01:31] product is something that I would be comfortable selling so I built an entirely new game engine.

[01:37] So this game engine supports Vulkan and it has a lot of other useful features like logging

[01:42] and error checking and other things that my teenage self thought were 100% optional. It's

[01:49] not quite done yet but I'm going to continue working on it in parallel with the Engine

[01:53] Simulator project. I linked all the resources I use in the description in case you want

[01:57] to try Vulkan for yourself. Just a warning though, it will test you, okay, it's a lot

[02:02] of work but if you like that kind of thing it's definitely worth trying. Even though

[02:07] there are some important features that are missing, I thought it would be cool to try

[02:10] making a simple game with this new game engine, something that'll just take two or three days

[02:15] of work. A logical choice would be some sort of driving simulator that uses Engine Simulator

[02:21] to generate audio. Well, that's exactly what we'll build right after a quick message from

[02:26] today's sponsor Squarespace. Having an online presence in this day and age is important

[02:32] for pretty much anyone. Thankfully Squarespace makes it easy to get a domain and start building

[02:37] a website with an easy to use interface. They also offer a variety of modern features for

[02:42] creators like myself who rely on online supporters to make a living. The member areas feature

[02:47] allows creators to make money from the content they create and build a community. Squarespace

[02:53] also integrates easily with other social media and provides detailed analytics to help you

[02:58] grow even more. Check out squarespace.com to start your free trial and when you're ready

[03:03] to launch, go to squarespace.com/AngeTheGreat to save 10% on your first purchase of a domain

[03:09] or website. Thanks again to Squarespace for making this video possible. Alright, let's

[03:15] start with the car physics. We'll use the same physics engine that runs Engine Simulator

[03:20] if you want to learn about the mathematics and theory behind this physics engine, check

[03:24] out the video that I made on that project. We can model a vehicle as a system of constraints.

[03:30] So we have the car frame and four wheels that are rigidly attached to that frame. The first

[03:35] constraint prevents the tires from sliding and here is the code for that constraint.

[03:42] Next we need a rolling constraint that forces the wheels to rotate at a rate that ensures

[03:46] that the velocity at the bottom of the wheel where it contacts the ground is zero and this

[03:51] is what that constraint looks like Now, these constraints together will completely prevent the tire from sliding but we know

[04:01] that in real life tires can and do slide. To account for this, we can specify a force

[04:07] limit to the constraints we defined earlier. Since the engine can only apply a force up

[04:12] to that limit to satisfy the constraint there will be cases where the constraint cannot

[04:16] be entirely satisfied and the wheel will slip. To test this model, I use the demo program

[04:23] for my physics engine video. Now, I know it looks a little bit strange but there is order

[04:27] to the chaos here. To represent the 3D nature of the tires in this 2D application, the tires

[04:33] are shown as this outer disk and the tire direction is this inner disk with the dot

[04:38] pointing forward. As you can see once the maximum friction force is exceeded, the car

[04:44] will begin to slide. Now we can port this model to a new project that uses the game

[04:49] engine that I built earlier. For the wheels I created some low poly models in Blender.

[04:54] I kept the same exporter from my previous game engine and it basically just allows me

[04:59] to export geometry and scene information from Blender. After fixing some reality bending

[05:05] issues with the matrix transformations I was using, I now had the basic car simulation

[05:10] inside the game and the next step was to bring in the engine simulation code. A major issue

[05:16] is the larger a system is, the more processor intensive it is. A V8 has 16 reciprocating

[05:22] components and numerous links and constraints between those components. Linking an entire

[05:28] car simulation onto this will probably be too much for most CPUs to handle, however,

[05:33] there is a way to cheat. We can separate the engine from the car and then couple the two

[05:38] systems with a spring rather than rigidly connecting them together. This is faster because

[05:44] the processing cost scales non-linearly with respect to the number of constraints and bodies.

[05:50] So separating the workload into two separate halves will dramatically reduce the computation

[05:55] time of the composite system. The only issue is a spring connection between the engine

[06:00] and the wheels is less accurate and the result can be jittery, however, I found that I don't

[06:06] mind the jitter that much and I think it sounds interesting. I'll show you what it sounds

[06:09] like in a minute. Once I had implemented a few camera controllers it was actually kind

[06:14] of playable. Obviously the physics is very unsophisticated but it's honestly not that

[06:18] bad to play. There are also no collisions so the track boundary is just visual but adding

[06:24] collision detection is theoretically possible. The only thing left is to make it look a little

[06:29] bit more appealing. Right now I'm just rendering all the objects using their vertex normal

[06:34] as their color. I modeled a completely new course in Blender and also started adding

[06:40] some interesting decorations to the level. I was inspired by the test shaders I was using

[06:45] earlier and I decided to try some sort of cosmic theme for the game and I ended up really

[06:50] liking it. These unintentional discoveries happen pretty often when you do things completely

[06:55] from scratch and it's one of the reasons why I like doing things that way. I put a lot

[07:00] of thought into which game engine I was going to use for this project. It's a real dilemma

[07:04] because tools like Unity and Unreal are so good it's kind of hard to justify not using

[07:09] them. Now, I don't blame anyone for using those engines but I'm just going to be honest,

[07:14] I don't find them that fun to use and there's something about them that interrupts my creative

[07:18] process. I think having restrictions leads to creativity in a lot of cases and game engines

[07:23] today are just so complete and so polished I don't know if genuine restrictions like

[07:28] this even exist anymore. Anyway, my point is, I like using my own tools and it makes

[07:33] the entire process of game development enjoyable for me but everyone is different and I'm not

[07:38] going to claim that using my own game engine makes me better or some sort of gigachad programmer

[07:44] especially today there's there's so much information online and resources, pretty much anyone can

[07:48] do it if they have an interest in that kind of thing which I do. Also if you're not a

[07:54] software developer and you're watching this, welcome to the world of devlogs. It's a small

[07:58] but growing genre here on YouTube and there are a lot of great developers that document

[08:02] their work on their own games. I have left some links in the description to some good

[08:06] ones that I would recommend. Around two years ago when I was still working on this cereal

[08:11] box platformer game an absolute gigachad named Krevs gave me a shout out just as I was reaching

[08:17] 100 subscribers. It was a really big deal for me at the time and I'd like to finally

[08:21] repay him with my own shout out. Please go and give this legend some support he hasn't

[08:26] uploaded in two years but let's see if we can bring him back

[08:30] I actually did go through the effort of writing some decent shaders for this project but I

[08:36] found that they just didn't look that interesting. Something looked very default about them if

[08:40] that makes sense. Anyway designed some fake lighting using dot products and simple vector

[08:45] math. I found that it actually worked better for the aesthetic that I was going for in

[08:49] this project. If I had weeks to work on this I could probably come up with something better

[08:54] but I think this is fine for a few hours of work. The entire shader model is as follows:

[09:00] so first we apply a very basic point source light. This is literally just a single dot

[09:05] product and it mixes a front-facing and rear-facing color. Next we multiply this result by another

[09:11] very simple light with a different color, and this creates kind of an accent color in

[09:15] the scene. It's a bit dark so we can also increase the exposure for the entire scene

[09:21] as well. Now, to fix this over saturation we can apply gamma correction and then a tone

[09:27] mapping function. Now we can start applying some cool Fresnel effects using this approximation

[09:33] which makes some objects brighter at grazing angles. Some objects have even more of this

[09:39] applied to create kind of a halo effect which I think fits with the cosmic theme of the

[09:44] scene. Finally, we can apply a fade effect so these towers look like they disappear into

[09:49] the nothingness of space. Technically there isn't really a physical basis for this but

[09:54] none of the shaders in the scene are really physically based anyway. Now don't get me

[09:58] wrong, I like physically based rendering and I've even written my own physically based

[10:02] ray tracer but I find that it's fun to break the rules sometimes and create interesting

[10:07] effects. Alright that's pretty much it, let's do a test run. I know that sim racing fans

[10:12] are going to cringe at my racing lines but please try to ignore my extremely bad driving.

[10:18] I don't have a steering wheel or a controller so this is the best that I could do with a

[10:21] keyboard and mouse. I put this overlay on the screen so you can see the controls. Most

[10:27] are the same as the engine simulator client where q w e and r keys are throttle, shift

[10:34] is clutch, left click is to shift up, right click to shift down, and middle click is to

[10:39] brake. Moving the mouse side to side is what turns the steering wheel which is why it looks

[10:44] so smooth in the game. In the top left corner you can see the framerate this is from an

[10:50] overlay from RenderDoc. My screen capture software misses frame sometimes (I'm not really

[10:55] sure why) but the overlay proves that I'm getting a pretty decent frame rate and this

[11:00] is totally playable on my hardware. Anyway, let's try it.

[11:06] [Revving engine like a maniac]

[12:37] [ATG Theme Music - Space Variation]

[13:17] All of my supporters on Patreon will get a free copy of this demo. It works with any

[13:22] Engine Simulator engine and I'm planning to have a similar mini-game in the final game so players

[13:27] can test out their engines in a more interesting way instead of just running through gears

[13:32] looking at a speedometer on the screen. Thanks to all my patrons and Squarespace for sponsoring

[13:37] this video and thank you for watching. Alright, have a great day everyone.

[13:50] [Music]
