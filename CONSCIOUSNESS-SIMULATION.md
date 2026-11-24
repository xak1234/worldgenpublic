# The Minds Inside WorldGen

*How WorldGen's characters think, feel, remember and change, and what that means for the person playing.*

---

## In one paragraph

Every person you meet in a WorldGen world is an AI agent with a simulated inner life. They have moods that build up and fade slowly. They have wounds from their past that certain words reopen, and defences they reach for under pressure. Their memories are not recordings: they drift, distort and get retold. Between your conversations they keep living. They brood over what you said, gossip, form friendships and grudges with each other, dream, and decide what to do next. When you come back, you are not talking to a chatbot that resets. You are talking to someone who has been thinking about you.

---

## Why build it this way

Most game characters are scripts: the same line, the same reaction, every time. Characters driven only by a language model are better, but they forget, agree too easily and have no history.

WorldGen sits a layer of simulated psychology **underneath** the language model. The model supplies the voice: the actual words, the gestures, the colour. The simulation supplies everything the model cannot be trusted to keep by itself. That means emotional state, memory, relationships, wounds, motives and continuity over time. The model is told who this person is *right now*, given everything that has happened to them, and asked to speak as them.

This is not consciousness in the philosophical sense. Nothing here is aware or feels anything. It is a working model of the *processes* psychologists describe in real minds: emotional inertia, rumination, memory distortion, attachment, defence mechanisms. They are built so that characters behave as if those processes were happening inside them.

---

## The layers of a simulated mind

### 1. Feelings that linger (the affect system)

Each character carries an emotional state made of 24 numbers. Three are general: how positive, how aroused and how in control they feel. Twenty-one are specific emotions: anger, fear, sadness, joy, disgust, surprise, trust, anticipation, shame, guilt, loneliness, desire, pride, envy, contempt, tenderness, nostalgia, resentment, gratitude, relief and anxiety.

Emotions change gradually. A frightened character does not stop being frightened the moment the danger passes. Negative feelings (resentment, shame, guilt, fear, contempt, anxiety) also fade at half the normal speed, while joy, relief and surprise fade twice as fast. People hold on to hurt longer than happiness, and so do these characters.

### 2. Processing what happened (post-event processing)

When a conversation ends, the character goes on thinking about it. Each person has a processing style:

| Style | What it looks like |
|---|---|
| Present | Lets it go and stays in the moment |
| Brief reflection | Thinks it over once and moves on |
| Moderate rumination | Keeps returning to it for several hours |
| Heavy rumination | Can't let go, and their memory of it gets more distorted each time |
| Suppression | Pushes it away, and it leaks out later |
| Dissociation | Disconnects from it entirely |

Ruminators replay the event across several cycles, with their memory drifting further from what really happened each time. Along the way they produce thoughts in their own voice, plans for what to say next time, and "what I should have said" replays. The language model is told explicitly to be biased and irrational in the way that style would be, not balanced.

### 3. Old wounds and defences

Every character has one to three psychological wounds, each with its own trigger words and situations. When something you say touches a wound, the character's reaction is out of proportion to what you actually did. You may never find out why.

Under enough pressure a **defence mechanism** activates. The set follows Vaillant's scale from immature to mature: denial, projection, rationalization, displacement, reaction formation, regression, intellectualization, sublimation, humour and withdrawal, plus lighter postures such as guardedness and minimising. Pressure is a weighted score of fear, perceived threat, shame, anger, resentment, rumination, identity conflict and how far their memories have drifted from reality. The chosen defence quietly shapes how they talk to you. Withdrawal, for example, comes out as "avoids contact and gives clipped replies".

### 4. How they attach to people

Each character has an attachment style (secure, anxious, avoidant or disorganised), with its own comfort with closeness, fear of abandonment and way of handling conflict. It changes behaviour directly:
- Anxious characters get lonelier and more anxious at night.
- Avoidant characters start pulling away once they begin to trust you. Closeness itself makes them retreat.

### 5. Reading you (theory of mind)

Every character keeps a private theory about you: what you want, what kind of person you are, how much of a threat you are, how interested they are in you, and what they expect you to do. Some of those beliefs can be wrong, and you can't see them. A character who is interested in you, trusts you and isn't avoidant may come and find you, with an opening line they've prepared. You don't always have to make the first move.

### 6. Memory that behaves like memory

- **What actually happened is recorded separately** from what each character *remembers*. Every interaction creates an objective record, and every character who was there forms their own version.
- **Memories drift.** Each rumination cycle records the memory before and after, how distorted it is, and what bias caused the shift. A "reality gap" score tracks how far their version has moved from the truth.
- **What sticks depends on the person.** Emotional intensity, broken trust, shared secrets, first impressions and betrayal by someone trusted all make a memory last. Anxious characters hold on to bad memories longer; cheerful ones keep the good ones.
- **First impressions are unfair, on purpose.** A bad first impression takes about five good interactions to halve. A good one can be wiped out by one bad moment.
- **They notice patterns:** when you usually visit, where, what you keep talking about, whether you're avoiding them, and whether you just stand nearby without speaking.
- **Promises are remembered.** Say "I promise" or "count on me" and it's recorded, and they will hold you to it.

### 7. A society, not a cast

