/**
 * Tracks channel members + the speaking set and derives the debounced
 * "current speaker" (most-recent-to-start wins — the decided tie-break).
 *
 * Debounce rules:
 * - null -> someone:            emit immediately (instant feedback)
 * - someone -> different someone: 250 ms switch debounce (kills A/B flicker)
 * - someone -> null:            1500 ms idle hold (bridges VAD gaps between phrases)
 * - timers cross-cancel; identical derivation is a no-op
 */
import { EventEmitter } from "node:events";
import type { MemberInfo } from "@dsd/shared";
import { IDLE_HOLD_MS, SWITCH_DEBOUNCE_MS } from "@dsd/shared";

/** Raw (already snake_case-normalized) voice state from GET_CHANNEL / VOICE_STATE_*. */
export interface RawVoiceState {
  nick?: string | null;
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
    discriminator?: string;
  };
}

export interface TrackedMember extends MemberInfo {
  username: string;
  globalName: string | null;
  nick: string | null;
  avatarHash: string | null;
}

/**
 * Default-avatar index:
 * - legacy users/bots (discriminator !== "0"): discriminator % 5  (5 legacy assets)
 * - new username system:                       (id >> 22) % 6     (6 assets)
 * Realistic legacy hit: music bots in voice channels.
 */
export function buildAvatarUrl(
  userId: string,
  avatarHash: string | null | undefined,
  discriminator: string | undefined,
): string {
  if (avatarHash) {
    // Works for animated "a_..." hashes too — requesting .png returns a static frame
    // (setImage can't animate anyway).
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=128`;
  }
  let index = 0;
  if (discriminator && discriminator !== "0") {
    index = Number(discriminator) % 5;
  } else {
    try {
      index = Number(BigInt(userId) >> 22n) % 6;
    } catch {
      index = 0;
    }
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function memberFromVoiceState(vs: RawVoiceState): TrackedMember | null {
  const user = vs.user;
  if (!user?.id) return null;
  const username = user.username ?? user.id;
  const globalName = user.global_name ?? null;
  const nick = vs.nick ?? null;
  return {
    userId: user.id,
    displayName: nick || globalName || username,
    avatarUrl: buildAvatarUrl(user.id, user.avatar, user.discriminator),
    username,
    globalName,
    nick,
    avatarHash: user.avatar ?? null,
  };
}

export interface SpeakerTrackerOptions {
  switchDebounceMs?: number;
  idleHoldMs?: number;
  now?: () => number;
}

/**
 * Events:
 * - "speaker" (speaker: MemberInfo | null, speakingCount: number)
 * - "roster"  (members: MemberInfo[])
 */
export class SpeakerTracker extends EventEmitter {
  private readonly members = new Map<string, TrackedMember>();
  private readonly speaking = new Map<string, number>(); // userId -> startedAtMs
  private readonly switchDebounceMs: number;
  private readonly idleHoldMs: number;
  private readonly now: () => number;

  /** What the plugin currently shows. Initial state IS "idle" (snapshot covers new clients). */
  private lastEmitted: MemberInfo | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingKind: "switch" | "idle" | null = null;

  constructor(opts: SpeakerTrackerOptions = {}) {
    super();
    this.switchDebounceMs = opts.switchDebounceMs ?? SWITCH_DEBOUNCE_MS;
    this.idleHoldMs = opts.idleHoldMs ?? IDLE_HOLD_MS;
    this.now = opts.now ?? Date.now;
  }

  get memberList(): MemberInfo[] {
    return [...this.members.values()].map(toMemberInfo);
  }

  get currentSpeaker(): MemberInfo | null {
    return this.lastEmitted;
  }

  get speakingCount(): number {
    return this.speaking.size;
  }

  /** Full roster replacement (bootstrap / channel resync). Authoritative. */
  setRoster(states: RawVoiceState[]): void {
    this.members.clear();
    for (const vs of states) {
      const m = memberFromVoiceState(vs);
      if (m) this.members.set(m.userId, m);
    }
    for (const userId of [...this.speaking.keys()]) {
      if (!this.members.has(userId)) this.speaking.delete(userId);
    }
    this.emitRoster();
    this.recompute();
  }

  /** VOICE_STATE_CREATE / VOICE_STATE_UPDATE. */
  upsertMember(vs: RawVoiceState): void {
    const m = memberFromVoiceState(vs);
    if (!m) return;
    this.members.set(m.userId, m);
    this.emitRoster();
    // Mid-speech identity change: if the CURRENT speaker's name/avatar changed,
    // re-emit immediately (same person — no flicker risk).
    if (
      this.lastEmitted?.userId === m.userId &&
      (this.lastEmitted.displayName !== m.displayName || this.lastEmitted.avatarUrl !== m.avatarUrl)
    ) {
      this.lastEmitted = toMemberInfo(m);
      this.emit("speaker", this.lastEmitted, this.speaking.size);
      return;
    }
    this.recompute();
  }

  /** VOICE_STATE_DELETE. */
  removeMember(userId: string): void {
    this.members.delete(userId);
    this.speaking.delete(userId);
    this.emitRoster();
    this.recompute();
  }

  speakingStart(userId: string): void {
    // Ghost guard: discard events for users not in the installed roster.
    // (Only used AFTER a roster is installed — the session buffers bootstrap-window events.)
    if (!this.members.has(userId)) return;
    if (!this.speaking.has(userId)) this.speaking.set(userId, this.now());
    this.recompute();
  }

  speakingStop(userId: string): void {
    this.speaking.delete(userId);
    this.recompute();
  }

  /** IPC disconnect / channel switch: wipe everything, go idle IMMEDIATELY (no stale speaker). */
  clear(): void {
    this.members.clear();
    this.speaking.clear();
    this.cancelPending();
    this.emitRoster();
    if (this.lastEmitted !== null) {
      this.lastEmitted = null;
      this.emit("speaker", null, 0);
    }
  }

  // ---- derivation + debounce ----

  private derive(): MemberInfo | null {
    let bestId: string | null = null;
    let bestAt = -1;
    for (const [userId, at] of this.speaking) {
      if (at > bestAt) {
        bestAt = at;
        bestId = userId;
      }
    }
    if (bestId === null) return null;
    const m = this.members.get(bestId);
    return m ? toMemberInfo(m) : null;
  }

  private recompute(): void {
    const derived = this.derive();
    const current = this.lastEmitted;

    if (sameSpeaker(derived, current)) {
      // Derivation matches what's shown; cancel any pending change.
      this.cancelPending();
      return;
    }

    if (derived !== null && current === null) {
      // idle -> someone: instant.
      this.cancelPending();
      this.emitSpeaker(derived);
      return;
    }

    if (derived !== null) {
      // someone -> different someone: switch debounce.
      this.schedule("switch", this.switchDebounceMs);
      return;
    }

    // someone -> null: idle hold.
    this.schedule("idle", this.idleHoldMs);
  }

  private schedule(kind: "switch" | "idle", ms: number): void {
    if (this.pendingKind === kind) return; // already pending; let it fire
    this.cancelPending();
    this.pendingKind = kind;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pendingKind = null;
      const derived = this.derive();
      if (!sameSpeaker(derived, this.lastEmitted)) {
        this.emitSpeaker(derived);
      }
    }, ms);
  }

  private cancelPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingKind = null;
  }

  private emitSpeaker(speaker: MemberInfo | null): void {
    this.lastEmitted = speaker;
    this.emit("speaker", speaker, this.speaking.size);
  }

  private emitRoster(): void {
    this.emit("roster", this.memberList);
  }
}

function toMemberInfo(m: TrackedMember): MemberInfo {
  return { userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl };
}

function sameSpeaker(a: MemberInfo | null, b: MemberInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.userId === b.userId;
}
