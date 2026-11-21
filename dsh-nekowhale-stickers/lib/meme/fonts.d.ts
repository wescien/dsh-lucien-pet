import type { Fetcher } from './types.js';
export declare function withFonts<T>(fetch: Fetcher, work: () => Promise<T>): Promise<T>;
export declare function fontFamilies(family: string): string;
/** Separate aliases preserve every chunk: registering subsets under one name can replace prior subsets in Skia. */
export declare function ensureFont(family: string, _weight: number, text: string): Promise<void>;
