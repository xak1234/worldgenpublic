import type {
  ConsequenceSummary,
  DramaLead,
  NPCInteractionInterpretation,
  NPCLiveState,
  WorldAdvanceRecap,
  WorldDNA,
  WorldNPC,
  WorldSession,
} from './types.js';

type PriorNpcSnapshot = Pick<NPCLiveState, 'relationship' | 'trustLevel' | 'warmth' | 'fear' | 'totalInteractions'>;

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// NOTE: An identical compact() exists in questEpisode.ts. Both copies are kept
// intentionally to avoid a circular dependency between drama.ts and questEpisode.ts.
function compact(text: string | undefined, fallback = ''): string {
  return String(text ?? fallback).replace(/\s+/g, ' ').trim();
}

function locName(world: WorldDNA, locationId?: string): string | undefined {
  return world.locations.find(location => location.id === locationId)?.name;
}

function npcName(world: WorldDNA, npcId?: string): string | undefined {
  return world.npcs.find(npc => npc.id === npcId)?.name;
}

function lead(
  partial: Omit<DramaLead, 'id'> & { id?: string },
): DramaLead {
  return {
    ...partial,
    id: partial.id ?? `${partial.type}:${partial.npcId ?? ''}:${partial.locationId ?? ''}:${partial.title}`,
    urgency: clamp(Math.round(partial.urgency), 0, 100),
  };
}

function pushUnique(leads: DramaLead[], next: DramaLead): void {
  if (leads.some(existing => existing.id === next.id || existing.title === next.title)) return;
  leads.push(next);
}

function soapLeadType(text: string): DramaLead['type'] {
  const value = text.toLowerCase();
  if (/\baffair|cheat|lover|mistress|romance|kiss|flirt|sleeping with\b/.test(value)) return 'affair';
  if (/\blie|lied|liar|false|cover[- ]?up|alibi\b/.test(value)) return 'lie';
  if (/\bargument|row|fight|feud|threat|shouting|rage\b/.test(value)) return 'argument';
  if (/\btrick|con|scheme|blackmail|bribe|steal|stole|scam|set up\b/.test(value)) return 'trickery';
  if (/\bscandal|secret|shame|disgrace|expose|caught\b/.test(value)) return 'scandal';
  return 'rumor';
}

function soapTone(type: DramaLead['type']): DramaLead['tone'] {
  if (type === 'trickery' || type === 'lie') return 'danger';
  if (type === 'argument' || type === 'affair' || type === 'scandal') return 'tense';
  return 'mysterious';
}

