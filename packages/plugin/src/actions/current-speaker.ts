import {
  action,
  SingletonAction,
  type KeyAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { MemberInfo } from "@dsd/shared";
import type { SpeakerStore, SpeakerStoreState } from "../helper-client";
import { AvatarCache } from "../render/avatar-cache";
import { renderIdleGuildKey, renderInitialsKey, renderSpeakerKey } from "../render/key-svg";
import {
  AUTH_NEEDED_KEY,
  AUTHORIZING_KEY,
  CONNECTING_KEY,
  HELPER_DOWN_KEY,
  IDLE_KEY,
  NO_CHANNEL_KEY,
  NO_DISCORD_KEY,
  PORT_CONFLICT_KEY,
  SETUP_KEY,
  svgToDataUri,
} from "../render/states";

interface DerivedKey {
  /** Cheap identity of what would be painted — dedup + stale-paint guard. */
  sig: string;
  staticSvg: string | null;
  speaker: MemberInfo | null;
  /** Idle-in-VC only: the guild icon to show dimmed (null -> static dim-mic key). */
  guildIconUrl: string | null;
}

/**
 * EXHAUSTIVE store -> key mapping. Priority: helper link problems first, then
 * auth blockers, then the Discord status ladder.
 */
export function deriveKey(s: SpeakerStoreState): DerivedKey {
  const staticKey = (sig: string, svg: string): DerivedKey => ({
    sig,
    staticSvg: svg,
    speaker: null,
    guildIconUrl: null,
  });

  if (s.helper === "down") return staticKey("helper_down", HELPER_DOWN_KEY);
  if (s.helper === "port_conflict") return staticKey("port_conflict", PORT_CONFLICT_KEY);
  if (s.helper === "connecting") return staticKey("helper_connecting", CONNECTING_KEY);

  if (s.fatalError !== null) return staticKey("fatal", SETUP_KEY);
  if (s.authRequired === "no_credentials") return staticKey("setup", SETUP_KEY);
  if (s.authRequired !== null) return staticKey(`auth_${s.authRequired}`, AUTH_NEEDED_KEY);

  switch (s.status) {
    case "awaiting_credentials":
      return staticKey("setup", SETUP_KEY);
    case "connecting":
    case "authenticating":
      return staticKey("connecting", CONNECTING_KEY);
    case "authorizing":
      // The consent modal is in ANOTHER app — the key must say where to look.
      return staticKey("authorizing", AUTHORIZING_KEY);
    case "disconnected":
      return staticKey("no_discord", NO_DISCORD_KEY);
    case "no_channel":
      return staticKey("no_channel", NO_CHANNEL_KEY);
    case "subscribed": {
      if (s.speaker === null) {
        // Nobody talking: the guild's icon, dimmed. No icon (DM call, icon-less
        // guild, fetch failure upstream) -> the static dim-mic key.
        if (s.guildIconUrl === null) return staticKey("idle", IDLE_KEY);
        return {
          sig: `idle:${s.guildIconUrl}`,
          staticSvg: null,
          speaker: null,
          guildIconUrl: s.guildIconUrl,
        };
      }
      const sp = s.speaker;
      return {
        sig: `speaker:${sp.userId}:${sp.avatarUrl}:${sp.displayName}`,
        staticSvg: null,
        speaker: sp,
        guildIconUrl: null,
      };
    }
    default: {
      // Exhaustiveness: a new DiscordStatus variant fails the build here.
      const never: never = s.status;
      return never;
    }
  }
}

@action({ UUID: "com.vitamin.speaker-for-discord.current-speaker" })
export class CurrentSpeaker extends SingletonAction {
  private readonly lastSig = new Map<string, string>(); // action context id -> painted sig
  private readonly paintSeq = new Map<string, number>(); // stale async-paint guard
  private readonly avatars = new AvatarCache();

  constructor(private readonly store: SpeakerStore) {
    super();
    store.on("changed", () => void this.paintAll());
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    // Whole key renders inside the SVG; suppress the title overlay for good.
    await ev.action.setTitle("");
    this.lastSig.delete(ev.action.id);
    await this.paint(ev.action);
  }

  /** Repaint EVERY visible instance of the action (any profile/page/device). */
  async paintAll(): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    for (const a of this.actions) {
      if (a.isKey()) jobs.push(this.paint(a));
    }
    await Promise.all(jobs);
  }

  private async paint(a: KeyAction): Promise<void> {
    const derived = deriveKey(this.store.state);

    // Bump BEFORE the dedup return: a dedup'd call means the key already shows the
    // newest state, so any in-flight (necessarily older) paint must be cancelled —
    // otherwise it lands after this return and overwrites a live key (e.g. a slow
    // idle-icon fetch painting over a speaker who resumed talking).
    const seq = (this.paintSeq.get(a.id) ?? 0) + 1;
    this.paintSeq.set(a.id, seq);

    if (this.lastSig.get(a.id) === derived.sig) return; // nothing changed for this key

    let svg: string;
    if (derived.staticSvg !== null) {
      svg = derived.staticSvg;
    } else if (derived.speaker !== null) {
      const sp = derived.speaker;
      const cacheKey = `${sp.userId}-${hashFromUrl(sp.avatarUrl)}`;
      const b64 = await this.avatars.get(sp.avatarUrl, cacheKey);
      if (this.paintSeq.get(a.id) !== seq) return; // superseded while fetching
      svg = b64 !== null ? renderSpeakerKey(sp.displayName, b64) : renderInitialsKey(sp.displayName, sp.userId);
    } else {
      // Idle with a guild icon (deriveKey guarantees the URL here).
      const url = derived.guildIconUrl!;
      const b64 = await this.avatars.get(url, guildIconCacheKey(url));
      if (this.paintSeq.get(a.id) !== seq) return; // superseded while fetching
      svg = b64 !== null ? renderIdleGuildKey(b64) : IDLE_KEY;
    }

    this.lastSig.set(a.id, derived.sig);
    await a.setImage(svgToDataUri(svg));
  }
}

/** Distills the changing part of a CDN URL into a filesystem-safe cache key. */
function hashFromUrl(url: string): string {
  const m = /avatars\/\d+\/([^./]+)\.png/.exec(url);
  if (m) return m[1]!;
  const d = /embed\/avatars\/(\d+)\.png/.exec(url);
  return d ? `default-${d[1]}` : "unknown";
}

/** guild-{gid}-{hash}: the prefix can't collide with avatar keys (those start with a numeric userId). */
function guildIconCacheKey(url: string): string {
  const m = /icons\/(\d{17,20})\/([A-Za-z0-9_]{1,64})\.png/.exec(url);
  return m ? `guild-${m[1]}-${m[2]}` : "guild-unknown";
}
