/**
 * 天气：中国天气网的实时观测（无需 Key），城市用 IP 反查。
 *
 * 为什么不用 open-meteo：服务器在国内，连 api.open-meteo.com 的 TLS 握手直接卡死，
 * 前端直连在国内手机上也大概率转圈。所以老老实实用国内接口。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const WEATHER_TTL = 10 * 60 * 1000;
const LOCATE_TTL = 6 * 60 * 60 * 1000;

/* 中国天气网的城市编码，全部实测过能返回对应城市 */
const CITY_CODES = {
  北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100',
  哈尔滨: '101050101', 齐齐哈尔: '101050201', 长春: '101060101', 吉林: '101060201',
  沈阳: '101070101', 大连: '101070201', 鞍山: '101070301',
  呼和浩特: '101080101', 包头: '101080201',
  石家庄: '101090101', 保定: '101090201', 唐山: '101090501', 廊坊: '101090601',
  太原: '101100101', 大同: '101100201',
  西安: '101110101', 宝鸡: '101110901',
  济南: '101120101', 青岛: '101120201', 淄博: '101120301', 烟台: '101120501',
  潍坊: '101120601', 临沂: '101120901', 东营: '101121201',
  乌鲁木齐: '101130101', 阿克苏: '101130801',
  拉萨: '101140101', 西宁: '101150101', 兰州: '101160101', 天水: '101160901',
  银川: '101170101', 郑州: '101180101', 洛阳: '101180901', 新乡: '101180301',
  南京: '101190101', 无锡: '101190201', 苏州: '101190401', 南通: '101190501',
  扬州: '101190601', 徐州: '101190801', 常州: '101191101',
  武汉: '101200101', 襄阳: '101200201', 宜昌: '101200901',
  杭州: '101210101', 嘉兴: '101210301', 宁波: '101210401', 绍兴: '101210501',
  温州: '101210701', 金华: '101210901',
  合肥: '101220101', 芜湖: '101220301',
  福州: '101230101', 厦门: '101230201', 泉州: '101230501', 漳州: '101230601',
  南昌: '101240101', 九江: '101240201', 赣州: '101240701',
  长沙: '101250101', 湘潭: '101250201', 衡阳: '101250401',
  贵阳: '101260101', 成都: '101270101',
  广州: '101280101', 深圳: '101280601', 珠海: '101280701', 佛山: '101280800',
  惠州: '101280301', 汕头: '101280501', 江门: '101281101', 东莞: '101281601',
  中山: '101281701', 昆明: '101290101', 大理: '101290201',
  南宁: '101300101', 桂林: '101300501',
  海口: '101310101', 三亚: '101310201',
  香港: '101320101', 澳门: '101330101', 台北: '101340101',
};

/* IP 定位只精确到省时，用省会顶上，气候差不了多少 */
const PROVINCE_CAPITAL = {
  北京: '北京', 天津: '天津', 上海: '上海', 重庆: '重庆',
  河北: '石家庄', 山西: '太原', 内蒙古: '呼和浩特', 辽宁: '沈阳', 吉林: '长春',
  黑龙江: '哈尔滨', 江苏: '南京', 浙江: '杭州', 安徽: '合肥', 福建: '福州',
  江西: '南昌', 山东: '济南', 河南: '郑州', 湖北: '武汉', 湖南: '长沙',
  广东: '广州', 广西: '南宁', 海南: '海口', 四川: '成都', 贵州: '贵阳',
  云南: '昆明', 西藏: '拉萨', 陕西: '西安', 甘肃: '兰州', 青海: '西宁',
  宁夏: '银川', 新疆: '乌鲁木齐', 香港: '香港', 澳门: '澳门', 台湾: '台北',
};

const weatherCache = new Map();
const locateCache = new Map();

function trimMap(map, max) {
  if (map.size <= max) return;
  const keys = [...map.keys()].slice(0, map.size - max);
  for (const k of keys) map.delete(k);
}

/** 「济南市」→「济南」，「延边朝鲜族自治州」→「延边朝鲜族」 */
function normalizeName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|盟|市|县|区)$/u, '')
    .trim();
}

function isPrivateIp(ip) {
  const s = String(ip || '');
  return !s || s === '::1' || s.startsWith('127.') || s.startsWith('10.')
    || s.startsWith('192.168.') || s.startsWith('172.16.') || s.startsWith('172.17.')
    || s.startsWith('::ffff:127.') || s.startsWith('100.64.');
}

async function fetchTimeout(url, options = {}, ms = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** IP → 城市名。免费版只支持 http，且限量 45 次/分钟，所以缓存 6 小时 */
async function locateByIp(ip) {
  if (isPrivateIp(ip)) return null;
  const key = String(ip);
  const hit = locateCache.get(key);
  if (hit && Date.now() - hit.at < LOCATE_TTL) return hit.value;

  try {
    const res = await fetchTimeout(
      `http://ip-api.com/json/${encodeURIComponent(key)}?lang=zh-CN&fields=status,country,regionName,city`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.status !== 'success' || data.country !== '中国') return null;
    const value = { city: normalizeName(data.city), region: normalizeName(data.regionName) };
    locateCache.set(key, { at: Date.now(), value });
    trimMap(locateCache, 500);
    return value;
  } catch {
    return null;
  }
}

function codeFor({ city, region }) {
  const name = normalizeName(city);
  if (name && CITY_CODES[name]) return CITY_CODES[name];

  /* 名称不完全一致时退一步做包含匹配，比如「延边」对「延边朝鲜族」 */
  if (name) {
    for (const [k, v] of Object.entries(CITY_CODES)) {
      if (k.length >= 2 && (name.includes(k) || k.includes(name))) return v;
    }
  }

  const capital = PROVINCE_CAPITAL[normalizeName(region)];
  return capital ? CITY_CODES[capital] : null;
}

async function fetchByCode(code) {
  const hit = weatherCache.get(code);
  if (hit && Date.now() - hit.at < WEATHER_TTL) return hit.value;

  const res = await fetchTimeout(`http://d1.weather.com.cn/sk_2d/${code}.html`, {
    headers: { 'User-Agent': UA, Referer: 'http://www.weather.com.cn/' },
  }, 7000);
  if (!res.ok) throw new Error('天气服务返回异常');

  const text = await res.text();
  const matched = text.match(/\{[\s\S]*\}/);
  if (!matched) throw new Error('天气数据解析失败');

  const raw = JSON.parse(matched[0]);
  const temp = Number(raw.temp);
  if (!Number.isFinite(temp)) throw new Error('天气数据里没有温度');

  const value = {
    city: raw.cityname || '',
    temp: Math.round(temp),
    text: raw.weather || '',
    wind: `${raw.WD || ''} ${raw.WS || ''}`.trim(),
    humidity: raw.SD || '',
    aqi: raw.aqi ? Number(raw.aqi) : null,
    observedAt: raw.time || '',
  };
  weatherCache.set(code, { at: Date.now(), value });
  trimMap(weatherCache, 200);
  return value;
}

/**
 * @returns {Promise<{ok:true, city, temp, text, wind, humidity, aqi, observedAt, guessed:boolean} | {ok:false, reason:'need-city'}>}
 */
export async function getWeather({ ip, city } = {}) {
  let place = city ? { city: normalizeName(city), region: '' } : null;
  let guessed = false;

  if (!place) {
    place = await locateByIp(ip);
    guessed = Boolean(place);
  }

  const code = codeFor(place || {});
  if (!code) return { ok: false, reason: 'need-city' };

  const data = await fetchByCode(code);
  return { ok: true, ...data, guessed };
}
