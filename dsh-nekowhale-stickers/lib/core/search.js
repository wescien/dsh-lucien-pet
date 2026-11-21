const WEIGHTS = [
    ['name', 6], ['tagsJoined', 5], ['emotion', 4], ['text', 4], ['meme', 3], ['use', 3], ['en', 2], ['desc', 1], ['dir', 2],
];
const CJK = /[㐀-鿿豈-﫿]/u;
/** Natural-language aliases used only for retrieval, never shown in the UI. */
const EMOTION_ALIASES = {
    开心: ['高兴', '快乐', '愉快', '笑'],
    大笑: ['爆笑', '哈哈', '笑死'],
    喜欢: ['爱', '心动', '中意'],
    害羞: ['脸红', '羞涩', '不好意思'],
    得意: ['骄傲', '嘚瑟', '自豪'],
    兴奋: ['激动', '期待', '亢奋'],
    惊讶: ['震惊', '吃惊', '意外'],
    疑惑: ['困惑', '疑问', '好奇'],
    思考: ['想', '琢磨', '考虑'],
    无语: ['沉默', '尴尬', '说不出话'],
    难过: ['伤心', '委屈', '失落'],
    哭: ['流泪', '呜呜', '眼泪'],
    生气: ['愤怒', '气死', '火大'],
    害怕: ['恐惧', '怕', '吓'],
    疲惫: ['累', '困', '疲劳', '摸鱼'],
    赞同: ['同意', '赞成', '对'],
    拒绝: ['不要', '不行', '拒绝'],
    打招呼: ['嗨', '你好', '挥手'],
    感谢: ['谢谢', '多谢', '感激'],
    道歉: ['对不起', '抱歉', '道歉'],
    卖萌: ['可爱', '撒娇', '萌'],
    搞怪: ['搞笑', '沙雕', '捣蛋', '吃瓜'],
    嘲讽: ['吐槽', '嘲笑', '讽刺'],
    安慰: ['抱抱', '别难过', '安慰'],
    其他: [],
};
export function terms(query) {
    return query.toLowerCase().split(/[\s,，。.!！?？、;；:：/|]+/u).filter(Boolean);
}
function bigrams(s) {
    const out = [];
    for (let i = 0; i + 1 < s.length; i++)
        out.push(s.slice(i, i + 2));
    return out;
}
export function fields(s) {
    const tags = (s.tags ?? []).concat(EMOTION_ALIASES[s.emotion] ?? []);
    return {
        name: s.name, tagsJoined: tags.join(' '), emotion: s.emotion ?? '', text: s.text ?? '',
        meme: s.meme ?? '', use: s.use ?? '', en: s.en ?? '', desc: s.desc ?? '', dir: s.dir ?? '',
    };
}
export function score(s, qs, cache) {
    let f = cache?.get(s.id);
    if (!f) {
        f = Object.fromEntries(Object.entries(fields(s)).map(([k, v]) => [k, v.toLowerCase()]));
        cache?.set(s.id, f);
    }
    let total = 0;
    let matched = 0;
    for (const q of qs) {
        let best = 0;
        for (const [key, w] of WEIGHTS) {
            const v = f[key] ?? '';
            if (!v)
                continue;
            if (v.includes(q))
                best = Math.max(best, w * (v === q ? 1.5 : 1));
            else if (CJK.test(q) && q.length > 2) {
                const bg = bigrams(q);
                const hit = bg.filter((b) => v.includes(b)).length;
                if (hit)
                    best = Math.max(best, (w * hit) / bg.length * 0.8);
            }
        }
        total += best;
        if (best > 0)
            matched++;
    }
    // Prefer stickers that satisfy every term of the query over ones that match a single term strongly.
    return qs.length > 1 ? total * (matched / qs.length) ** 2 : total;
}
