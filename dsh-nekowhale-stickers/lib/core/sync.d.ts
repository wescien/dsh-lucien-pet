export interface ManifestItem {
    id: string;
    pack: string;
    stem: string;
    code: string;
    group: string;
    num: number;
    name: string;
    variant: string;
    file: string;
    hash: string;
    bytes: number;
    w: number;
    h: number;
    frames: number;
    seconds: number;
}
export interface Manifest {
    version: number;
    updated: string;
    gif_base: string;
    packs: {
        key: string;
        label: string;
        desc: string;
        count: number;
    }[];
    items: ManifestItem[];
}
export interface SyncOptions {
    site: string;
    packs: string[];
    dir: string;
    concurrency?: number;
    prune?: boolean;
    userAgent?: string;
    log?: (msg: string) => void;
}
export interface SyncResult {
    manifestVersion: number;
    notModified: boolean;
    downloaded: string[];
    removed: string[];
    failed: {
        id: string;
        error: string;
    }[];
    total: number;
}
export declare function fetchRetry(url: string, init?: RequestInit, tries?: number): Promise<Response>;
/**
 * Fetch the manifest, reusing the cached copy when the server answers 304. Prefers the kit endpoint when it
 * covers every requested pack, and falls back to /api/manifest when the site does not serve it (404).
 */
export declare function loadManifest(site: string, dir: string, headers?: Record<string, string>, packs?: string[]): Promise<{
    manifest: Manifest;
    notModified: boolean;
}>;
export declare const gifUrl: (site: string, m: Manifest, it: ManifestItem) => string;
/** Mirror the selected packs into `<dir>/packs/<pack>/<file>`; only changed or missing files are downloaded. */
export declare function syncPacks(o: SyncOptions): Promise<SyncResult>;
