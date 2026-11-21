import type { Fetcher } from './types.js';
export type { Fetcher } from './types.js';
export type TemplateKey = 'hug' | 'couplet_top' | 'couplet_bottom' | 'think' | 'scroll' | 'sign';
export interface TemplateDef {
    key: TemplateKey;
    label: string;
    fileLabel: string;
    /** 输入是文字还是头像 */
    input: 'text' | 'image';
    defaultText: string;
    maxLen: number;
}
export declare const TEMPLATES: TemplateDef[];
export interface MemeInputs {
    text?: string;
    image?: Buffer;
}
export interface MemeResult {
    data: Buffer;
    mime: 'image/gif';
    width: number;
    height: number;
    masked: boolean;
}
export interface MemeIndex {
    packs: Record<string, Partial<Record<TemplateKey, string>>>;
    skipped: Record<string, Record<string, string>>;
    templates: string[];
    generated?: string;
    assets?: Record<string, Record<string, string>>;
}
export declare function loadMemeIndex(fetch: Fetcher): Promise<MemeIndex>;
export declare function listTemplates(index: MemeIndex, pack?: string): {
    pack: string;
    tpl: TemplateKey;
    title: string;
    inputs: {
        texts: number;
        images: number;
    };
    defaultText: string;
}[];
export declare function renderMeme(fetch: Fetcher, pack: string, tpl: TemplateKey, inputs: MemeInputs, opts?: {
    watermark?: boolean;
    banwords?: boolean;
}): Promise<MemeResult>;
