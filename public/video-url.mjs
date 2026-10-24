const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const YOUTUBE_EMBED_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_BV = /^BV[A-Za-z0-9]{10}$/;
const BILIBILI_AV = /^av[1-9][0-9]*$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function validPart(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function oneParameter(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error('链接里有重复参数，请重新复制视频地址。');
  return values[0];
}

function parsePart(url) {
  const value = oneParameter(url, 'p');
  if (value === undefined) return 1;
  if (!POSITIVE_INTEGER.test(value) || !validPart(Number(value))) {
    throw new Error('B站分 P 必须是从 1 开始的整数。');
  }
  return Number(value);
}

/** Parse complete official video URLs without resolving or fetching links. */
export function parseVideoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('请先粘贴一个视频链接。');
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('这个链接无法识别，请粘贴包含 https:// 的完整视频地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('请使用 YouTube 或 B站的完整官方视频链接。');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'b23.tv' || host === 'www.b23.tv') {
    throw new Error('这是B站短链接。请先打开它，再复制完整视频地址。');
  }

  let youtubeId;
  if (host === 'youtu.be') {
    youtubeId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (/^\/watch\/?$/.test(url.pathname)) youtubeId = oneParameter(url, 'v');
    else youtubeId = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (YOUTUBE_EMBED_HOSTS.has(host)) {
    youtubeId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (host === 'youtu.be' || YOUTUBE_HOSTS.has(host) || YOUTUBE_EMBED_HOSTS.has(host)) {
    if (!youtubeId || !YOUTUBE_ID.test(youtubeId)) throw new Error('未找到有效的 YouTube 视频编号，请复制具体视频的链接。');
    return {
      platform: 'youtube', id: youtubeId, part: 1,
      canonicalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    };
  }

  if (BILIBILI_HOSTS.has(host)) {
    const id = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9][0-9]*)\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new Error('未找到有效的B站 BV 或 av 编号，请复制具体视频的链接。');
    const part = parsePart(url);
    const canonical = new URL(`/video/${id}`, 'https://www.bilibili.com');
    if (part > 1) canonical.searchParams.set('p', String(part));
    return { platform: 'bilibili', id, part, canonicalUrl: canonical.href };
  }
  throw new Error('目前只支持 YouTube 和 B站的官方视频链接。');
}

function validOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('网页来源地址无效，请通过网站地址打开此页面。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('网页来源地址无效，请通过网站地址打开此页面。');
  }
  return url.origin;
}

/** Build official embeds; sharing parameters can never enable autoplay. */
export function buildEmbedUrl(video, origin) {
  if (!video || typeof video.id !== 'string' || !validPart(video.part)) {
    throw new Error('视频资料无效，请重新粘贴链接。');
  }
  if (video.platform === 'youtube' && YOUTUBE_ID.test(video.id)) {
    const url = new URL(`/embed/${video.id}`, 'https://www.youtube.com');
    url.search = new URLSearchParams({
      autoplay: '0', playsinline: '1', controls: '1', fs: '1',
      enablejsapi: '1', origin: validOrigin(origin),
    }).toString();
    return url.href;
  }
  if (video.platform === 'bilibili' && (BILIBILI_BV.test(video.id) || BILIBILI_AV.test(video.id))) {
    const url = new URL('https://player.bilibili.com/player.html');
    url.searchParams.set(video.id.startsWith('BV') ? 'bvid' : 'aid', video.id.startsWith('BV') ? video.id : video.id.slice(2));
    url.searchParams.set('p', String(video.part));
    url.searchParams.set('autoplay', '0');
    url.searchParams.set('muted', '0');
    url.searchParams.set('danmaku', '0');
    return url.href;
  }
  throw new Error('视频资料无效，请重新粘贴链接。');
}

/**
 * Entire visualViewport dimensions in CSS px. The UI reserves a 40px heading,
 * 24px Deck label per row, 8px gaps, and at least 100px for controls.
 * A minimum 200×200 iframe can letterbox 16:9 video; small screens never hide it.
 */
export function computeLayout(width, height) {
  const validViewport = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  const availableWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const availableHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const columns = availableWidth >= 720 ? 2 : 1;
  const rows = 2 / columns;
  const gap = 8;
  const widthPerPlayer = (availableWidth - gap * (columns - 1)) / columns;
  const reserveHeight = 40 + 24 * rows + gap * (rows - 1) + 100;
  const heightPerPlayer = (availableHeight - reserveHeight) / rows;
  const playerWidth = Math.max(200, Math.floor(widthPerPlayer));
  const playerHeight = Math.max(200, Math.floor(Math.min(playerWidth * 9 / 16, heightPerPlayer)));
  const spaceEnough = validViewport && widthPerPlayer >= 200 && heightPerPlayer >= 200;
  return { columns, playerWidth, playerHeight, spaceEnough };
}
