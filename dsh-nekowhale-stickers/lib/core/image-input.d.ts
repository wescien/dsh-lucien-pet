export declare function isImage(b: Uint8Array): boolean;
export declare function loadImageInput(src: string, opts?: {
    allowPrivate?: boolean;
    signal?: AbortSignal;
}): Promise<Buffer>;
