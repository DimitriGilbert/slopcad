<!--
| field | value |
|---|---|
| title | Physics Engine Improvements // C++ Game Devlog #3 |
| videoId | 7GSUEqUoR5s |
| url | https://www.youtube.com/watch?v=7GSUEqUoR5s |
| published | 2020-07-05 |
| duration | 6:06 (366s) |
| transcript source | NoteGPT (notegpt.io), YouTube en_auto captions |
| method | agent-browser Chromium, same-origin fetch notegpt.io/api/v2/video-transcript |
| fetched | 2026-10-07 |
| approx chars | 4601 |
| borderline | true |
-->

# Physics Engine Improvements // C++ Game Devlog #3

[00:00] Hey, what's up guys? Welcome to devlog number three of my game Serial Adventure. In case you haven't watched my other devlogs, it's a game I'm writing entirely from scratch in C++. It's pretty cool, so make sure to check it out in my other videos if you haven't already. This week I decided to dedicate some time to refactoring and addressing some persistent nagging issues, in particular with the physics engine. It's not always fun, but what's a lot less fun is having a code base devolve into a spaghetti mess. In a lot of cases, especially with my earlier projects, that was exactly what happened and they ended up abandoned. So anyway, let's let's get right into it. You see this list here? Yeah, that's not even close to being the full list that I actually did this week, but I didn't want to bore you too much. There's a lot of refactoring, adjusting variable names, and generally just cleaning up the code. But yeah, we got to do all of this, so

[00:58] let's get started. Okay, first we got to get rid of this lit parameter because it should be part of the material and not passed into every call. Done. Next, these polygons are facing away from the camera, so there's no need really to render them. Let's get rid of that. Mouse handling is utter trash. Let's fix that. Perfect. Now I can limit the mouse to the game window and hide it if I want to.

[01:43] The OpenGL renderer seemed suspiciously slow compared to the DirectX renderer, and I found out that it had to do with this call right here. So, yeah, let's get rid of that.

[02:07] Dead code deleted. You know, sometimes I just want to go to a website, download an RGB color in a hex form, copy and paste, put it in my code, and I just want to see it right away. I don't want to sit there separating it. I don't want to convert it into anything. So, let's add that. Done.

[02:35] This folder does not need to exist.

[02:48] All right. So, by that point, all of the chores were taken care of. And, you know, I was feeling like, yeah, I could do anything. And, the next thing that I I've had in my sights for a long time is fixing the physics engine. I mean, like, how hard could it be, I think? Now, let me tell you something about uh physics engines. That I mean, you probably already know this. They're not simple, all right? Even the simple ones are not simple. Handling edge cases is a huge part of what the physics engine code does underneath. As you can imagine, that is an absolute nightmare to test. Imagine, you know, you're just You're having a good time. You're testing your game, and then you run into the most random glitch. It requires a very unusual set of circumstances. You know, maybe the perfect alignment of two uh you know, rigid bodies. Uh maybe the system clock has to be divisible by 47 or something. I don't know. It It could be anything. And, let's say you

[03:45] want to reproduce the problem so you can debug it. Well, guess what? You can't. And, even if you try, it's a real pain. It takes a you know, a huge amount of time just sit there fiddling around getting the right conditions. Uh, anyway, so how then do you test a physics engine? How do you make it robust? To make my life easier, I set up a bunch of physics engine integration tests where I can run the exact same event over and over again. The physics engine also has a special mode where it logs the state of every object at every time stamp and then it saves it to a file and then I can replay that in this uh UI just so I can get a visual indication of what is going wrong. Now, despite this extremely useful tool, after a few hours of uh improving my code, I ended up with this.

[04:41] Yeah. Anyway, unlike my high school self, I did not give up and I eventually got it to at least a passable state. Uh, definitely much better than it was last week. I was actually not planning to make a video this week because, let's be real, the game looks essentially identical to the previous video. But I mean, sometimes that's just the way development is. There's not much you can do about that. But anyway, I did add one feature to the game and it's the ability for this stove hood element to actually propel you upwards. Uh, so yeah, I mean, there's uh there's that. Yeah.

[05:30] All right. Don't worry, there will for sure be some uh real changes to the game coming soon. Thank you all so much for watching and if you're interested in what I do, please subscribe for more content. It really helps out the channel. As always, let me know your thoughts in the comments and I'll see you guys in the next devlog. Have an amazing week.
