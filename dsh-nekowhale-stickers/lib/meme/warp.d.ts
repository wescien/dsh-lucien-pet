import { ImageData } from '@napi-rs/canvas';
export type Pt = [number, number];
/** 解 3×3 单应矩阵 H，使 H·src[i] ≈ dst[i]（齐次坐标） */
export declare function homography(src: Pt[], dst: Pt[]): number[];
/** 把 src（整张，四角 = 它的四个角）贴到 dst 上的 quad（TL,TR,BR,BL），源图为 RGBA，alpha 混合 */
export declare function drawWarped(dst: ImageData, src: ImageData, quad: Pt[]): void;
