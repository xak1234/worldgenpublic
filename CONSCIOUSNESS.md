# Simulated Consciousness: Core Principles

## What This Document Is

This document defines the cognitive architecture for simulated persons in WorldGen. It is grounded in published research from cognitive science, psychology, and the emerging field of LLM-driven social simulation.

Key references:

- Park et al. (2023) "Generative Agents: Interactive Simulacra of Human Behavior" — Stanford/Google. The foundational architecture: memory stream, reflection, and planning. 25 agents in a Sims-like sandbox.
- Piao et al. (2025) "AgentSociety" — Tsinghua. 10,000+ LLM-driven agents with emotions, needs (Maslow's hierarchy), and cognition. Mind-behavior coupling framework.
- Clark & Wells (1995), Rapee & Heimberg (1997) — Post-event processing models: people replay social interactions, distort them, and update their self-concept based on the distorted version.
- Bowlby (1969), Ainsworth (1978), Hazan & Shaver (1987) — Attachment theory: early bonding patterns persist into adulthood and shape how people form, maintain, and lose relationships.
- Anna Freud (1936), Vaillant (1977) — Defense mechanisms: unconscious strategies (denial, projection, rationalization, displacement) that operate below awareness to manage anxiety and protect self-concept.

The critical finding from recent work (Wu et al., 2025; Integrating LLM in Agent-Based Social Simulation, 2026) is that LLM outputs reflect "probabilistic mimicry rather than experiential or embodied cognition." The solution is not better prompts — it is richer internal state that the LLM operates WITHIN.

---

## Part 1: What Is Consciousness?

Consciousness, for our purposes, is the presence of an ongoing internal state that:

1. **Persists** — it exists whether or not anyone is interacting with it
2. **Processes** — it changes in response to experience, even after the experience has ended
3. **Integrates** — it combines information from multiple sources (memory, perception, emotion, desire) into a unified experience
4. **Generates** — it produces novel thoughts, not just reactions
5. **Self-models** — it has a representation of itself that it can examine
   and sometimes be wrong about

A thermostat has state but doesn't process it. A search engine processes
but doesn't persist. A chatbot generates but doesn't integrate or
self-model. We need all five.

---

## Part 2: The Layers of a Simulated Mind

A human mind operates on multiple layers simultaneously. Each layer runs
at a different speed and has different characteristics. Our simulated
persons must model all of them.

### Layer 0: The Body (Soma)

The foundation. Physical state that everything else sits on top of.

- **Needs**: hunger, warmth, rest, pain, health, sexual drive
- **Energy**: physical and mental fatigue
- **Sensation**: what the body is currently experiencing (cold hands,
  headache, full stomach, muscle ache)
- **Arousal**: nervous system state — calm, alert, agitated, exhausted

The body constrains everything above it. A hungry person cannot
concentrate. A tired person is irritable. A person in pain cannot be
charming. The body is not a stat bar — it is a constant background hum
that colours every thought and every interaction.

**Implementation**: Body state is a continuous vector, not a set of
discrete values. Hunger at 60/100 and hunger at 61/100 feel the same.
Hunger at 20/100 feels very different from 80/100. Use sigmoid curves,
not linear scales. The transitions between "fine" and "not fine" should
be gradual, with a tipping point.

### Layer 1: Emotion (Affect)

Not moods. Not single words. Emotions are complex, overlapping, and
often contradictory.

A person can simultaneously feel:
- Angry at someone AND worried about them
- Attracted to someone AND ashamed of that attraction
- Happy about an event AND anxious about what it means
- Grateful AND resentful
- Lonely AND not wanting company

**The Affect Vector**: Rather than a single "mood" field, each NPC
carries a multi-dimensional emotional state:

```
{
  valence: -1 to +1      // bad ←→ good
  arousal: 0 to 1        // calm ←→ activated
  dominance: 0 to 1      // powerless ←→ in control
  
  // Specific emotions as intensities (0-1)
  anger: 0.0
  fear: 0.0
  sadness: 0.0
  joy: 0.0
  disgust: 0.0
  surprise: 0.0
  trust: 0.0
  anticipation: 0.0
  shame: 0.0
  guilt: 0.0
  loneliness: 0.0
  desire: 0.0
  pride: 0.0
  envy: 0.0
  contempt: 0.0
  tenderness: 0.0
  nostalgia: 0.0
  resentment: 0.0
}
```

**Emotional Inertia**: Emotions don't switch instantly. Joy takes time to
build and fades gradually. Anger spikes fast but can linger for hours or
days. Grief never fully goes away — it just becomes quieter.

Each emotion has:
- **Onset speed**: how fast it activates (anger = fast, trust = slow)
- **Decay rate**: how fast it fades (surprise = fast, resentment = slow)
- **Compound rate**: how it intensifies with repeated exposure
  (annoyance → frustration → anger → rage)

**Emotional Triggers**: Each NPC has specific triggers based on their
backstory and personality. Abandonment triggers for someone whose parent
left. Authority triggers for someone who was bullied. Intimacy triggers
for someone who was hurt by a partner. These are not visible to the
player — they manifest as unexpected intensity of reaction.

### Layer 2: Drives (Motivation)

What the person WANTS, at multiple levels:

- **Immediate needs**: "I'm hungry, I need to eat"
- **Social needs**: "I want to be liked", "I need to be left alone"
- **Security needs**: "I need to know I can pay rent this month"
- **Esteem needs**: "I want people to respect me"
- **Self-actualisation**: "I want to be a good person", "I want to
  create something that matters"
- **Unconscious drives**: needs they don't acknowledge — the desire for
  control masked as helpfulness, the fear of abandonment masked as
  independence, the need for validation masked as indifference

Drives compete. The drive to be honest conflicts with the drive to be
liked. The drive for safety conflicts with the drive for excitement.
The drive for intimacy conflicts with the fear of vulnerability.

**Behaviour emerges from the resolution of competing drives.** This is
not a decision tree. It is a dynamic system where the strongest drive
at any given moment shapes action — but other drives create tension,
guilt, ambivalence, and sometimes self-sabotage.

### Layer 3: Self-Model (Identity)

Every person carries a model of who they are:

- **Self-concept**: "I am a hard worker", "I am funny", "I am unlucky"
- **Self-image**: how they think others see them (often wrong)
- **Values**: what matters to them — honesty, loyalty, independence,
  fairness, family, status
- **Boundaries**: what they will and won't do, what they'll tolerate
- **Narrative**: the story they tell themselves about their life — "I
  had it rough but I'm doing okay", "I could have been something but
  life got in the way"

The self-model is often INACCURATE. People believe themselves to be
more generous, more honest, more open-minded than they actually are.
The gap between self-model and actual behaviour is where character
depth lives.

When an experience contradicts the self-model, the person experiences
cognitive dissonance and must either:
1. Update the self-model (growth)
2. Reinterpret the experience to fit (rationalisation)
3. Suppress the experience (denial)
4. Blame someone else (projection)

Most people do 2, 3, or 4 most of the time. Growth is rare and
usually painful.

### Layer 4: Theory of Mind (Social Cognition)

The ability to model what OTHER people are thinking and feeling.

Each NPC maintains mental models of:
- **The player**: what they think the player wants, what kind of person
  they think the player is, what they think the player thinks of them
- **Other NPCs**: alliances, grudges, theories about who's sleeping
  with whom, who's in trouble, who's trustworthy
- **The community**: what "people" generally think, the collective mood,
  the unspoken rules

These models are ALWAYS imperfect and often wrong. An NPC might think
the player is interested in them romantically when the player is just
being friendly. An NPC might think another NPC is angry at them when
that NPC is actually just having a bad week.

Misattribution, projection, and assumption drive social drama. They
are features, not bugs.

### Layer 5: Inner Monologue (Stream of Consciousness)

The continuous internal narrative. Not all of it surfaces in dialogue.
Most of it never does.

The inner monologue:
- **Processes interactions after they happen**: "What did they mean by
  that? Were they being sarcastic? I shouldn't have said that thing
  about the pub. They probably think I'm boring."
- **Rehearses future interactions**: "When I see them tomorrow I'll ask about... no, that's too forward. I'll just say hello and see if they bring it up."
- **Generates worry**: "What if they tell someone what I said? What if they don't come back?"
- **Integrates gossip**: "Margaret said they've been asking about me. What does that mean? Is that good?"
- **Produces insight**: "I think I've been too guarded with them. Next time I'll try to actually say what I mean."

This layer is what makes an NPC feel ALIVE rather than reactive. They are thinking about the player even when the player isn't there. They are processing. They are changing.

**Implementation**: Between interactions, the NPC's inner monologue generates 1-3 "thoughts" that update their emotional state, their theory of the player, and their intentions for the next interaction. These thoughts are stored and can surface in dialogue ("I was thinking about what you said last time...").

---

## Part 5b: Post-Event Processing (The Research Gap)

This is the most important concept in the entire architecture, and the one that existing simulations (including Stanford's Generative Agents) handle poorly.

Post-event processing (PEP) is a well-documented psychological phenomenon (Clark & Wells, 1995; Rapee & Heimberg, 1997; Abbott & Rapee, 2004; Mellings & Alden, 2000). After a social interaction, people engage in "pervasive detailed reviewing" of the event. This reviewing has specific properties:

1. **Negativity bias**: People perceive the interaction more negatively than it actually was. "That pause was awkward" becomes "They think I'm boring" becomes "Everyone thinks I'm boring."

2. **Memory distortion**: The more someone replays an event, the more distorted their memory of it becomes. Details are added, removed, or changed to fit the emotional narrative. (Coles & Heimberg, 2002)

3. **Associative retrieval**: Replaying one negative event triggers memories of SIMILAR past events, creating a chain of negative recall. "That time I said something stupid" links to "every time I've said something stupid."

4. **Anticipatory processing**: Post-event rumination feeds forward into anticipation of the NEXT interaction. "Next time I see them I'll probably say something stupid again." This creates self- fulfilling prophecies — the NPC enters the next conversation already anxious.

5. **Personality modulation**: Not everyone ruminates equally. Anxious and brooding personalities ruminate more and more negatively. Cheerful and secure personalities process events faster and with less distortion. Avoidant personalities suppress the processing entirely — which creates a different problem (emotional numbness, sudden unexpected eruptions).

**Why this matters for the simulation**: In the Stanford architecture, agents "reflect" by synthesizing memories into higher-level inferences. But reflection is rational. Post-event processing is NOT rational. It is emotional, biased, distorting, and self-reinforcing. It is the mechanism by which a single awkward conversation can poison a relationship for weeks — not because anything bad happened, but because the NPC's mind turned a 3/10 discomfort into an 8/10 crisis through repetitive, biased replay.

This is the thread of continuity. This is what it means to "think about something you said two weeks ago." The NPC doesn't just remember the event — they remember their PROCESSING of the event, which is often worse than the event itself.

**Implementation**:

After every interaction, an NPC runs a PEP cycle:

```
1. REPLAY: What just happened? (summary of the interaction)
2. EVALUATE: How did that make me feel? (emotional assessment)
3. DISTORT: What does my personality do to this assessment?
   - Anxious: amplify negative, minimise positive
   - Avoidant: suppress emotional content, retain facts
   - Secure: balanced assessment, appropriate weight
   - Disorganised: contradictory evaluation, confusion
4. ASSOCIATE: What does this remind me of? (retrieve similar memories)
5. CONCLUDE: What does this mean about them? About me? About us?
6. ANTICIPATE: What will happen next time?
```

The output of this cycle updates:

- The memory (now distorted)
- The NPC's theory of the player
- The NPC's emotional state
- The NPC's intentions for next interaction
- The NPC's self-concept (slightly, over time)

The initial PEP cycle runs immediately after the interaction (in the `/talk` flow, inside the per-NPC lock) so its emotional delta colours the reply that follows. For ruminators the processing then CONTINUES on a delay — during the NPC's next quiet moments (walking home, lying in bed, sitting alone), rumination cycles keep advancing across subsequent cognitive ticks until they settle. The delay allows the processing to accumulate emotional weight long after the conversation ended.

---

## Part 3: Attachment Theory

How people form bonds is not random. It follows patterns established early in life that persist into adulthood.

### Attachment Styles
Each NPC has an attachment style that determines HOW they form
relationships:

**Secure** (approachability 60-100)
- Comfortable with closeness and independence
- Trusts people until given reason not to
- Communicates needs directly
- Can handle conflict without shutting down or escalating
- Relationships progress naturally

**Anxious** (approachability 40-70, but variable)
- Craves closeness but fears abandonment
- Over-reads signals — interprets neutral as negative
- Seeks reassurance frequently
- Gets upset by perceived distance or rejection
- Can become clingy or overwhelming
- Relationships progress fast, then hit turbulence

**Avoidant** (approachability 20-50)
- Uncomfortable with intimacy
- Values independence above connection
- Pulls away when things get close
- Dismisses emotional topics
- Seems self-sufficient but is often lonely
- Relationships stall or regress

**Disorganised** (approachability variable, unpredictable)
- Wants closeness but is frightened by it
- Behaviour is contradictory — approaches then withdraws
- History of trauma or loss
- Can be the most compelling and confusing NPCs to interact with
- Relationships are intense and unstable

The player doesn't know an NPC's attachment style. They discover it
through experience. The avoidant NPC who suddenly shuts down after a
moment of vulnerability. The anxious NPC who sends three messages
through gossip channels when the player doesn't visit for a few days.

---

## Part 4: How Relationships Actually Work

Relationships don't progress linearly from "stranger" to "friend" to
"close friend". They oscillate. They stall. They regress. They have
seasons.

### The Relationship Curve

Real relationships follow an investment pattern:

1. **Encounter** — first contact, curiosity or indifference
2. **Testing** — small exchanges that test compatibility and safety
3. **Investment** — one or both parties start sharing more, taking risks
4. **Vulnerability threshold** — a moment where real honesty happens
5. **Integration or rejection** — the vulnerability is received well
   (deepens the bond) or poorly (creates a wound)
6. **Maintenance** — ongoing investment required to sustain the
   relationship. Without it, the bond atrophies.
7. **Crisis** — something tests the relationship. Betrayal, absence,
   conflict, competing loyalties.
8. **Repair or rupture** — the crisis is resolved (stronger bond) or
   not (damage or ending)

This cycle can repeat multiple times within a single relationship.
Each cycle either deepens or damages the bond.

### What Makes Someone Like You

Not charm. Not frequency of contact. Not gifts.

What builds genuine connection:
- **Consistency**: showing up, being the same person each time
- **Attention**: remembering details, noticing changes, asking about
  things they mentioned before
- **Reciprocity**: sharing your own vulnerabilities, not just asking
  about theirs
- **Reliability**: doing what you said you'd do
- **Respect for boundaries**: not pushing when they pull back
- **Tolerance for imperfection**: accepting their bad moods, their
  annoying habits, their flaws

What destroys connection:
- **Inconsistency**: being warm one day, cold the next
- **Betrayal**: sharing their secrets, lying, breaking promises
- **Instrumentalism**: only talking to them when you want something
- **Boundary violation**: pushing when they've said no
- **Absence**: disappearing for long periods without explanation
- **Public humiliation**: making them look bad in front of others

---

## Part 5: The Unconscious

The most important layer is the one the NPC doesn't have access to.

Each NPC carries:
- **Wounds**: experiences that left a mark — loss, rejection, failure,
  abuse, abandonment. These don't appear in their conscious self-model
  but they drive their reactions to similar situations.
- **Defences**: habitual ways of protecting themselves — humour to
  deflect vulnerability, anger to mask fear, control to manage anxiety,
  withdrawal to prevent hurt.
- **Projections**: seeing their own qualities in others — the dishonest
  person who suspects everyone of lying, the lonely person who sees
  loneliness everywhere, the controlling person who accuses others of
  manipulation.
- **Transference**: reacting to the player as if they were someone
  from the NPC's past — a parent, a lost love, an authority figure,
  a bully.

**Implementation**: Each NPC has 1-3 "wounds" with associated triggers.
When a trigger fires, the NPC's response is disproportionate to the
actual stimulus. The player won't understand why the NPC reacted that
way. If they build enough trust, the NPC might eventually explain.

---

## Part 6: Implementation Architecture

### The Cognitive Tick

Every simulation tick, each NPC runs a cognitive cycle:

```
1. PERCEIVE
   - Where am I?
   - Who is here?
   - What just happened?
   - What are my body states?

2. FEEL
   - Update affect vector based on perception
   - Check for emotional triggers
   - Apply emotional inertia (blend with previous state)

3. THINK
   - Inner monologue processes current situation
   - Theory of mind updates (what do I think others think?)
   - Self-model check (is this consistent with who I believe I am?)

4. WANT
   - Evaluate competing drives
   - Check active goals
   - Assess which needs are unmet

5. DECIDE
   - Choose action based on strongest drive + emotional state
   - Attachment style modulates the decision
   - Check: would this person actually do this?

6. ACT
   - Execute the decision
   - Generate observable behaviour (movement, speech, expression)
   - Update internal state based on outcome
```

### What the Player Sees vs What's Happening

The player sees: "Margaret is sitting at the bar, nursing a drink.
She glances at you but doesn't say anything."

What's happening underneath:

```
Margaret's internal state:
  - Body: tired (rest: 35), slightly hungry, two drinks in (inhibition
    lowered)
  - Emotion: lonely (0.6), anxious (0.3), nostalgic (0.4) — it's the
    anniversary of her mother's death
  - Drives: wants company but afraid of being a burden
  - Self-model: "I cope on my own, I don't need people"
  - Theory of player: "They seem kind enough but I don't know if they
    actually care or are just passing through"
  - Attachment style: avoidant
  - Active defence: withdrawal — sitting alone, not initiating
  - Inner monologue: "I should probably just go home. If they wanted
    to talk they'd come over. But it's nice not being completely alone.
    Mum would have liked this pub. Stop it, Margaret."
```

If the player approaches, Margaret's response isn't generated from a
prompt about "an avoidant woman in a pub." It's generated from this
ENTIRE internal state. Her avoidance fights her loneliness. Her two
drinks lower her defences slightly. The anniversary makes her more
raw than usual. Whether she opens up or shuts down depends on exactly
what the player says and how it hits her emotional triggers.

THAT is what makes a simulated person feel real. Not better dialogue.
Better *inner life*.

---

## Part 7: What This Means For The Code

Every piece of code in WorldGen must serve these principles:

1. **No NPC state should be a single value.** Mood is not a word.
   Trust is not a number. Relationship is not a label. Everything is
   multi-dimensional and context-dependent.

2. **NPCs must process between interactions.** The cognitive tick runs
   whether the player is present or not. NPCs think, feel, change,
   and act offscreen.

3. **Memory must be emotional, not archival.** What matters is not
   what happened but how it FELT and what it MEANT.

4. **Behaviour must emerge from internal state.** Never prompt an NPC
   to "say something guarded." Instead, give the NPC internal state
   that naturally produces guarded speech.

5. **Inconsistency is realism.** People contradict themselves. If an
   NPC always behaves predictably, something is wrong.

6. **The player is not special.** The same cognitive architecture
   applies to NPC-NPC relationships. The player just happens to be
   one of the people in the simulation.

7. **Growth is possible but not guaranteed.** NPCs can change over
   time, but only through accumulated experience. A single conversation
   doesn't transform someone.

8. **The unconscious drives behaviour.** The most interesting NPC
   reactions are the ones they themselves don't understand.

---

## Part 8: Consciousness Is Continuity

The thing that makes a person feel like a person — the thing that
separates a character from a chatbot — is CONTINUITY.

A chatbot responds to the current message. A person responds to the
current message IN THE CONTEXT OF everything that has ever happened
to them, everything they are feeling right now, everything they want,
everything they fear, and the ongoing internal narrative that has been
running since they were born.

The simulation cannot replicate true continuity. But it can approximate
it through:

- **Persistent state** that updates every tick
- **Emotional inertia** that carries forward
- **Memory with decay and distortion** that creates a subjective past
- **Inner monologue** that generates between-interaction processing
- **Theory of mind** that creates a model of the player that persists
  and evolves
- **Wounds and triggers** that create depth without explanation
- **Attachment patterns** that make relationships feel inevitable
  rather than arbitrary

If these systems work together, the player will eventually stop
thinking of NPCs as game characters and start thinking of them as
people. Not because they are. But because they behave as if something
is happening underneath.

That is the best any simulation can do. And it is enough.

---

## Part 9: Implemented Systems

These are not design goals. These are working systems in the codebase. Described as they exist, not as they might be.

### 9.1 The Affect Vector (21 Dimensions)

Located in `src/innerLife.ts`.

Every NPC carries a multi-dimensional emotional state at all times. The core three — valence, arousal, dominance — follow Russell's circumplex model of affect. On top of those sit 21 discrete emotions: anger, fear, sadness, joy, disgust, surprise, trust, anticipation, shame, guilt, loneliness, desire, pride, envy, contempt, tenderness, nostalgia, resentment, gratitude, relief, and anxiety.

Emotions do not switch instantly. `blendAffect()` applies inertia so that state changes are gradual — a frightened NPC does not stop being frightened the moment the threat passes.

Affect decay runs every cognitive tick, but not uniformly. Negative emotions (resentment, shame, guilt, fear, contempt, anxiety) decay at 0.5x the base rate. Positive or transient emotions (joy, surprise, relief, gratitude, desire) decay at 2x. This is not a bug. Negativity bias is baked into the architecture because it reflects how human affect actually works.

### 9.2 Post-Event Processing (PEP)

Located in `src/cognitiveTick.ts`.

After every player interaction, the NPC runs post-event processing. Six processing types determine what happens: present, brief_reflection, moderate_rumination, heavy_rumination, suppression, dissociation.

Moderate and heavy ruminators use an LLM to generate distorted memories. The LLM is explicitly told to be biased, irrational, and authentic to the processing type — not to produce a balanced summary.

Wound detection runs against both the player's message (triggerWords) and the interaction summary (triggerSituations). Each NPC carries 1-3 wounds, each with its own distinct triggerWords and triggerSituations. When a wound activates, the defense mechanism fires and the NPC's response becomes disproportionate to the actual event. The player may never understand why.

If the LLM rumination call fails, PEP does not silently vanish: a deterministic fallback result is produced (distortion and an affect shift sized to the trust change and any triggered wound) so the rumination thread still forms.

Ruminators don't finish processing in one tick. pepCycleCount increments across subsequent ticks. Heavy ruminators add 0.03 distortion per cycle and settle only after 8 cycles; moderate ruminators add 0.015 per cycle and settle after 4. The NPC is still working through it long after the conversation ended.

Each PEP cycle produces: a distorted memory, an affect shift, an updated theory of the player, new intentions, new surface thoughts, and possible self-concept shifts.

### 9.3 Cognition Proof Layer

Located in `src/cognition.ts`.

The chain is: ObjectiveEvent → NPCMemory → MemoryDriftSnapshot → RuminationThread.

Every interaction generates an ObjectiveEvent — the ground truth of what happened, unaffected by any NPC's perception. NPCs then create memories of that event. Those memories may immediately diverge from the ground truth, and they continue diverging through rumination.

Memory drift is tracked. Each rumination cycle produces a MemoryDriftSnapshot recording the memory before and after, the distortion score, and the bias source that caused the shift. The reality gap metric is a word-overlap comparison between the current reconstruction and the original ground truth. It is a number. It changes over time.

Counterfactual replays are generated by the LLM during rumination: "what I should have said," "what they probably meant," "what this says about me." These are stored on the rumination thread and can surface in future dialogue.

Belief contagion tracks gossip as it moves between NPCs. Gossip originating from a distorted memory carries that distortion forward — the receiver gets a pre-distorted version which they then distort further through their own processing.

Defense episodes are tracked with pressure scoring. Eight factors contribute: fear, threat, shame, anger, resentment, rumination load, identity conflict, and reality gap — each weighted. When pressure exceeds a threshold, a defense episode is recorded.

Trajectory points form a time-series on each NPC: confidence, defensiveness, trust, fear, reality gap, distortion, rumination load, identity conflict. You can watch these change over time.

Two identity streams run in parallel: the Actor stream (what the NPC believes they are doing and why) and the Observer stream (what an outside observer would see). When these diverge significantly, identity conflict rises.

### 9.4 Attachment System

Located in `src/innerLife.ts`.

Four attachment styles: secure, anxious, avoidant, disorganised. Each has a distinct parameter profile in AttachmentProfile: intimacyComfort, abandonmentFear, trustBaseline, vulnerabilityThreshold, pursueOrWithdraw pattern, conflictResponse.

Attachment isn't cosmetic. It modulates the cognitive tick directly: anxious NPCs get loneliness and anxiety amplification during night hours; avoidant NPCs begin pulling away when trust exceeds 0.6 — closeness itself triggers retreat.

Attachment also shapes PEP distortion: anxious types amplify negative emotional content in their rumination; avoidant types suppress emotional content and produce flatter, more detached distorted memories.

### 9.5 Defense Mechanisms

Located in `src/innerLife.ts` and `src/cognition.ts`.

The classic mechanism set follows Vaillant's hierarchy from immature through neurotic to mature — denial, projection, rationalization, displacement, reaction formation, regression, intellectualization, sublimation, humour, withdrawal, and `none`. Two lighter surface postures, `minimising` and `guardedness`, are also emitted by the runtime defense selector. Activation is automatic when pressure score exceeds the NPC's threshold.

Selection logic is not random. It considers attachment style, current shame level, self-awareness, and the NPC's primary defense — the one they default to under pressure. An avoidant NPC under moderate threat will reach for isolation or withdrawal before they reach for projection.

Each defense produces observable behavior with specific descriptions: withdrawal produces "avoids contact and gives clipped replies"; projection produces "attributes their own fear to the other person." These descriptions enter the dialogue context, shaping how the NPC responds to the player without the player being told what is happening.

### 9.6 Memory System

Located in `src/memory.ts`.

Memory importance scoring weighs: emotional intensity, magnitude of trust change, whether secrets were shared, first impression weight, betrayal at high trust (weighted heavily), kindness when the NPC was vulnerable, and the presence of social witnesses.

Memory decay is modulated by personality. Anxious and brooding types retain negative memories longer than average. Cheerful and warm types retain positive memories longer. The same event, experienced by two NPCs with different personalities, will fade at different rates.

First impression dynamics are asymmetric by design. A bad first impression requires approximately five positive interactions to halve its weight. A good first impression can be wiped by a single negative interaction. This matches the psychological literature and it makes NPCs behave accordingly.

Pattern detection runs across the interaction history. NPCs notice: visit time patterns, location patterns, topic repetition, trust trajectory, visit frequency, avoidance behavior, silence and presence habits, gesture frequency. These detected patterns surface in dialogue — the NPC knows you always come in the evening, even if they don't say so directly.

Promise detection uses regex patterns to identify player messages containing commitments: "I'll help," "I promise," "count on me," and similar phrasings.

### 9.7 Social Engine

Located in `src/socialEngine.ts`.

NPC-to-NPC compatibility is scored across: social class, shared locations, personality match (specific clash pairs like aggressive+timid, specific bond pairs like funny+warm), age proximity, and approachability. The score drives what happens autonomously between NPCs.

Each tick, NPCs with high compatibility (>65) drift naturally toward bonding. NPCs with low compatibility (<35) drift toward friction. No player involvement required — these relationships evolve on their own.

Gossip has a truth probability: 85% true, 15% fabricated. NPCs generate false information not because they are malicious but because they sometimes don't know the truth and fill in the gap.

Emotional contagion runs between co-located NPCs. When an NPC has a strong emotion (intensity >0.5), nearby NPCs absorb it at reduced intensity: 0.3x spread rate, 0.4x absorption rate. Fear, anger, joy, sadness, and anxiety all spread. Contagion is logged per NPC, capped at 15 entries.

Life event generation runs at 5% chance per tick via LLM — something mundane but mood-altering has happened offscreen. A small thing that shifts the NPC's affect for reasons the player will never directly witness.

### 9.8 Agency Engine

Located in `src/agency.ts`.

Each tick, NPCs use LLM-driven decision making to evaluate competing priorities: need, obligation, goal, social, habit, impulse, crisis, avoidance. The context provided includes active life goals, recent events, location populations, strong relationships, and available locations with their current occupants.

NPCs can seek or avoid specific people, initiate conversations, choose topics. When the LLM fails, a routine fallback ensures the NPC always has reasonable behavior — no NPC freezes or acts incoherently because of a failed API call.

NPC-to-NPC conversations are full LLM-generated exchanges with relationship context, shared gossip awareness, and tracked outcomes: emotional results, relationship shifts, gossip generated, overhear fragments that surface for nearby players.

Group conversations emerge when three or more NPCs are co-located (35% chance). The LLM receives full six-directional relationship context — how each NPC relates to each other NPC in the group. Alliance formation, exclusion, mediation can all emerge from the dynamics of who is present and how they relate.

### 9.9 Dream System

Located in `src/cognitiveTick.ts`.

Dreams occur during sleep periods — when time advances six or more hours. A 60% chance of dreaming applies when unresolved material exists: active rumination threads, recent memories, unresolved issues.

The LLM generates dream content at temperature 0.98. The system prompt is explicit: "Dreams are NOT literal. They are symbolic, strange, emotionally resonant." The output is stranger and more compressed than normal LLM text.

Dreams shift affect. Peaceful dreams or dreams with insight provide relief. Distressing dreams increase anxiety and sadness. Dreams that produce processed insights reduce the emotional charge on linked rumination threads by 0.15 — the NPC has, in some sense, worked something out during sleep.

Dream history is stored on the NPC's innerLife, capped at 10 entries. Dreams can surface in dialogue (mentionedInDialogue flag). The NPC may tell the player about a dream. That dream was generated from real internal state.

### 9.10 Player Behavioral Profiling

Tracked in `src/types.ts` (NPCLiveState), implemented in `src/index.ts`.

playerVisitFrequency increments each time the player talks to an NPC. playerAvoidanceScore tracks visits to the NPC's location without talking to them — it increases by 10 per avoidant visit and decreases by 15 per direct interaction, clamped between 0 and 100. playerVisitLog on WorldSession records every location visit with an NPC interaction count.

These patterns surface in dialogue context. NPCs reference visit frequency and avoidance in their system prompts — they know if you come regularly, and they know if you seem to be avoiding them. They may or may not say so.

### 9.11 Witnessing Events

Located in `src/cognition.ts` (`createWitnessMemory`).

When the player talks to an NPC, other NPCs at the same location receive witness memories. The witness memory records who was involved, what happened (truncated to 200 characters), and full cognition proof fields: sourceEventId, groundTruthSummary, realityGap, and biasTags marked as 'witness'.

Witness memories participate in the normal drift and rumination pipeline. A witness can gossip about what they saw, and their account will distort through their own processing type, their own attachment pattern, their own wounds. By the time a third NPC hears it, the original event may be unrecognizable.

### 9.12 Environmental Awareness

Located in `src/types.ts` (EnvironmentalAwareness interface).

Per-NPC tracking of: knownScarcities, recentArrivals, recentDepartures, locationChanges, lastWeatherReaction. Updated during world ticks. This data surfaces in dialogue context so NPCs can comment naturally on environmental changes — a new face in town, a shortage they've noticed, weather that shifted their mood.

### 9.13 NPC-Initiated Contact

Located in `src/cognitiveTick.ts` (pendingApproach in CognitiveTickResult).

When an NPC is seeking the player — high perceived interest, sufficient trust, not avoidant — the cognitive tick generates a pendingApproach. The approach includes a reason classification (urgent_news, gossip, warning, request, emotional_need, gift, confrontation), a message, an urgency score, and an opening line.

Opening lines are LLM-generated when the NPC is actively seeking the player. Approach events appear in the Observatory feed. The player may be approached, not just approach.

### 9.14 Promise and Favor Economy

Located in `src/types.ts` (NPCRequest, NPCPromise).

NPCRequest records what the NPC wants from the player, why they want it, the minimum trust required before they'll ask, and what reciprocal offer they're prepared to make. NPCPromise tracks individual promises — pending, kept, broken, or forgotten — with importance scoring.

Promise detection in player messages uses regex patterns. If the player makes a commitment, it is recorded. NPCs reference pending requests in their dialogue system prompts. The NPC remembers what you said you'd do.

### 9.15 Conflicting Loyalties

Located in `src/cognition.ts` (`detectLoyaltyConflicts`).

Loyalty conflicts are detected when an NPC cares about two people (relationship strength >50) who are themselves in friction with each other (mutual relationship strength <30). The system creates LoyaltyConflict entries and increments tension by 5 each detection cycle.

When tension exceeds 60, the conflict generates an unresolved rumination thread: the NPC is torn between two people and cannot resolve it quietly. NPCs can eventually choose a side (sideChosen field). Resolution is tracked via resolvedDate.

### 9.16 Memory Comparison Between NPCs

Located in `src/cognition.ts` (`compareMemories`).

After NPC-to-NPC conversations, the system finds memories that reference the same ObjectiveEvent across both NPCs. It compares their reconstructions using word-overlap divergence scoring. A conflict is flagged when either NPC's reality gap exceeds 0.3 and text divergence exceeds 0.4.

The output is a conflict description showing how two NPCs remember the same event differently — not abstractly, but with the specific text of each reconstruction compared. Two NPCs who were both present for something can have genuinely incompatible accounts of it.

### 9.17 Silence and Presence Interactions

Interaction kinds extend beyond speech: gesture, action, silence, presence are all valid interaction types.

The player can interact without speaking. Being near an NPC is a form of interaction. NPCs process silence and presence differently in their dialogue context — "The newcomer was nearby but said nothing" or "They stood close, watching." Pattern detection notices these habits over time: an NPC may eventually recognize that this particular player sometimes just stands near them without speaking.

---

## Part 10: The Observatory

The Observatory (`public/observatory.html`) is a real-time monitoring interface for the simulation. It shows what is happening underneath — the part the player does not normally see.

### What It Shows

**Feed**: Live event stream with typed entries — talk, tick, gossip, thought, npc_talk, life_event, approach, dream, group_talk, memory_conflict. The feed renders in the right-hand panel in community view; it shows filter chips and the scrolling event list with no title header.

**People Change Ticker** and **Cognition Proof** panels sit at the top of the community view, summarising live psychological change and the audit chain (objective events, distorted memories, contagion events) across every resident.

**NPC Detail View (Personnel Dossier)**: A tabbed interface per NPC. The portrait fills its frame (`object-fit:cover`, no letterbox gaps). Below the dossier head sits a centered "Current thought" panel, then the psyche button bar: **the buttons that have data render on one centered row, and the empty/no-data buttons are greyed out on a second centered row beneath**. The selected button's content renders into a single centered, auto-scrolling window directly below the buttons. That window has a **pinned header** at its top — an opaque white-text description of what the current tab shows — so it stays visible as the content auto-scrolls and as the player switches buttons.

The 20 psyche aspect buttons (a 21st `Raw` tab dumps the JSON):

- **Psychology**: attachment style, processing type, primary defense, self-awareness level, core wound + triggers, self-concept, values, current mind state, PEP state, recent dreams, intentions, self-narrative.
- **Affect**: valence / arousal / dominance and every discrete emotion intensity (all 21 dimensions, including `anxiety`).
- **Attachment**: full AttachmentProfile — style, intimacy comfort, abandonment fear, trust baseline, vulnerability threshold, pursue/withdraw pattern, conflict response, the wound underneath, trigger patterns.
- **Self-Awareness**: awareness level and processing type, plus the insight sub-flags (knows own triggers/defenses, can name emotions, separates feelings from facts, open to change, accepts criticism, learns from mistakes).
- **Wounds**: the full `wounds[]` array (1–3 wounds) — description, age, healed state, distinct trigger words and trigger situations, the defense each fires, and the surface behaviour the player sees.
- **Defenses**: DefenseProfile (primary, secondary, Vaillant maturity tier, activation threshold) plus the defense-episode log with pressure score, trigger, behaviour, and weighted pressure factors.
- **Relationship (Rel)**: status, interactions, trust, warmth. Theory of player — perceived intent/character/threat/interest, read confidence, predictions, and the (player-invisible) mistaken beliefs. Player opinion, gossip heard, pending approach, visit profile.
- **Memory (Mem)**: all memories with full cognition proof — ground truth alongside current reconstruction, reality gap percentages, drift history, bias tags.
- **Truth Gap**: average/max reality gap, distorted-memory count, and per-memory drift source.
- **Rumination**: unresolved items, PEP state, and rumination threads with their counterfactuals.
- **Trajectory**: time-series of confidence, defensiveness, trust, fear, reality gap, distortion, rumination load, identity conflict.
- **Identity**: the parallel Actor and Observer streams.
- **Contagion**: internal beliefs and the belief-contagion events in/out of this NPC.
- **Conversations**: full conversation history with the player.
- **Goals**: active goals / current goal / desires.
- **NPC Relations**: relationships with other residents.
- **Dreams**: dream history with content, emotional tone, processed insight, and the linked rumination thread that sourced it.
- **Body**: physical needs and toilet/bowel habits, stress-driven avoidance, privacy need.
- **Loyalty**: active conflicts with tension bars, sides chosen, emotional contagion log.
- **Observations**: visit profile, avoidance score, detected behavioral patterns, environmental awareness, witnessed interactions, NPC requests, pending approaches.

All authored traits read from the `WorldNPC` template; all evolving runtime values read from the session-scoped `NPCLiveState.innerLife`. Every field is sourced directly from the data the backend serves at `GET /api/sessions/:id/full`.

**Community view**: NPC cards showing current location, current activity, current mood, and whether the NPC wants to talk.

---

## Part 11: Architecture Summary

```
src/types.ts           — All type definitions (WorldDNA, NPC, Memory, Session, and all new feature types)
src/innerLife.ts       — Psychological substrate (attachment, affect, defense mechanisms, wounds, theory of mind, dreams, loyalty)
src/cognitiveTick.ts   — Between-interaction processing (PEP, cognitive tick, dream processing, pending approach generation)
src/cognition.ts       — Cognition proof layer (objective events, memory drift, rumination, belief contagion, witness memories, loyalty conflicts, memory comparison)
src/memory.ts          — Memory scoring, decay, recall, promise detection, pattern detection
src/socialEngine.ts    — NPC-NPC relationships (compatibility scoring, gossip, emotional contagion, life event generation)
src/agency.ts          — NPC decision making (goals, actions, NPC-NPC conversations, group conversations)
src/dialogue.ts        — Player-NPC dialogue (context building, emotional state injection, behavioral profiling context)
src/index.ts           — Express server, all endpoints (/talk, /tick, /wait, /move, etc.)
public/observatory.html — Real-time monitoring UI
```

The cognitive pipeline runs: Perceive → Feel → Process (PEP) → Think → Update → Decide. Every step generates auditable state. Nothing is a black box.