export function deriveDramaLeads(world: WorldDNA, session: WorldSession, limit = 6): DramaLead[] {
  const leads: DramaLead[] = [];
  const currentLocation = world.locations.find(location => location.id === session.currentLocationId);
  const npcsHere = world.npcs.filter(npc => session.npcStates[npc.id]?.currentLocationId === session.currentLocationId);

  for (const npc of world.npcs) {
    const state = session.npcStates[npc.id];
    if (!state) continue;
    const locationName = locName(world, state.currentLocationId);

    for (const secret of (npc.secrets ?? []).filter(Boolean).slice(0, 2)) {
      const type = soapLeadType(secret);
      pushUnique(leads, lead({
        type,
        tone: soapTone(type),
        npcId: npc.id,
        npcName: npc.name,
        locationId: state.currentLocationId,
        locationName,
        title: `${npc.name} has something to hide`,
        detail: compact(secret, 'There is a private truth here that could damage someone if it gets out.'),
        urgency: 76,
        actionLabel: `Probe ${npc.name}`,
        command: `talk to ${npc.name}`,
      }));
    }

    for (const rel of (Array.isArray(npc.relationships) ? npc.relationships : []).filter(r => r.description || r.type).slice(0, 2)) {
      const otherName = npcName(world, rel.npcId) ?? 'someone nearby';
      const text = `${rel.type} ${rel.description}`;
      const type = soapLeadType(text);
      const strained = rel.strength < 35 || ['rival', 'enemy', 'ex', 'affair', 'secret'].some(word => text.toLowerCase().includes(word));
      if (!strained && type === 'rumor') continue;
      pushUnique(leads, lead({
        type: type === 'rumor' ? 'argument' : type,
        tone: soapTone(type === 'rumor' ? 'argument' : type),
        npcId: npc.id,
        npcName: npc.name,
        locationId: state.currentLocationId,
        locationName,
        title: `${npc.name} and ${otherName} have history`,
        detail: compact(rel.description || rel.type, 'There is unfinished business between them.'),
        urgency: clamp(68 + (50 - rel.strength) / 2, 45, 88),
        actionLabel: `Ask ${npc.name}`,
        command: `talk to ${npc.name}`,
      }));
    }

    for (const promise of (state.promises ?? []).filter(p => p.madeByPlayer && p.status === 'pending').slice(-2)) {
      pushUnique(leads, lead({
        type: 'promise',
        tone: 'practical',
        npcId: npc.id,
        npcName: npc.name,
        locationId: state.currentLocationId,
        locationName,
        title: `A promise is hanging over ${npc.name}`,
        detail: compact(promise.description, `${npc.name} is waiting to see whether you mean what you said.`),
        urgency: 82 + (promise.importanceToNPC ?? 0) / 5,
        actionLabel: `Talk to ${npc.name}`,
        command: `talk to ${npc.name}`,
      }));
    }

    if (state.pendingApproach) {
      pushUnique(leads, lead({
        type: 'approach',
        tone: state.pendingApproach.reason === 'warning' || state.pendingApproach.reason === 'confrontation' ? 'danger' : 'tense',
        npcId: npc.id,
        npcName: npc.name,
        locationId: state.currentLocationId,
        locationName,
        title: `${npc.name} wants your attention`,
        detail: compact(state.pendingApproach.openingLine ?? state.pendingApproach.message, `${npc.name} is ready to approach you.`),
        urgency: 70 + (state.pendingApproach.urgency ?? 40) / 3,
        actionLabel: `Face ${npc.name}`,
        command: `talk to ${npc.name}`,
      }));
    }

    const strain = state.relationship === 'hostile' || state.relationship === 'wary' || state.trustLevel < 28 || state.fear > 65;
    if (state.totalInteractions > 0 && strain) {
      pushUnique(leads, lead({
        type: 'tension',
        tone: state.fear > 65 ? 'danger' : 'tense',
        npcId: npc.id,
        npcName: npc.name,
        locationId: state.currentLocationId,
        locationName,
        title: `${npc.name} is not at ease with you`,
        detail: compact(state.playerOpinion || state.currentWorry, 'There is social damage here that can be repaired, tested, or made worse.'),
        urgency: 66 + (100 - state.trustLevel) / 4,
        actionLabel: `Repair or press`,
        command: `talk to ${npc.name}`,
      }));
    }

    const activeGoal = (state.activeGoals ?? []).find(goal => goal.description && goal.progress < 100);
    if (activeGoal && (npcsHere.some(n => n.id === npc.id) || state.totalInteractions > 0)) {
      pushUnique(leads, lead({
        type: 'goal',
        tone: activeGoal.type === 'revenge' || activeGoal.type === 'survival' ? 'tense' : 'practical',
        npcId: npc.id,
        npcName: npc.name,
        locationId: state.currentLocationId,
        locationName,
        title: `${npc.name} wants something`,
        detail: compact(activeGoal.description),
        urgency: 52 + (activeGoal.willingness ?? 40) / 4,
        actionLabel: `Ask ${npc.name}`,
        command: `talk to ${npc.name}`,
      }));
    }
  }

  for (const gossip of (session.activeGossip ?? []).slice(-4).reverse()) {
    const from = npcName(world, gossip.fromNpcId) ?? 'Someone';
    const type = soapLeadType(gossip.content);
    pushUnique(leads, lead({
      type,
      tone: gossip.sentiment === 'warning' ? 'danger' : soapTone(type),
      npcId: gossip.fromNpcId,
      npcName: from,
      title: type === 'rumor' ? 'A rumor is moving through the world' : `A ${type} is starting to spread`,
      detail: compact(gossip.content),
      urgency: gossip.sentiment === 'warning' ? 78 : 62,
      actionLabel: `Ask ${from}`,
      command: `talk to ${from}`,
    }));
  }

  for (const event of (world.timeline ?? []).filter(e => !e.publicKnowledge || e.gossipVersion).slice(-6)) {
    const type = soapLeadType(`${event.title} ${event.description} ${event.gossipVersion}`);
    if (type === 'rumor' && event.publicKnowledge) continue;
    const affected = event.affectedNpcIds?.[0];
    const affectedName = npcName(world, affected);
    pushUnique(leads, lead({
      type: type === 'rumor' ? 'scandal' : type,
      tone: soapTone(type === 'rumor' ? 'scandal' : type),
      npcId: affected,
      npcName: affectedName,
      locationId: event.locationId,
      locationName: locName(world, event.locationId),
      title: event.publicKnowledge ? event.title : `Something about ${event.title} does not add up`,
      detail: compact(event.gossipVersion || event.description, 'People know the story, but not necessarily the truth.'),
      urgency: event.publicKnowledge ? 55 : 74,
      actionLabel: affectedName ? `Ask ${affectedName}` : 'Investigate',
      command: affectedName ? `talk to ${affectedName}` : 'listen',
    }));
  }

  for (const npc of npcsHere) {
    const state = session.npcStates[npc.id];
    if (!state || state.totalInteractions > 0) continue;
    pushUnique(leads, lead({
      type: 'opportunity',
      tone: 'warm',
      npcId: npc.id,
      npcName: npc.name,
      locationId: session.currentLocationId,
      locationName: currentLocation?.name,
      title: `${npc.name} is within reach`,
      detail: compact(state.currentActivity, `${npc.name} is here, and first impressions will stick.`),
      urgency: 48 + (npc.approachability ?? 40) / 5,
      actionLabel: `Meet ${npc.name}`,
      command: `talk to ${npc.name}`,
    }));
  }

  if (currentLocation) {
    const night = session.currentTime >= 20 || session.currentTime < 6;
    pushUnique(leads, lead({
      type: 'place',
      tone: currentLocation.privacyLevel === 'private' || night ? 'mysterious' : 'practical',
      locationId: currentLocation.id,
      locationName: currentLocation.name,
      title: `${currentLocation.name} has social texture`,
      detail: compact(currentLocation.ambientDetail || currentLocation.description, 'Look closer, listen, or study the people here.'),
      urgency: night ? 58 : 42,
      actionLabel: 'Study the place',
      command: 'study room',
    }));
  }

  if (leads.length < 3) {
    const candidates = [...world.npcs]
      .sort((a, b) => (b.approachability ?? 0) - (a.approachability ?? 0))
      .slice(0, 3);
    for (const npc of candidates) {
      pushUnique(leads, lead({
        type: 'explore',
        tone: 'warm',
        npcId: npc.id,
        npcName: npc.name,
        locationId: session.npcStates[npc.id]?.currentLocationId,
        locationName: locName(world, session.npcStates[npc.id]?.currentLocationId),
        title: `Learn what ${npc.name} cares about`,
        detail: compact(npc.coreConcerns?.[0] ?? npc.desires?.[0] ?? npc.occupation, 'Start with a grounded conversation.'),
        urgency: 35 + (npc.approachability ?? 40) / 8,
        actionLabel: `Find ${npc.name}`,
        command: session.npcStates[npc.id]?.currentLocationId === session.currentLocationId ? `talk to ${npc.name}` : `inspect ${npc.name}`,
      }));
    }
  }

  return leads.sort((a, b) => b.urgency - a.urgency).slice(0, limit);
}

