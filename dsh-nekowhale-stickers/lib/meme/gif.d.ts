import { ImageData, type Canvas } from '@napi-rs/canvas';
export interface GifFrames {
    w: number;
    h: number;
    frames: ImageData[];
    delays: number[];
}
export declare function decodeGif(data: Buffer): Promise<GifFrames>;
/** 帧序列 → GIF（透明背景保留为 1 位透明），delays 为毫秒。
    调色板用全部帧的不透明像素抽样一起算一份、每帧共用：逐帧各算会让静止的部分逐帧换色，看起来一直在闪。
    按 RGB565 量化（不是 RGBA4444）：4 位一通道太粗，近黑的字会被并进深藏青的头发色里，字看着发蓝 */
export declare function encodeGif(frames: ImageData[], delays: number[]): Buffer;
/** 把 ImageData 画到一张新画布上（拿来当 drawImage 的源） */
export declare function toCanvas(img: ImageData): Canvas;
