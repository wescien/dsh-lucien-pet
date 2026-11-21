export interface BalanceAmount {
    currency: string;
    value: number;
}
export type BalanceView = {
    kind: 'ok';
    amounts: BalanceAmount[];
    bonus: BalanceAmount[];
    low: boolean;
    source: 'account' | 'key';
} | {
    kind: 'no-key';
} | {
    kind: 'invalid';
} | {
    kind: 'failed';
};
export interface BalanceClient {
    /** Plugin version, reported as the client version to the platform. */
    version: string;
    /** UI language of the page that asked. */
    locale: string;
    /** Offset from UTC in seconds, positive east of Greenwich. */
    timezoneOffsetSeconds: number;
}
export declare function queryBalance(ctx: any, client: BalanceClient, note?: (m: string) => void): Promise<BalanceView>;
