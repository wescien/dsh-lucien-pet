import type { Sticker } from './types.js';
export declare function terms(query: string): string[];
export declare function fields(s: Sticker): Record<string, string>;
export declare function score(s: Sticker, qs: string[], cache?: Map<string, Record<string, string>>): number;
