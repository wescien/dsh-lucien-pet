export interface BanTable {
    version: string;
    salt: string;
    /** 词表里出现过的长度（字数），从长到短 */
    lens: number[];
    /** 摘要（16 位十六进制），已排序 */
    h: string[];
}
/** 逐字归一化：全角 ASCII → 半角，全角空格 → 空格，英文字母转小写（和 tools/banwords.mjs 一致） */
export declare function fold(ch: string): string;
export declare function sha256Hex(s: string): string;
/** 一个词（已归一化）的摘要：SHA-256(salt + 词) 前 8 字节 */
export declare const digest: (salt: string, folded: string) => string;
/** 打码：返回打码后的文字和有没有命中。表是空的就原样返回 */
export declare function maskText(text: string, table?: BanTable): {
    text: string;
    masked: boolean;
};
