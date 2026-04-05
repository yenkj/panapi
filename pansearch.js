const DOCKER_API = 'xxx.xx.xxx:7024';

const CHINESE_NUM_MAP = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
};

WidgetMetadata = {
  id: "vod_search",
  title: "盘 搜",
  icon: "https://assets.vvebo.vip/scripts/icon.png",
  version: "1.0.0",
  requiredVersion: "0.0.1",
  description: "搜索夸克网盘视频资源并获取直链",
  author: "Banana",
  globalParams: [
    {
      name: "multiSource",
      title: "是否启用聚合搜索",
      type: "enumeration",
      enumOptions: [
        { title: "启用", value: "enabled" },
        { title: "禁用", value: "disabled" }
      ]
    },
    {
      name: "apiUrl",
      title: "Docker API 地址",
      type: "input",
      value: "xxx.xx.xxx:7024"
    }
  ],
  modules: [
    {
      id: "loadResource",
      title: "加载资源",
      functionName: "loadResource",
      type: "stream",
      params: []
    }
  ],
};

function extractSeasonInfo(seriesName) {
  if (!seriesName) return { baseName: seriesName, seasonNumber: 1 };
  const chineseMatch = seriesName.match(/第([一二三四五六七八九十\d]+)[季部]/);
  if (chineseMatch) {
    const val = chineseMatch[1];
    const seasonNum = CHINESE_NUM_MAP[val] || parseInt(val) || 1;
    const baseName = seriesName.replace(/第[一二三四五六七八九十\d]+[季部]/, '').trim();
    return { baseName, seasonNumber: seasonNum };
  }
  const digitMatch = seriesName.match(/(.+?)(\d+)$/);
  if (digitMatch) {
    return { baseName: digitMatch[1].trim(), seasonNumber: parseInt(digitMatch[2]) || 1 };
  }
  return { baseName: seriesName.trim(), seasonNumber: 1 };
}

async function loadResource(params) {
  const { seriesName, type = 'tv', season, episode, multiSource, apiUrl = DOCKER_API } = params;
  
  if (multiSource !== "enabled" || !seriesName) {
    return [];
  }

  const { baseName, seasonNumber } = extractSeasonInfo(seriesName);
  const targetSeason = season ? parseInt(season) : seasonNumber;
  const targetEpisode = episode ? parseInt(episode) : null;

  try {
    const searchUrl = `${apiUrl}/api.php/provide/vod`;
    const searchResponse = await Widget.http.get(searchUrl, {
      params: { 
        ac: "search", 
        wd: baseName.trim() 
      },
      timeout: 30000
    });

    const searchList = searchResponse?.data?.list;
    if (!Array.isArray(searchList)) return [];

    const matchedItems = searchList.filter(item => {
      const itemInfo = extractSeasonInfo(item.vod_name);
      return itemInfo.baseName === baseName && itemInfo.seasonNumber === targetSeason;
    });

    if (matchedItems.length === 0) return [];

    const detailUrl = `${apiUrl}/api.php/provide/vod`;
    const response = await Widget.http.get(detailUrl, {
      params: { 
        ac: "detail", 
        ids: `all:${baseName.trim()}` 
      },
      timeout: 30000
    });

    const list = response?.data?.list;
    if (!Array.isArray(list) || list.length === 0) return [];

    const detailItem = list[0];
    const playUrl = detailItem.vod_play_url || '';
    
    if (!playUrl) return [];

    const episodes = playUrl.split('#').filter(Boolean);
    const allResources = [];
    
    if (type === 'tv' && targetEpisode !== null) {
      episodes.forEach(ep => {
        const [epName, url] = ep.split('$');
        if (url) {
          const epMatch = epName.match(/第(\d+)集/);
          const epNum = epMatch ? parseInt(epMatch[1]) : null;
          
          if (epNum === targetEpisode || epName.includes(`第${targetEpisode}集`)) {
            allResources.push({
              name: '夸克网盘',
              description: `${baseName} - ${epName}`,
              url: url.trim(),
              _ep: epNum
            });
          }
        }
      });
    } else if (type === 'movie') {
      episodes.forEach(ep => {
        const [epName, url] = ep.split('$');
        if (url) {
          allResources.push({
            name: '夸克网盘',
            description: `${baseName} - ${epName}`,
            url: url.trim()
          });
        }
      });
    } else {
      episodes.forEach(ep => {
        const [epName, url] = ep.split('$');
        if (url) {
          const epMatch = epName.match(/第(\d+)集/);
          const epNum = epMatch ? parseInt(epMatch[1]) : null;
          allResources.push({
            name: '夸克网盘',
            description: `${baseName} - ${epName}`,
            url: url.trim(),
            _ep: epNum
          });
        }
      });
    }

    return allResources;

  } catch (error) {
    console.error('夸克资源加载失败:', error);
    return [];
  }
}
