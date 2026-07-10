import {
  action,
  SingletonAction,
  type KeyAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { MemberInfo } from "@dsd/shared";
import type { SpeakerStore, SpeakerStoreState } from "../helper-client";
import { AvatarCache } from "../render/avatar-cache";
import { renderInitialsKey, renderSpeakerKey } from "../render/key-svg";
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
}

/**
 * EXHAUSTIVE store -> key mapping. Priority: helper link problems first, then
 * auth blockers, then the Discord status ladder.
 */
export function deriveKey(s: SpeakerStoreState): DerivedKey {
  if (s.helper === "down") return { sig: "helper_down", staticSvg: HELPER_DOWN_KEY, speaker: null };
  if (s.helper === "port_conflict")
    return { sig: "port_conflict", staticSvg: PORT_CONFLICT_KEY, speaker: null };
  if (s.helper === "connecting")
    return { sig: "helper_connecting", staticSvg: CONNECTING_KEY, speaker: null };

  if (s.fatalError !== null) return { sig: "fatal", staticSvg: SETUP_KEY, speaker: null };
  if (s.authRequired === "no_credentials")
    return { sig: "setup", staticSvg: SETUP_KEY, speaker: null };
  if (s.authRequired !== null)
    return { sig: `auth_${s.authRequired}`, staticSvg: AUTH_NEEDED_KEY, speaker: null };

  switch (s.status) {
    case "awaiting_credentials":
      return { sig: "setup", staticSvg: SETUP_KEY, speaker: null };
    case "connecting":
    case "authenticating":
      return { sig: "connecting", staticSvg: CONNECTING_KEY, speaker: null };
    case "authorizing":
      // The consent modal is in ANOTHER app — the key must say where to look.
      return { sig: "authorizing", staticSvg: AUTHORIZING_KEY, speaker: null };
    case "disconnected":
      return { sig: "no_discord", staticSvg: NO_DISCORD_KEY, speaker: null };
    case "no_channel":
      return { sig: "no_channel", staticSvg: NO_CHANNEL_KEY, speaker: null };
    case "subscribed": {
      if (s.speaker === null) return { sig: "idle", staticSvg: IDLE_KEY, speaker: null };
      const sp = s.speaker;
      return {
        sig: `speaker:${sp.userId}:${sp.avatarUrl}:${sp.displayName}`,
        staticSvg: null,
        speaker: sp,
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
    if (this.lastSig.get(a.id) === derived.sig) return; // nothing changed for this key

    const seq = (this.paintSeq.get(a.id) ?? 0) + 1;
    this.paintSeq.set(a.id, seq);

    let svg: string;
    if (derived.staticSvg !== null) {
      svg = derived.staticSvg;
    } else {
      const sp = derived.speaker!;
      const cacheKey = `${sp.userId}-${hashFromUrl(sp.avatarUrl)}`;
      const b64 = await this.avatars.get(sp.avatarUrl, cacheKey);
      if (this.paintSeq.get(a.id) !== seq) return; // superseded while fetching
      svg = b64 !== null ? renderSpeakerKey(sp.displayName, b64) : renderInitialsKey(sp.displayName, sp.userId);
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
