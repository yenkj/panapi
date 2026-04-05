const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PANSOU_HOST = process.env.PANSOU_HOST;
const PANSOU_API = `${PANSOU_HOST}/api/search`;
const OMNI_HOST = process.env.OMNI_HOST;
const DRIVE_PLAY_API = `${OMNI_HOST}/drive-play`;
const DRIVE_PROXY_API = `${OMNI_HOST}/api/drive/proxy-play`;
const DRIVE_TVBOX_API = `${OMNI_HOST}/api/tvbox/drive/quark`;

if (!PANSOU_HOST || !OMNI_HOST) {
  console.error('错误: 请配置以下环境变量: PANSOU_HOST, OMNI_HOST');
  process.exit(1);
}

function getBaseUrl(req) {
  const host = req.get('host') || 'localhost:7024';
  return `http://${host}`;
}

const logsDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const cacheFile = path.join(logsDir, 'cache.json');
const invalidLinksFile = path.join(logsDir, 'invalid-links.json');

let cache = {};
let invalidLinks = {};

try {
  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
} catch (error) {
  console.error('加载缓存失败:', error.message);
}

try {
  if (fs.existsSync(invalidLinksFile)) {
    invalidLinks = JSON.parse(fs.readFileSync(invalidLinksFile, 'utf8'));
  }
} catch (error) {
  console.error('加载失效链接失败:', error.message);
}

function saveCache() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.error('保存缓存失败:', error.message);
  }
}

function saveInvalidLinks() {
  try {
    fs.writeFileSync(invalidLinksFile, JSON.stringify(invalidLinks, null, 2));
  } catch (error) {
    console.error('保存失效链接失败:', error.message);
  }
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  console.log(message);
  
  const logFile = path.join(logsDir, 'app.log');
  fs.appendFileSync(logFile, logMessage);
  
  try {
    const stats = fs.statSync(logFile);
    if (stats.size > 10 * 1024 * 1024) {
      const backupFile = path.join(logsDir, `app-${Date.now()}.log`);
      fs.renameSync(logFile, backupFile);
    }
  } catch (error) {
    console.error('日志文件检查失败:', error.message);
  }
}

const CHINESE_NUM_MAP = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
};

function extractEpisodeNumber(filename) {
  if (!filename) return null;
  
  const name = filename.toLowerCase();
  
  const patterns = [
    /s\d+e(\d+)/i,
    /ep(\d+)/i,
    /第([一二三四五六七八九十\d]+)集/,
    /^(\d+)[\s\-_]/,
    /^(\d+)\./,
    /(\d+)\.(mp4|mkv|avi|wmv|flv|mov|m4v)$/,
    /ep(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
      const numStr = match[1];
      const num = CHINESE_NUM_MAP[numStr] || parseInt(numStr);
      if (!isNaN(num) && num > 0) {
        return num;
      }
    }
  }
  
  return null;
}

function extractEpisodeNumberDetail(filename) {
  if (!filename) return null;
  
  const name = filename.toLowerCase();
  
  const patterns = [
    /s\d+e(\d+)/i,
    /ep(\d+)/i,
    /第([一二三四五六七八九十\d]+)集/,
    /^\[.*?\]\s*(\d+)[\s\-_]/,
    /^(\d+)[\s\-_]/,
    /^(\d+)\./,
    /(\d+)\s+(4k|1080p|2160p|720p)/i,
    /(\d+)(?![^.]*([24]k|720p|1080p|2160p))\.(mp4|mkv|avi|wmv|flv|mov|m4v)$/i,
    /ep(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
      const numStr = match[1];
      const num = CHINESE_NUM_MAP[numStr] || parseInt(numStr);
      if (!isNaN(num) && num > 0) {
        return num;
      }
    }
  }
  
  return null;
}

app.use(cors());
app.use(express.json());

let browser = null;

async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
  }
  return browser;
}