export function summarizeInteractionConsequences(args: {
  world: WorldDNA;
  npc: WorldNPC;
  before: PriorNpcSnapshot;
  after: NPCLiveState;
  result: { trustDelta?: number; warmthDelta?: number; gossip?: string; newRelationship?: string };
  interpretation?: NPCInteractionInterpretation;
  promiseDetected?: string | null;
  impossibleGift?: string | null;
  reputation?: string;
}): ConsequenceSummary[] {
  const out: ConsequenceSummary[] = [];
  const trustDelta = args.after.trustLevel - args.before.trustLevel;
  const warmthDelta = args.after.warmth - args.before.warmth;

  if (args.before.relationship !== args.after.relationship) {
    out.push({
      type: 'relationship',
      label: 'Relationship changed',
      detail: `${args.npc.name}: ${args.before.relationship} -> ${args.after.relationship}`,
      severity: ['friendly', 'friend', 'close_friend', 'intimate'].includes(args.after.relationship) ? 'positive' : ['hostile', 'wary'].includes(args.after.relationship) ? 'negative' : 'neutral',
    });
  }
  if (trustDelta !== 0) {
    out.push({
      type: 'trust',
      label: trustDelta > 0 ? 'Trust rose' : 'Trust fell',
      detail: `${args.npc.name} trust ${trustDelta > 0 ? '+' : ''}${trustDelta}`,
      severity: trustDelta > 0 ? 'positive' : 'negative',
    });
  }
  if (warmthDelta !== 0) {
    out.push({
      type: 'warmth',
      label: warmthDelta > 0 ? 'Warmth rose' : 'Warmth fell',
      detail: `${args.npc.name} warmth ${warmthDelta > 0 ? '+' : ''}${warmthDelta}`,
      severity: warmthDelta > 0 ? 'positive' : 'negative',
    });
  }
  if (args.interpretation) {
    out.push({
      type: 'interpretation',
      label: 'They interpreted you',
      detail: args.interpretation.interpretationSummary,
      severity: args.interpretation.distortion > 0.55 ? 'warning' : 'neutral',
    });
  }
  if (args.promiseDetected) {
    out.push({
      type: 'promise',
      label: 'Promise recorded',
      detail: args.promiseDetected,
      severity: 'warning',
    });
  }
  if (args.result.gossip) {
    out.push({
      type: 'gossip',
      label: 'Gossip risk',
      detail: args.result.gossip,
      severity: (args.result.warmthDelta ?? 0) < 0 ? 'negative' : 'warning',
    });
  }
  if (args.impossibleGift) {
    out.push({
      type: 'gift',
      label: 'Impossible gift remembered',
      detail: `${args.npc.name} received ${args.impossibleGift}.`,
      severity: 'warning',
    });
  }
  if (args.reputation && args.reputation !== 'unknown') {
    out.push({
      type: 'reputation',
      label: 'Reputation',
      detail: `People may now think of you as ${args.reputation}.`,
      severity: args.reputation === 'uncanny' || args.reputation === 'strange' ? 'warning' : 'neutral',
    });
  }

  out.push({
    type: 'memory',
    label: 'Memory formed',
    detail: `${args.npc.name} will remember this exchange.`,
    severity: 'neutral',
  });

  return out.slice(0, 6);
}

export function summarizeWorldAdvance(world: WorldDNA, session: WorldSession, entries: string[]): WorldAdvanceRecap {
  const bullets = entries.map(entry => compact(entry)).filter(Boolean).slice(0, 4);
  if (!bullets.length) {
    const here = world.locations.find(location => location.id === session.currentLocationId)?.name ?? 'where you are';
    bullets.push(`Time passes in ${here}. The important changes are quiet for now.`);
  }
  return {
    title: 'The world moved on',
    bullets,
    leads: deriveDramaLeads(world, session, 4),
  };
}
