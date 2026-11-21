export interface CachedFetcherOptions {
    site: string;
    dir: string;
    ttlMs?: number;
    headers?: Record<string, string>;
    /** never touch the network: serve the cache or fail */
    offline?: boolean;
}
export declare function createCachedFetcher(o: CachedFetcherOptions): (rel: string, force?: boolean) => Promise<Buffer>;