Characters live among each other, not just around you:
- **Relationships form by themselves.** Compatible people (similar class, places, personalities and ages) drift into friendship; clashing ones drift into friction.
- **Gossip spreads, and it isn't always true.** About 85% is accurate and 15% is made up. Gossip that starts from a distorted memory carries the distortion with it, and each listener distorts it again.
- **Moods are contagious.** A strong emotion spreads to people standing nearby at reduced strength.
- **Life goes on offscreen.** Small events happen that you never see, but they shift someone's mood.
- **Witnesses remember.** Talk to someone in a crowded room and the bystanders form their own memories of it, which they may later retell, distorted by their own psychology.
- **Torn loyalties.** A character who cares about two people who dislike each other feels the tension build. Eventually it becomes something they brood over, and they may pick a side.
- **Memories get compared.** When two characters talk about the same event, their versions are compared, and genuine contradictions are flagged.

### 8. Deciding what to do (agency)

Each simulation tick, every character weighs needs, obligations, goals, social pull, habit, impulse, crisis and avoidance, then decides where to go, whom to seek or avoid, and what to talk about. Pairs hold full conversations with each other, and groups of three or more sometimes do, forming alliances or freezing someone out. If the AI service fails, a routine fallback keeps everyone behaving sensibly.

### 9. Dreams

When six or more hours pass, characters with unresolved material may dream (60% chance). Dreams are written to be symbolic, strange and emotional, not literal retellings, and they are built from that character's real memories and worries. A good dream can bring relief or insight and ease a rumination; a bad one leaves them anxious. A character may tell you about a dream, and that dream came from what was really going on inside them.

### 10. Two views of every person

Each character carries two parallel accounts of themselves. One is the **actor's** view: what they believe they're doing and why. The other is the **observer's** view: what someone watching would see. When the two pull apart, identity conflict rises, and that adds to pressure.

---

## What one session looked like

These are from real test sessions run on the demo world *Saturn Storms Hexagon World*:

- A player, newly arrived, promised the storm-watcher Sylas Vane help with the storm shutters. He replied: *"Shutters. That's a strange thing to promise a man you met an hour ago."* The promise was recorded as pending.
- The player provoked the turbine engineer Elara Gust using one of her real wound themes. Her perceived threat jumped to 85 out of 100, the wound activated, and a defence episode was recorded: **guardedness**, pressure 45, "answers carefully and withholds detail". Her next line: *"[The wrench stops mid-tap against her palm. She turns slowly, rain lashing her face, eyes flat and cold.] Say that again, plain…"*
- After three short conversations and three simulation ticks, one character had seven memories, each linked to the objective record. There were 11 recorded memory-drift snapshots, three open rumination threads containing eight "what if" replays, and a growing record of how she saw herself and how she came across.
- During that time the other residents made 18 decisions of their own and held 6 conversations among themselves. Some gossip was spread.
- An eight-hour wait produced five dreams, one for each character with something on their mind.

---

## What this means when you play

- **You can't take words back.** A careless line can turn into a memory that gets worse every time the character thinks about it. A kindness at the right moment can matter more than ten polite chats.
- **Reactions have causes you can't see.** If someone overreacts, you may have touched a wound. If someone cools after getting close, they may be avoidant. The game won't tell you, but it's consistent.
- **The world gossips about you.** What you do in front of people travels, and it changes as it travels.
- **Absence counts.** Visiting often, or avoiding someone, is noticed and remembered.
- **People come to you.** Someone who has been thinking about you may seek you out.
- **Two players, two worlds.** The world's population and setting are shared, but each player's characters' inner lives are their own. Two people in the same world will be remembered differently by the same character.

---

## Continuity: the minds keep their state

A mind that resets isn't a mind, so WorldGen saves everything that makes a character who they are: mood, memories, inner life, rumination, dreams, promises, theory of you, relationships and goals. This was tested by playing one world, switching to another, closing the server and starting it again:
- Every character came back exactly as they were, down to the text of their memories.
- The second world didn't affect the first.
- Returning to a world resumes where you left off, and the characters still know you.

---

## Seeing inside: the Observatory

Open the **Community** view in WorldGen to see what's happening under the surface. The Observatory shows a live feed of events: thoughts, gossip, rumination, defences, dreams, NPC conversations and approaches. Each character has a dossier with 20 tabs:
- psychology, emotions, attachment, self-awareness, wounds and defences
- their relationship with you
- memories with the truth gap, rumination, and the mood trajectory over time
- their two identity streams, belief contagion, conversations, goals and relationships with others
- dreams, body, loyalties and observations

A raw-data tab shows everything. Nothing is a black box: every change is recorded and can be inspected.

---

## What it needs

- **An AI language model key** (DeepSeek, Mistral, Gemini, Cerebras, OpenAI, Anthropic or any OpenAI-compatible service). The simulation decides *what* a character feels and remembers; the language model gives them their words. Without a key, characters can't speak or think.
- **Voices** are optional. WorldGen can use cloud speech or a local voice service, and otherwise falls back to the browser's built-in voices.
- See [README.md](README.md) for setup, or *README - How to Run.txt* in the portable Windows package.

---

## The honest limits

- **It is a simulation.** It models psychological processes; it doesn't create experience. The characters are convincing because the processes are modelled carefully, not because anything inside them is aware.
- **The words come from a language model,** so how good the dialogue is depends on the model you connect.
- **Some systems need time to show.** Loyalty conflicts and contradictory memories need relationships and shared events to build up, so they show over longer play, not in the first few minutes.
- **The numbers are design choices,** such as decay rates, thresholds and the 85% gossip accuracy. They're informed by psychology but tuned for play, not measured from real people.

---

*WorldGen. Built from CONSCIOUSNESS.md, the project's design and implementation reference, and from behaviour checked in live test sessions on 24 November 2026.*
