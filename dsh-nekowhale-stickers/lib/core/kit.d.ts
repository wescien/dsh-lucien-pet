import { type SyncResult } from './sync.js';
import type { Attribution, Segment, Sticker, StickerHit, TemplateInfo } from './types.js';
export interface KitOptions {
    /** site origin, default https://kiriyuki.com */
    site?: string;
    /** pack keys to serve */
    packs?: string[];
    /** writable directory for GIFs, caches, renders and state */
    dataDir: string;
    /** bundled snapshot of the knowledge file, used offline and before the first update */
    bundledMeta?: string;
    /** site-relative path of the hosted knowledge file; empty disables remote updates */
    metaPath?: string;
    /** startup: mirror every sticker in the background at start; lazy: download a GIF the first time it is used; off: never touch the network */
    autoSync?: 'startup' | 'lazy' | 'off';
    /** re-check the manifest, meta and template index this often */
    refreshHours?: number;
    /** rules that always hide a sticker: id, stem, code, name, or pack: / tag: / emotion: / group: prefixed */
    blacklist?: string[];
    /** when non-empty, only stickers matching one of these rules exist */
    whitelist?: string[];
    /** template output: mask banned words, as on the website */
    banwords?: boolean;
    log?: (msg: string, level?: 'info' | 'warn') => void;
}
export interface KitState {
    /** all: every sticker except `disabled`; allowlist: only `enabled` */
    mode: 'all' | 'allowlist';
    enabled: string[];
    disabled: string[];
}
export interface RenderOutput {
    /** content id, also the file name stem under renders/ */
    id: string;
    path: string;
    data: Buffer;
    mime: 'image/gif';
    width: number;
    height: number;
    template: TemplateInfo;
    /** banned words were masked */
    masked: boolean;
}
export declare const DEFAULT_SITE = "https://kiriyuki.com";
export declare const DEFAULT_PACKS: string[];
export declare const DEFAULT_ATTRIBUTION: Attribution;
export declare function matchesRule(rule: string, s: Sticker): boolean;
export declare class StickerKit {
    readonly site: string;
    readonly packs: string[];
    readonly fetch: (rel: string, force?: boolean) => Promise<Buffer>;
    private o;
    private meta?;
    private manifest?;
    private stickers;
    private byId;
    private fieldCache;
    private dupStems;
    private state;
    private loaded?;
    private lastRefresh;
    private syncing?;
    private downloads;
    private listeners;
    constructor(options: KitOptions);
    private log;
    /** Called after the catalog or the agent's selection changes. Returns an unsubscribe function. */
    onChange(fn: () => void): () => void;
    private emit;
    /** Load meta, manifest and state. Cheap after the first call; refreshes in the background when stale. */
    ready(): Promise<void>;
    private load;
    private refresh;
    private rebuild;
    /** Mirror every sticker of the configured packs (incremental). */
    sync(): Promise<SyncResult>;
    /** Change selection rules and output options at runtime (e.g. from a settings page). */
    configure(p: {
        blacklist?: string[];
        whitelist?: string[];
        banwords?: boolean;
    }): void;
    get attribution(): Attribution;
    get packInfo(): import("./types.js").PackInfo[];
    get emotions(): string[];
    isEnabled(s: Sticker): boolean;
    /** Every sticker after config black/white lists; `enabledOnly` also applies the agent's own picks. */
    all(enabledOnly?: boolean): Promise<Sticker[]>;
    /** Resolve an id, stem, code or name. */
    resolve(ref: string): Promise<Sticker | undefined>;
    search(query: string, opts?: {
        limit?: number;
        pack?: string;
        emotion?: string;
        includeDisabled?: boolean;
        shuffle?: boolean;
    }): Promise<StickerHit[]>;
    /** Resolve a name, or treat an emotion word (开心, 生气, ...) as "any enabled sticker of that emotion". */
    pick(ref: string): Promise<Sticker | undefined>;
    random(opts?: {
        pack?: string;
        emotion?: string;
    }): Promise<Sticker | undefined>;
    /** Public URL of the original GIF on the site (for bridges that send by URL). */
    url(s: Sticker): string;
    /** Local path of the sticker GIF, downloading it first when needed. */
    file(ref: string | Sticker): Promise<{
        path: string;
        sticker: Sticker;
    }>;
    /**
     * Keep a hash-addressed hard link of every version that was handed out, so image links already written
     * into chat history keep showing the same picture after the art is updated (the main file gets replaced).
     */
    private archive;
    /** File for a hash-addressed link: an archived version first, else the current sticker with that hash. */
    fileByHash(hash: string): Promise<string | undefined>;
    getState(): KitState;
    setEnabled(refs: string[], enabled: boolean): Promise<{
        changed: string[];
        unknown: string[];
    }>;
    setMode(mode: KitState['mode']): Promise<void>;
    resetState(): Promise<void>;
    private statePath;
    private saveState;
    private memeMod?;
    private meme;
    templates(): Promise<TemplateInfo[]>;
    /** Accepts `大肥鱼:think`, `大肥鱼想`, `think` (first pack) or the label `想`. */
    resolveTemplate(ref: string): Promise<TemplateInfo | undefined>;
    render(ref: string, input: {
        text?: string;
        image?: Buffer;
    }): Promise<RenderOutput>;
    renderPath(id: string): string;
    /**
     * Split a model reply on `[sticker:REF]` marks so a chat bridge can send the images as separate messages.
     * REF is a sticker name or an emotion word (random pick). Unknown refs are kept as text.
     */
    parseReply(text: string): Promise<Segment[]>;
    /** Name to show the model: the file stem, or `pack/stem` when several packs share the stem. */
    label(s: Sticker): string;
    /** One compact line per sticker, for browsing or for a small prompt index. */
    line(s: Sticker, detail?: 'short' | 'full'): string;
}
