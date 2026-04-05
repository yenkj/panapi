# panapi
一个基于盘搜搭配omni获取网盘直链的docker服务，服务于Forward插件

pansearch.js即Forward插件，填入部署地址后使用。
```
version: '3.8'

services: 
  panapi: 
    image: ghcr.io/yenkj/panapi:latest 
    container_name: panapi 
    ports: 
      - "7024:3000" 
    environment:
      - PANSOU_HOST=xxx.xx.xxx
      - OMNI_HOST=xxx.xx.xxx
    volumes: 
      - ./logs:/app/logs
    restart: unless-stopped
    deploy: 
      resources: 
        limits: 
          memory: 1G
        reservations:
          memory: 512M
```