app.get('/play/:quarkUrl/:index', async (req, res) => {
  let page = null;
  try {
    const { quarkUrl, index } = req.params;
    const decodedUrl = decodeURIComponent(quarkUrl);
    
    log(`收到播放请求: ${decodedUrl.substring(0, 50)}... 索引: ${index}`);
    
    const directLinks = await getDirectLink(decodedUrl);
    
    if (directLinks.length > 0 && directLinks[index]) {
      const directLink = directLinks[index].url;
      log(`重定向到直链: ${directLink.substring(0, 80)}...`);
      return res.redirect(directLink);
    } else {
      log('未找到对应的直链');
      return res.status(404).json({
        error: '未找到对应的直链'
      });
    }
  } catch (error) {
    log(`播放请求处理失败: ${error.message}`);
    return res.status(500).json({
      error: error.message
    });
  } finally {
    if (page) {
      await page.close();
    }
  }
});

app.get('/api.php/provide/vod', async (req, res) => {
  try {
    const { ac, wd, ids } = req.query;
    
    if (ac === 'search') {
      if (!wd) {
        return res.json({
          code: 0,
          msg: '缺少搜索关键词',
          list: []
        });
      }
      
      const cacheKey = `search:${wd}`;
      const cachedResult = cache[cacheKey];
      
      if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
        log(`使用搜索缓存: ${wd}`);
        return res.json(cachedResult.data);
      }
      
      const searchResponse = await fetch(PANSOU_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kw: wd,
          res: 'merge',
          limit: 10
        })
      });
      
      const searchData = await searchResponse.json();
      const vodList = [];
      
      if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
        const allItems = searchData.data.merged_by_type.quark;
        const maxValidItems = 5;
        
        log(`搜索到 ${allItems.length} 个结果，开始验证...`);
        
        const validItems = [];
        
        for (let i = 0; i < allItems.length && validItems.length < maxValidItems; i++) {
          const item = allItems[i];
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          if (invalidLinks[cleanUrl]) {
            log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
            continue;
          }
          
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
            log(`验证第 ${i + 1}/${allItems.length} 个链接: ${cleanUrl.substring(0, 40)}...`);
            
            const detailResponse = await fetch(detailUrl, { signal: controller.signal });
            clearTimeout(timeout);
            
            log(`收到响应，状态: ${detailResponse.status}`);
            
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                if (videos.length > 0) {
                  validItems.push(item);
                  log(`有效: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
                } else {
                  invalidLinks[cleanUrl] = Date.now();
                  saveInvalidLinks();
                  log(`失效: ${cleanUrl.substring(0, 40)}... (无视频)`);
                }
              } else {
                invalidLinks[cleanUrl] = Date.now();
                saveInvalidLinks();
                log(`失效: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
              }
            } else {
              invalidLinks[cleanUrl] = Date.now();
              saveInvalidLinks();
              log(`失效: ${cleanUrl.substring(0, 40)}... (未找到详情)`);
            }
          } catch (error) {
            invalidLinks[cleanUrl] = Date.now();
            saveInvalidLinks();
            log(`失效: ${cleanUrl.substring(0, 40)}... (${error.message})`);
          }
        }
        
        log(`验证完成，找到 ${validItems.length} 个有效网盘`);
        
        const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
        const firstUrl = allUrls.length > 0 ? allUrls[0] : '';
        
        let isMovie = true;
        
        if (firstUrl) {
          try {
            const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(firstUrl)}`;
            const detailResponse = await fetch(detailUrl);
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                for (const video of videos) {
                  const [name] = video.split('$');
                  const episodeNum = extractEpisodeNumberDetail(name);
                  if (episodeNum !== null) {
                    isMovie = false;
                    break;
                  }
                }
              }
            }
          } catch (error) {
            log(`识别类型失败: ${error.message}`);
          }
        }
        
        log(`识别为${isMovie ? '电影' : '剧集'}`);
        
        const quarkPlayUrls = [];
        
        log(`开始获取 ${validItems.length} 个网盘的详情`);
        
        for (let i = 0; i < validItems.length; i++) {
          const item = validItems[i];
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          log(`处理第 ${i + 1}/${validItems.length} 个网盘: ${cleanUrl.substring(0, 40)}...`);
          
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
            log(`请求详情: ${detailUrl.substring(0, 60)}...`);
            
            const detailResponse = await fetch(detailUrl, { signal: controller.signal });
            clearTimeout(timeout);
            
            log(`收到响应，状态: ${detailResponse.status}`);
            
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              log(`获取到播放地址，长度: ${playUrl.length}`);
              quarkPlayUrls.push({
                quarkUrl: cleanUrl,
                playUrl: playUrl
              });
            } else {
              log(`未找到详情数据`);
            }
          } catch (error) {
            log(`获取详情失败: ${error.message}`);
            quarkPlayUrls.push({
              quarkUrl: cleanUrl,
              playUrl: ''
            });
          }
        }
        
        log(`网盘详情获取完成，共 ${quarkPlayUrls.length} 个有效网盘`);
        
        cache[`${cacheKey}:all`] = {
          timestamp: Date.now(),
          data: allUrls,
          isMovie: isMovie,
          quarkPlayUrls: quarkPlayUrls
        };
        
        log(`保存缓存: ${cacheKey}:all, isMovie: ${isMovie}`);
        saveCache();
        
        for (let i = 0; i < validItems.length; i++) {
          const item = validItems[i];
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          const baseItem = {
            vod_id: cleanUrl,
            vod_name: (item.note || wd).trim(),
            vod_pic: (item.images?.[0] || '').trim().replace(/^`|`$/g, ''),
            vod_remarks: item.datetime || '',
            vod_play_from: 'quark',
            vod_password: (item.password || '').trim()
          };
          
          try {
            const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
            const detailResponse = await fetch(detailUrl);
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                const videoCount = videos.length;
                
                const baseUrl = getBaseUrl(req);
                const fakePlayUrls = videos.map((v, idx) => {
                  const parts = v.split('$');
                  const name = parts[0] || `视频${idx + 1}`;
                  return `${name}$${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
                }).join('#');
                
                const resultItem = {
                  ...baseItem,
                  vod_play_url: fakePlayUrls,
                  vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
                };
                vodList.push(resultItem);
              }
            }
          } catch (error) {
          }
        }
        
        const baseUrl = getBaseUrl(req);
        const allItem = {
          vod_id: `all:${wd}`,
          vod_name: `${wd}`,
          vod_pic: '',
          vod_remarks: `共${validItems.length}个网盘`,
          vod_play_from: 'quark',
          vod_password: '',
          vod_play_url: `${wd}.1080p.mp4$${baseUrl}/api.php/provide/vod?ac=detail&ids=all:${wd}`
        };
        
        vodList.unshift(allItem);
      }
      
      const result = {
        code: 1,
        msg: '数据列表',
        page: 1,
        pagecount: 1,
        limit: 10,
        total: vodList.length,
        list: vodList
      };
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: result
      };
      saveCache();
      
      return res.json(result);
      
    } else if (ac === 'detail') {
      if (!ids) {
        return res.json({
          code: 0,
          msg: '缺少ID',
          list: []
        });
      }
      
      if (ids.startsWith('all:')) {
        const searchKeyword = ids.substring(4);
        const cacheKey = `search:${searchKeyword}`;
        const cachedResult = cache[`${cacheKey}:all`];
        
        log(`读取缓存: ${cacheKey}:all, isMovie: ${cachedResult?.isMovie}`);
        
        if (!cachedResult) {
          return res.json({
            code: 0,
            msg: '未找到搜索结果',
            list: []
          });
        }
        
        const allUrls = cachedResult.data;
        const isMovie = cachedResult.isMovie !== undefined ? cachedResult.isMovie : true;
        const quarkPlayUrls = cachedResult.quarkPlayUrls || [];
        
        log(`获取所有网盘直链，共 ${allUrls.length} 个网盘，类型: ${isMovie ? '电影' : '剧集'}`);
        log(`quarkPlayUrls 数量: ${quarkPlayUrls.length}`);
        
        let sortedEpisodes;
        const allMovieLinks = [];
        
        if (isMovie) {
          log(`进入电影分支`);
          
          for (let i = 0; i < allUrls.length; i++) {
            const cleanUrl = allUrls[i];
            log(`获取第 ${i + 1}/${allUrls.length} 个网盘直链: ${cleanUrl.substring(0, 40)}...`);
            
            try {
              const directLinks = await getDirectLink(cleanUrl);
              allMovieLinks.push(...directLinks);
            } catch (error) {
              log(`获取网盘直链失败: ${error.message}`);
            }
          }
          
          sortedEpisodes = allMovieLinks.slice(0, 10).map(item => `${item.name}$${item.url}`).join('#');
        } else {
          log(`进入剧集分支`);
          let episodeMap = new Map();
          
          log(`开始遍历 quarkPlayUrls`);
          for (const quarkPlay of quarkPlayUrls) {
            const { quarkUrl, playUrl } = quarkPlay;
            
            log(`处理网盘: ${quarkUrl.substring(0, 40)}..., playUrl 长度: ${playUrl ? playUrl.length : 0}`);
            
            if (!playUrl) {
              log(`跳过空 playUrl`);
              continue;
            }
            
            const videos = playUrl.split('#').filter(v => v.trim());
            log(`找到 ${videos.length} 个视频`);
            
            // 为每个视频创建独立条目，同一集的后续版本自动添加编号
            for (const video of videos) {
              const [name] = video.split('$');
              const episodeNum = extractEpisodeNumberDetail(name);
              
              if (episodeNum !== null) {
                // 只统计当前网盘下的该集数条目
                const existingEntries = Array.from(episodeMap.entries())
                  .filter(([key, data]) => data.quarkUrl === quarkUrl && data.episodeNum === episodeNum);
                
                const version = existingEntries.length + 1;
                const key = `${quarkUrl}:${name}`;
                if (!episodeMap.has(key)) {
                  episodeMap.set(key, {
                    firstEpisodeUrl: null,
                    quarkUrl: quarkUrl,
                    episodeNum: episodeNum,
                    version: version
                  });
                  log(`添加集数: ${episodeNum} 版本${version} (网盘: ${quarkUrl.substring(0, 40)}...)`);
                }
              }
            }
          }
          
          log(`episodeMap 大小: ${episodeMap.size}`);
          
          // 不再获取任何直链，全部使用构造的播放地址
          log(`跳过所有直链获取，全部使用构造的播放地址`);
          
          log(`开始构建播放地址`);
          const baseUrl = getBaseUrl(req);
          // 为每个网盘构建独立的播放地址
          const uniqueQuarkUrls = new Set();
          episodeMap.forEach(data => uniqueQuarkUrls.add(data.quarkUrl));
          
          const allPlayUrls = [];
          
          for (const quarkUrl of uniqueQuarkUrls) {
            const episodesForQuark = Array.from(episodeMap.entries())
              .filter(([_, data]) => data.quarkUrl === quarkUrl)
              .sort((a, b) => a[1].episodeNum - b[1].episodeNum)
              .map(([_, data]) => {
                  const paddedNum = data.episodeNum.toString().padStart(2, '0');
                  // 保留原始集名，不修改
                if (data.version === 1) {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}`;
                } else {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}&version=${data.version}`;
                }
                });
            
            allPlayUrls.push(episodesForQuark.join('#'));
          }
          
          sortedEpisodes = allPlayUrls.join('$$$');
          log(`构建播放地址完成，共 ${uniqueQuarkUrls.size} 个网盘，${episodeMap.size} 个集数`);
          log(`共获取 ${uniqueQuarkUrls.size} 个网盘资源`);
        }
        
        if (isMovie) {
          log(`共获取 ${allMovieLinks?.length || 0} 个电影资源`);
        }
        
        return res.json({
          code: 1,
          msg: '数据详情',
          list: [{
            vod_id: ids,
            vod_play_from: 'quark',
            vod_play_url: sortedEpisodes
          }]
        });
      }
      
      let quarkUrl = ids;
      
      if (ids.includes('/play/')) {
        quarkUrl = ids.split('/play/')[1].split('/')[0];
        quarkUrl = decodeURIComponent(quarkUrl);
      }
      
      const directLinks = await getDirectLink(quarkUrl, false);
      
      const episodeMap = new Map();
      let hasVideoCodec = false;
      
      directLinks.forEach(item => {
        const name = item.name.toLowerCase();
        if (name.includes('264') || name.includes('265') || name.includes('hevc') || name.includes('avc')) {
          hasVideoCodec = true;
        }
        const episodeNum = extractEpisodeNumberDetail(item.name);
        if (episodeNum !== null) {
          if (!episodeMap.has(episodeNum)) {
            episodeMap.set(episodeNum, item.url);
          }
        }
      });
      
      let playUrls;
      
      if (hasVideoCodec || episodeMap.size <= 1) {
        playUrls = directLinks.map(item => `${item.name}$${item.url}`).join('#');
      } else {
        playUrls = Array.from(episodeMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([episodeNum, url]) => {
            const paddedNum = episodeNum.toString().padStart(2, '0');
            return `第${paddedNum}集$${url}`;
          })
          .join('#');
      }
      
      return res.json({
        code: 1,
        msg: '数据详情',
        list: [{
          vod_id: ids,
          vod_play_from: 'quark',
          vod_play_url: playUrls
        }]
      });
    }
    
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: '缺少ac参数',
        list: []
      });
    }
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.get('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.query;
    
    if (!quarkUrl || !episode) {
      return res.status(400).send('缺少参数');
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const directLinks = await getDirectLink(quarkUrl, false);
    const targetEpisodeNum = parseInt(episode);
    const targetVersion = parseInt(version);
    
    // 找到所有匹配的集数（包括同一集的多个版本）
    const targetEpisodes = directLinks.filter(item => {
      const epNum = extractEpisodeNumberDetail(item.name);
      return epNum === targetEpisodeNum;
    });
    
    if (targetEpisodes.length > 0) {
      // 根据版本号选择对应的集数
      const targetEpisode = targetEpisodes[targetVersion - 1] || targetEpisodes[0];
      log(`找到对应集数: ${targetEpisode.name}`);
      return res.redirect(targetEpisode.url);
    } else {
      log(`未找到对应集数: ${episode}`);
      return res.status(404).send('未找到对应集数');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.status(500).send(error.message);
    }
  }
});

