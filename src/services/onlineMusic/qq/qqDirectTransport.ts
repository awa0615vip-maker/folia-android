// src/services/onlineMusic/qq/qqDirectTransport.ts
//
// 安卓直连 QQ 音乐官方接口的传输层（无后端模式）。
//
// 上游架构里 QQ 音乐所有请求走 VITE_QQ_API_BASE 指向的自部署后端（@yakult-green-tea/qq-music-api）
// 或 Electron 内嵌后端；安卓两者都没有，音源整体不可用。本文件用官方 Web 端接口
// （u.y.qq.com/cgi-bin/musicu.fcg 的 DoSearchForQQMusicDesktop / CgiGetVkey）本地实现
// 搜索与取流，返回与后端一致的响应 JSON，provider 层无需改动。
//
// 接口实测：搜索可用（ct:23, cv:0, platform:yqq.json）；免登录取流只回试听文件
// （purl 为空，完整播放需登录，登录为后续版本）。

import { OnlineProviderError } from '../../../types/onlineMusic';

const QQ_UA = 'Mozilla/5.0 (Linux; Android 14; Xiaomi 14 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// 本机设备标识：QQ 播放需要 guid（10 位以上数字串），一次生成后全链路复用。
let qqGuid: string | null = null;
export const getQqGuid = (): string => {
    if (!qqGuid) {
        qqGuid = `${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 9000 + 1000)}`;
    }
    return qqGuid;
};

// musicu.fcg 统一请求：comm + 命名 req_1..req_N
const qqMusicu = async <T = any>(
    module: string,
    method: string,
    param: Record<string, unknown>,
): Promise<T> => {
    const response = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': QQ_UA,
            Referer: 'https://y.qq.com/',
        },
        body: JSON.stringify({
            comm: { ct: 23, cv: 0, uin: 0, format: 'json', platform: 'yqq.json' },
            req_1: { module, method, param },
        }),
    });
    if (!response.ok) {
        throw new OnlineProviderError('network', `QQMusic direct request failed (HTTP ${response.status})`, 'qq');
    }
    let body: any;
    try {
        body = await response.json();
    } catch {
        throw new OnlineProviderError('invalid-response', 'QQMusic direct request returned an unreadable body', 'qq');
    }
    const req = body?.req_1;
    if (!req) {
        throw new OnlineProviderError('invalid-response', 'QQMusic direct request answered no req_1', 'qq', body);
    }
    if (Number(req.code) !== 0) {
        throw new OnlineProviderError(
            'unavailable',
            `QQMusic direct request refused (code ${req.code})`,
            'qq',
            req,
        );
    }
    return req.data as T;
};

// 搜索：DoSearchForQQMusicDesktop → 后端 search 响应形状 { items, total }
export const qqDirectSearch = async (params: Record<string, unknown>): Promise<any> => {
    const keyword = String(params.keyword ?? params.keywords ?? '');
    if (!keyword) throw new OnlineProviderError('invalid-response', 'QQ search needs a keyword', 'qq');
    const page = Number(params.page ?? 1) || 1;
    const limit = Number(params.limit ?? params.pageSize ?? 30) || 30;
    const data = await qqMusicu(
        'music.search.SearchCgiService',
        'DoSearchForQQMusicDesktop',
        { search_type: 0, query: keyword, num_per_page: limit, page_num: page, grp: 1 },
    );
    const songList = data?.body?.song?.list ?? [];
    const total = Number(data?.body?.song?.totalNumber ?? songList.length);
    return {
        items: songList,
        total,
        more: songList.length >= limit,
    };
};

// 取流：CgiGetVkey → 后端 music_play 响应形状 { data: { playUrl: { [songmid]: { url } } } }
export const qqDirectPlay = async (params: Record<string, unknown>): Promise<any> => {
    const songmid = String(params.songmid ?? '');
    if (!songmid) throw new OnlineProviderError('invalid-response', 'QQ play needs a songmid', 'qq');
    const guid = getQqGuid();
    const data = await qqMusicu(
        'vkey.GetVkeyServer',
        'CgiGetVkey',
        { guid, songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
    );
    const entries = Array.isArray(data?.midurlinfo) ? data.midurlinfo : [];
    const entry = entries[0] ?? {};
    const purl = String(entry?.purl ?? '');
    const playUrlMap: Record<string, { url: string; preview?: boolean }> = {
        [songmid]: { url: purl },
    };
    // 免登录时 purl 为空：把官方给的试听文件名（testfile2g/testfilewifi）补进 preview 字段，
    // provider 的试听路径（requestQqPreviewSource）能拿到片段。
    const wantPreview = Number(params.preview ?? 0) === 1;
    const testFile = String(data?.testfile2g || data?.testfilewifi || '');
    if (wantPreview && testFile) {
        const sip = Array.isArray(data?.sip) && data.sip.length > 0 ? data.sip[0] : 'https://aqqmusic.tc.qq.com/';
        playUrlMap[songmid] = { url: `${sip}${testFile}`, preview: true };
    }
    return { data: { playUrl: playUrlMap } };
};

// 安卓直连统一入口：operation + params → 后端风格 JSON。
export const requestQqDirect = async (
    operation: string,
    params: Record<string, unknown>,
): Promise<any> => {
    switch (operation) {
        case 'search':
            return qqDirectSearch(params);
        case 'music_play':
            return qqDirectPlay(params);
        default:
            throw new OnlineProviderError(
                'unsupported',
                `QQ operation ${operation} is not available in Android direct mode`,
                'qq',
            );
    }
};
