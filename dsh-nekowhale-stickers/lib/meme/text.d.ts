import { type Canvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
export { ensureFont } from './fonts.js';
export declare const FONT_KAI = "Kai";
export declare const FONT_BLACK = "NotoBlack";
/** 均衡分行：含换行 / 空格的按换行拆（拉丁文交给自然换行），否则按方块字均分 */
export declare function balancedLines(text: string, W: number, H: number): string[];
/** 字体在某字号下的 ascent / descent / 行高，按服务端 skia 量出来的口径写死（浏览器的 fontBoundingBox 用的是 OS/2 typo 值，
    Noto Black 会少算三成行高，字就排大了）：
    - 文鼎简中楷 gkai00mp：ascent 0.8789、descent 0.1201、leading 0.0059 → 行高 ≈ 1.005 em
    - Noto Sans CJK SC Black：ascent 1.16、descent 0.288 → 行高 1.448 em
    skia paragraph 每行高度取整（round），这里照做 */
export declare function fontMetrics(_ctx: SKRSContext2D, px: number, family: string, _weight: number): {
    asc: number;
    desc: number;
    lineH: number;
};
/** 最大字号：从 maxPx 逐 1 递减，直到最长行 ≤ W 且 行数 × 行高 ≤ H（和 pil_utils.draw_text 同一口径）；放不下就返回 minPx */
export declare function fitFont(ctx: SKRSContext2D, lines: string[], W: number, H: number, family: string, weight: number, maxPx: number, minPx: number): number;
export interface TextBlockOpts {
    family: string;
    weight: number;
    color: string;
    maxPx: number;
    minPx: number;
    /** 描边宽度占字号比例（0 = 不描）；实际描边宽 = round(字号 × 比例)，和服务端一样 */
    strokeRatio?: number;
    /** 多行时各行怎么对齐：整块居中后，'left' = 各行左端对齐（pil_utils draw_text 的默认 lines_align），'center' = 各行各自居中 */
    linesAlign?: 'left' | 'center';
}
/** 把文字排进 W×H 的透明画布，居中 */
export declare function renderTextBlock(W: number, H: number, text: string, o: TextBlockOpts): Canvas;
/** 竖排长条：W 宽 L 长，每个字在自己的格里居中（上联 / 下联） */
export declare function renderVerticalStrip(W: number, L: number, text: string, family: string, weight: number, color: string): Canvas;
/** 任意图片 → 方形居中裁剪 → 圆形（抗锯齿靠 2 倍超采样） */
export declare function circularAvatar(img: (Canvas | Image) & {
    width?: number;
    height?: number;
}, dia: number, srcW: number, srcH: number): Canvas;