app.post('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.body;
    
    if (!quarkUrl || !episode) {
      return res.json({
        code: 0,
        msg: '缺少参数',
        url: ''
      });
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const directLinks = await getDirectLink(quarkUrl, false);
    const targetEpisodeNum = parseInt(episode);
    const targetVersion = parseInt(version);
    
    // 找到所有匹配的集数（包括同一集的多个版本）
    const targetEpisodes = directLinks.filter(item => {
      const epNum = extractEpisodeNumberDetail(item.name);
      return epNum === targetEpisodeNum;
    });
    
    if (targetEpisodes.length > 0) {
      // 根据版本号选择对应的集数
      const targetEpisode = targetEpisodes[targetVersion - 1] || targetEpisodes[0];
      log(`找到对应集数: ${targetEpisode.name}`);
      return res.json({
        code: 1,
        msg: '播放地址',
        url: targetEpisode.url
      });
    } else {
      log(`未找到对应集数: ${episode}`);
      return res.json({
        code: 0,
        msg: '未找到对应集数',
        url: ''
      });
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        url: ''
      });
    }
  }
});

app.post('/vod/search', async (req, res) => {
  const vodList = [];
  
  try {
    const { wd } = req.body;
    
    if (!wd) {
      return res.json({
        code: 0,
        msg: '缺少搜索关键词',
        list: []
      });
    }
    
    const cacheKey = `search:${wd}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用搜索缓存: ${wd}`);
      return res.json(cachedResult.data);
    }
    
    const searchResponse = await fetch(PANSOU_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kw: wd,
        res: 'merge',
        limit: 10
      })
    });
    
    const searchData = await searchResponse.json();
    
    if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
      const allItems = searchData.data.merged_by_type.quark;
      const maxValidItems = 5;
      
      log(`搜索到 ${allItems.length} 个结果，开始验证...`);
      
      const validItems = [];
      
      for (let i = 0; i < allItems.length && validItems.length < maxValidItems; i++) {
        const item = allItems[i];
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        
        if (invalidLinks[cleanUrl]) {
          log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
          continue;
        }
        
        try {
          const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
          const detailResponse = await fetch(detailUrl);
          const detailData = await detailResponse.json();
          
          if (detailData.list && detailData.list.length > 0) {
            const videoDetail = detailData.list[0];
            const playUrl = videoDetail.vod_play_url || '';
            
            if (playUrl) {
              const videos = playUrl.split('#').filter(v => v.trim());
              if (videos.length > 0) {
                validItems.push(item);
                log(`有效: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
              } else {
                invalidLinks[cleanUrl] = Date.now();
                saveInvalidLinks();
                log(`失效: ${cleanUrl.substring(0, 40)}... (无视频)`);
              }
            } else {
              invalidLinks[cleanUrl] = Date.now();
              saveInvalidLinks();
              log(`失效: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
            }
          } else {
            invalidLinks[cleanUrl] = Date.now();
            saveInvalidLinks();
            log(`失效: ${cleanUrl.substring(0, 40)}... (未找到详情)`);
          }
        } catch (error) {
          invalidLinks[cleanUrl] = Date.now();
          saveInvalidLinks();
          log(`失效: ${cleanUrl.substring(0, 40)}... (${error.message})`);
        }
      }
      
      log(`验证完成，找到 ${validItems.length} 个有效网盘`);
      
      for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        
        const baseItem = {
          vod_id: cleanUrl,
          vod_name: (item.note || wd).trim(),
          vod_pic: (item.images?.[0] || '').trim().replace(/^`|`$/g, ''),
          vod_remarks: item.datetime || '',
          vod_play_from: 'quark',
          vod_password: (item.password || '').trim()
        };
        
        try {
          const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
          const detailResponse = await fetch(detailUrl);
          const detailData = await detailResponse.json();
          
          if (detailData.list && detailData.list.length > 0) {
            const videoDetail = detailData.list[0];
            const playUrl = videoDetail.vod_play_url || '';
            
            if (playUrl) {
              const videos = playUrl.split('#').filter(v => v.trim());
              const videoCount = videos.length;
              
              const baseUrl = getBaseUrl(req);
              const fakePlayUrls = videos.map((v, idx) => {
                const parts = v.split('$');
                const name = parts[0] || `视频${idx + 1}`;
                return `${name}$${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
              }).join('#');
              
              const resultItem = {
                ...baseItem,
                vod_play_url: fakePlayUrls,
                vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
              };
              vodList.push(resultItem);
            }
          }
        } catch (error) {
        }
      }
      
      const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
      const firstUrl = allUrls.length > 0 ? allUrls[0] : '';
      
      const baseUrl = getBaseUrl(req);
      const allItem = {
        vod_id: `all:${wd}`,
        vod_name: `${wd}`,
        vod_pic: '',
        vod_remarks: `共${validItems.length}个网盘`,
        vod_play_from: 'quark',
        vod_password: '',
        vod_play_url: `${wd}.1080p.mp4$${baseUrl}/api.php/provide/vod?ac=detail&ids=all:${wd}`
      };
      
      vodList.unshift(allItem);
      
      cache[`${cacheKey}:all`] = {
        timestamp: Date.now(),
        data: allUrls
      };
      saveCache();
    }
    
    const result = {
      code: 1,
      msg: '数据列表',
      page: 1,
      pagecount: 1,
      limit: 10,
      total: vodList.length,
      list: vodList
    };
    
    cache[cacheKey] = {
      timestamp: Date.now(),
      data: result
    };
    saveCache();
    
    return res.json(result);
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/detail', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        list: []
      });
    }
    
    const directLinks = await getDirectLink(id);
    
    return res.json({
      code: 1,
      msg: '数据详情',
      list: [{
        vod_id: id,
        vod_play_from: 'quark',
        vod_play_url: `播放$${directLinks}`
      }]
    });
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/play', async (req, res) => {
  try {
    const { id } = req.body;
    
    log('收到播放请求，ID:', id);
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        url: '',
        parse: 0
      });
    }
    
    log('开始获取直链...');
    const directUrl = await getDirectLink(id);
    log('获取到的直链:', directUrl);
    
    res.json({
      code: 1,
      msg: '播放地址',
      url: directUrl,
      parse: 0
    });
    
  } catch (error) {
    log('播放请求处理失败:', error);
    res.json({
      code: 0,
      msg: error.message,
      url: '',
      parse: 0
    });
  }
});

app.post('/vod/playpage', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        playPage: ''
      });
    }
    
    const quarkUrl = id.replace('quark_', '');
    const playPage = `${DRIVE_PLAY_API}?url=${encodeURIComponent(quarkUrl)}`;
    
    res.json({
      code: 1,
      msg: '播放页面',
      playPage: playPage,
      parse: 1
    });
    
  } catch (error) {
    res.json({
      code: 0,
      msg: error.message,
      playPage: ''
    });
  }
});

async function getDirectLink(id, limit = true) {
  try {
    const quarkUrl = id.startsWith('http') ? id : id.replace('quark_', '');
    
    const cacheKey = `direct:${quarkUrl}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用缓存直链: ${quarkUrl.substring(0, 40)}...`);
      return cachedResult.data;
    }
    
    log(`获取直链: ${quarkUrl.substring(0, 40)}...`);
    
    try {
      const detailUrl = `${DRIVE_TVBOX_API}?ac=detail&ids=${encodeURIComponent(quarkUrl)}`;
      
      const detailResponse = await fetch(detailUrl);
      const detailData = await detailResponse.json();
      
      if (!detailData.list || detailData.list.length === 0) {
        log(`未找到视频详情: ${quarkUrl.substring(0, 40)}...`);
        return [`${DRIVE_PLAY_API}?url=${encodeURIComponent(quarkUrl)}`];
      }
      
      const videoDetail = detailData.list[0];
      const playUrl = videoDetail.vod_play_url || '';
      
      if (!playUrl) {
        log(`未找到播放地址: ${quarkUrl.substring(0, 40)}...`);
        return [`${DRIVE_PLAY_API}?url=${encodeURIComponent(quarkUrl)}`];
      }
      
      const videos = playUrl.split('#').filter(v => v.trim());
      const maxVideos = limit ? 10 : videos.length;
      const limitedVideos = videos.slice(0, maxVideos);
      
      log(`找到 ${videos.length} 个视频，限制为前 ${limitedVideos.length} 个`);
      
      const episodeIds = limitedVideos.map(v => {
        const parts = v.split('$');
        return parts.length > 1 ? parts[1].trim() : '';
      }).filter(id => id);
      
      const videoNames = limitedVideos.map(v => {
        const parts = v.split('$');
        const name = parts[0] || '';
        return name.trim();
      });
      
      const directLinks = [];
      
      for (let i = 0; i < episodeIds.length; i++) {
        const episodeId = episodeIds[i];
        const playApiUrl = `${DRIVE_TVBOX_API}?play=${encodeURIComponent(episodeId)}&flag=${encodeURIComponent(quarkUrl)}`;
        
        let maxRetries = 3;
        let retryDelay = 3000;
        let success = false;
        
        for (let retry = 0; retry < maxRetries && !success; retry++) {
          try {
            const playResponse = await fetch(playApiUrl);
            const playData = await playResponse.json();
            
            if (playData.url) {
              directLinks.push({
                url: playData.url,
                name: videoNames[i]
              });
              success = true;
            } else {
              if (retry < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay *= 2;
              }
            }
          } catch (error) {
            if (retry < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              retryDelay *= 2;
            }
          }
        }
      }
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: directLinks.length > 0 ? directLinks : []
      };
      saveCache();
      
      log(`成功获取 ${directLinks.length} 个直链`);
      
      return directLinks.length > 0 ? directLinks : [];
      
    } catch (error) {
      log(`获取直链失败: ${error.message}`);
      return [];
    }
    
  } catch (error) {
    log(`获取直链异常: ${error.message}`);
    return [];
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: browser ? 'running' : 'not running' });
});

app.get('/test', async (req, res) => {
  try {
    const testUrl = 'https://pan.quark.cn/s/9ba485a7828a';
    const directLink = await getDirectLink('quark_0');
    
    res.json({
      testUrl: testUrl,
      directLink: directLink,
      success: directLink !== testUrl
    });
  } catch (error) {
    res.json({
      error: error.message,
      success: false
    });
  }
});

app.get('/analyze', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.json({
        error: '缺少 url 参数',
        usage: '/analyze?url=https://pan.quark.cn/s/xxxxx'
      });
    }
    
    log('开始分析播放页面:', url);
    
    const browser = await initBrowser();
    const page = await browser.newPage();
    
    const playPage = `${DRIVE_PLAY_API}?url=${encodeURIComponent(url)}`;
    
    log('加载播放页面:', playPage);
    await page.goto(playPage, { waitUntil: 'networkidle2', timeout: 60000 });
    
    log('等待页面加载完成...');
    await page.waitForTimeout(5000);
    
    const analysis = await page.evaluate(() => {
      const result = {
        buttons: [],
        nextButtons: [],
        lists: [],
        videoItems: [],
        scripts: []
      };
      
      const allButtons = Array.from(document.querySelectorAll('button'));
      result.buttons = allButtons
        .filter(btn => btn.offsetParent !== null)
        .map(btn => ({
          text: btn.textContent.trim().substring(0, 50),
          className: btn.className,
          id: btn.id
        }));
      
      result.nextButtons = allButtons
        .filter(btn => btn.offsetParent !== null && 
          (btn.textContent.includes('下一') || btn.textContent.includes('Next')))
        .map(btn => ({
          text: btn.textContent.trim(),
          className: btn.className,
          id: btn.id
        }));
      
      const listSelectors = ['ul', 'ol', '[class*="list"]', '[class*="playlist"]', '[class*="video"]'];
      listSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const items = el.children.length;
          if (items > 0 && items < 100) {
            result.lists.push({
              selector: selector,
              tag: el.tagName,
              className: el.className,
              itemCount: items,
              sampleItems: Array.from(el.children).slice(0, 3).map(item => ({
                text: item.textContent.trim().substring(0, 50),
                className: item.className
              }))
            });
          }
        });
      });
      
      const videoSelectors = ['[class*="video"]', '[class*="item"]', '[class*="file"]', 'li'];
      videoSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        const visibleElements = Array.from(elements).filter(el => el.offsetParent !== null);
        if (visibleElements.length > 0 && visibleElements.length < 50) {
          result.videoItems.push({
            selector: selector,
            count: visibleElements.length,
            items: visibleElements.slice(0, 5).map(el => ({
              text: el.textContent.trim().substring(0, 50),
              className: el.className
            }))
          });
        }
      });
      
      const scripts = Array.from(document.querySelectorAll('script'));
      scripts.forEach(script => {
        const content = script.textContent || script.innerHTML;
        const matches = content.matchAll(/https?:\/\/[^'"\s]+\/api\/drive\/proxy-play[^'"\s]*/g);
        const urls = Array.from(matches).map(m => m[0]);
        if (urls.length > 0) {
          result.scripts.push({
            count: urls.length,
            urls: urls.slice(0, 5)
          });
        }
      });
      
      return result;
    });
    
    await page.close();
    
    log('分析完成');
    
    res.json({
      success: true,
      url: url,
      playPage: playPage,
      analysis: analysis
    });
    
  } catch (error) {
    log('分析失败:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`VOD API Server running on port ${PORT}`);
});