import Schema from '@deepseek-ai/schemastery';
export * from './core/index.js';
export declare const name = "nekowhale-stickers";
export declare const inject: string[];
/** Other plugins can `inject: ['stickers']` and call `ctx.stickers.search()`, `.file()`, `.parseReply()`, ... */
export declare const provide = "stickers";
export interface Config {
    site: string;
    packs: string[];
    dataDir?: string;
    autoSync: 'startup' | 'lazy' | 'off';
    refreshHours: number;
    metaPath: string;
    blacklist: string[];
    whitelist: string[];
    persona: 'self' | 'neutral';
    promptMode: 'skill' | 'hint' | 'index' | 'off';
    frequency: 'rare' | 'normal' | 'often';
    indexLimit: number;
    agentCuration: boolean;
    templates: boolean;
    banwords: boolean;
    searchLimit: number;
    returnImageToModel: boolean;
    pet: boolean;
    petHeight: number;
    petBubbles: boolean;
    petBalance: boolean;
    publicBaseUrl?: string;
    routePath: string;
}
export declare const Config: Schema<Config>;
declare const LIVE_KEYS: readonly ['pet', 'petHeight', 'petBubbles', 'petBalance', 'persona', 'promptMode', 'frequency', 'indexLimit', 'searchLimit', 'returnImageToModel', 'agentCuration', 'templates', 'banwords', 'blacklist', 'whitelist'];
type Live = Pick<Config, typeof LIVE_KEYS[number]>;
export declare const Settings: Schema<Live>;
export declare function apply(ctx: any, config: Config): void;
