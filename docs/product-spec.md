# GameHub 游戏官方资源导航站 V1 设计与开发规格

## V1 第一阶段产品设计原则

- 深色现代游戏数据库风格
- 页面背景接近 `#080B12`
- Card 背景接近 `#121824`
- 主强调色使用克制的蓝色
- 最大内容宽度约 `1360px`
- UI 风格简洁、高级、现代
- 不做传统游戏下载站风格
- 不使用大量广告式按钮
- 不使用夸张渐变和复杂动画
- 游戏图片作为主要视觉元素
- 官方网站和官方商店入口必须明显、可信
- Desktop 和 Mobile 都必须完整适配

第一阶段仅实现前端原型与 Mock Data，不接入 Steam API、IGDB API、Cloudflare D1/R2/KV、登录、收藏、评论、后台、Cron、数据同步、价格历史、MOD、新闻或下载托管。

## 1. 项目定位

项目暂定名：

**GameHub**

第一阶段域名：

```text
games.binbho.com
```

网站定位：

> 一个帮助用户查找游戏资料、官方网站和官方下载/购买入口的游戏数据库。

核心原则：

- 不储存盗版游戏
- 不提供破解资源
- 不提供第三方未知下载地址
- 仅收录游戏资料和官方资源
- 下载入口优先跳转官方页面
- 支持 Steam、Epic、GOG、Xbox、PlayStation、Nintendo 等平台
- 后期可以扩展价格、配置检测、DLC、版本、新闻等功能

V1 的重点：

```text
游戏数据库
+
游戏搜索
+
游戏详情页
+
官方网站
+
官方商店/下载入口
+
自动数据导入
+
后台管理
```

---

# 2. 整体技术架构

建议采用：

```text
Next.js 16
TypeScript
Tailwind CSS
shadcn/ui
vinext

Cloudflare Workers
Cloudflare D1
Cloudflare R2
Cloudflare KV
Cloudflare Cron

Drizzle ORM

GitHub
GitHub Actions
```

整体结构：

```text
                     用户
                      │
                      ▼
              games.binbho.com
                      │
                      ▼
                 Cloudflare
                      │
           ┌──────────┼──────────┐
           │          │          │
           ▼          ▼          ▼
        Workers       D1         R2
       Web + API    Database    Images
           │
           │
       ┌───┴────┐
       ▼        ▼
     IGDB      Steam
       │        │
       └───┬────┘
           ▼
      Sync Worker
           │
           ▼
          D1
```

第一阶段尽量保持 Cloudflare 原生。

不增加：

```text
VPS
Nginx
Docker Server
独立 PostgreSQL
Redis Server
独立图片服务器
```

这样维护成本最低。

---

# 3. 网站整体视觉方向

## 设计关键词

整体风格：

**现代 / 深色 / 游戏感 / 简洁 / 内容型 / 高级感**

不要做成传统游戏下载站：

```text
❌ 满屏广告
❌ 大量红色按钮
❌ 花哨渐变
❌ 密密麻麻文字
❌ 下载按钮 everywhere
❌ “立即下载!!!”
```

希望视觉更接近：

```text
Steam
+
PlayStation
+
IGN
+
现代 SaaS 产品
```

但页面密度比 Steam 更低。

---

# 4. 颜色系统

默认采用深色主题。

背景：

```text
Page Background
#080B12

Surface
#0E131D

Card
#121824

Elevated Card
#171E2B

Border
#242D3C
```

主要文字：

```text
Primary
#F4F7FB

Secondary
#A7B0BF

Muted
#6F7A8A
```

品牌色：

```text
Primary Blue
#4C8DFF

Hover Blue
#6AA0FF
```

状态颜色：

```text
Official
绿色

Available
蓝色

Coming Soon
橙色

Unavailable
灰色
```

避免大面积高饱和蓝色。

蓝色主要用于：

```text
按钮
选中状态
链接
标签高亮
Focus
```

---

# 5. 字体与字号

优先：

```text
Inter
Geist
system-ui
```

中文：

```text
PingFang SC
Microsoft YaHei
Noto Sans SC
```

字号：

```text
Hero Title
48–64px

Page Title
32–40px

Section Title
22–28px

Game Title
16–18px

Body
14–16px

Meta
12–14px
```

游戏名可以稍微粗一点：

```text
font-weight: 600 / 700
```

正文保持：

```text
400 / 500
```

---

# 6. 页面最大宽度

桌面：

```text
max-width: 1440px
```

主要内容区域：

```text
1280–1360px
```

左右 Padding：

```text
Desktop
32px

Laptop
24px

Tablet
20px

Mobile
16px
```

---

# 7. Header

高度：

```text
64px
```

桌面结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ GAMEHUB   游戏   最新发布   即将上线   平台      🔍 搜索   │
└──────────────────────────────────────────────────────────────┘
```

Logo：

```text
GAME
HUB
```

可以使用：

```text
白色文字 + 蓝色小方块
```

类似：

```text
GAME HUB■
```

Logo 不使用复杂图案。

导航：

```text
游戏
最新发布
即将上线
免费游戏
平台
类型
```

右侧：

```text
搜索
主题切换
```

V1 暂时不显示登录。

---

# 8. 首页设计

首页承担三个功能：

```text
发现游戏
搜索游戏
进入官方资源
```

## 首页结构

```text
Header

Hero
↓
热门游戏
↓
最新发布
↓
最近更新
↓
按平台浏览
↓
免费游戏
↓
即将上线
↓
按类型浏览
↓
Footer
```

---

# 9. 首页 Hero

Hero 高度：

```text
Desktop
480–560px

Mobile
420–480px
```

采用大型游戏背景图。

例如：

```text
Black Myth: Wukong
```

布局：

```text
┌─────────────────────────────────────────────┐
│                                             │
│ BLACK MYTH                                  │
│ WUKONG                                      │
│                                             │
│ 动作角色扮演 · Game Science                 │
│                                             │
│ 以中国神话为背景的动作角色扮演游戏……       │
│                                             │
│ [查看游戏]   [Steam]                        │
│                                             │
└─────────────────────────────────────────────┘
```

图片右侧或全背景。

加入：

```text
左 → 右暗色渐变
底部暗色渐变
```

确保文字可读。

Hero 每次显示：

```text
1 款主推荐
```

下方可以放：

```text
● ○ ○ ○
```

最多 4–5 个推荐。

---

# 10. 首页搜索

Hero 下方放一个明显搜索框。

```text
┌──────────────────────────────────────────┐
│ 🔍 搜索游戏、开发商或 Steam App ID       │
└──────────────────────────────────────────┘
```

尺寸：

```text
Height
52–56px

Max width
720px
```

输入：

```text
Black Myth
```

即时出现：

```text
Black Myth: Wukong
Game Science
2024

Black Myth: Zhong Kui
Game Science
TBA
```

搜索结果显示：

```text
Cover
游戏名
开发商
年份
平台
```

---

# 11. 游戏 Card

统一组件：

```text
<GameCard />
```

比例：

```text
Cover
3:4
```

例如：

```text
┌──────────────┐
│              │
│    COVER     │
│              │
│              │
└──────────────┘

Black Myth: Wukong

Action RPG
2024
```

Hover：

```text
Card 上移 2–4px
Border 变亮
Cover 轻微放大 1.03
```

不要夸张动画。

Card 圆角：

```text
12px
```

图片：

```text
10px
```

Grid：

```text
Desktop
6 columns

Large laptop
5

Laptop
4

Tablet
3

Mobile
2
```

---

# 12. 首页热门游戏

标题：

```text
热门游戏
```

右边：

```text
查看全部 →
```

展示：

```text
6–12 款
```

Card 信息：

```text
Cover
游戏名称
类型
评分
```

例如：

```text
Black Myth: Wukong
Elden Ring
Cyberpunk 2077
Baldur's Gate 3
GTA V
Red Dead Redemption 2
```

---

# 13. 最新发布

结构：

```text
最新发布                         查看全部 →
```

建议使用横向 Game Card。

显示：

```text
发布日期
平台
```

---

# 14. 平台区域

设计成宽卡片：

```text
PC

Steam
Epic
GOG
Microsoft Store
```

下面：

```text
PlayStation
Xbox
Nintendo
```

样式：

```text
┌─────────────────┐
│ STEAM           │
│ 24,583 Games    │
└─────────────────┘
```

不需要使用平台官网的复杂 Logo 背景。

---

# 15. 类型浏览

采用 Chip：

```text
Action

RPG

Adventure

Strategy

Simulation

Sports

Racing

Horror

Survival

Open World

Indie
```

Chip 高度：

```text
36px
```

---

# 16. 游戏库页面

URL：

```text
/games
```

布局：

```text
游戏库

找到 58,423 款游戏

[搜索]

类型 ▼
平台 ▼
年份 ▼
状态 ▼
排序 ▼

────────────────────

Game Grid
```

桌面：

```text
Sidebar Filter
+
Content
```

也可以 V1 全部放顶部 Filter Bar。

建议：

```text
第一版顶部过滤
```

更简洁。

---

# 17. Filter

支持：

```text
Genre

Platform

Release Year

Release Status

Store
```

排序：

```text
热门
最新发布
名称
评分
更新时间
```

URL 要保留状态：

```text
/games?genre=rpg&platform=pc&sort=popular
```

方便：

```text
分享
SEO
刷新
浏览器返回
```

---

# 18. 游戏详情页

这是整个网站最重要的页面。

URL：

```text
/games/black-myth-wukong
```

页面结构：

```text
Hero
↓
基础信息
↓
官方资源
↓
游戏简介
↓
截图
↓
Trailer
↓
系统配置
↓
游戏信息
↓
相关游戏
```

---

# 19. Detail Hero

结构：

```text
大型 Header Background

              Cover

              Black Myth: Wukong

              黑神话：悟空

              ★ 9.2

              2024
              Action RPG
              Game Science

              [官方网站]
              [Steam]
```

桌面：

```text
┌───────────────────────────────────────────────────┐
│                                                   │
│     Cover       Black Myth: Wukong                │
│                 黑神话：悟空                       │
│                                                   │
│                 Action RPG · 2024                 │
│                                                   │
│                 Game Science                      │
│                                                   │
│                 [官方网站] [Steam]                 │
│                                                   │
└───────────────────────────────────────────────────┘
```

背景使用游戏 Header。

背景：

```text
blur
dark overlay
gradient
```

Cover：

```text
240 × 320 左右
```

---

# 20. 官方资源模块

这是 GameHub 的核心差异化功能。

标题：

```text
官方资源
```

副标题：

```text
已验证的游戏官网和官方商店入口
```

Card：

```text
┌────────────────────────────────────┐
│ ✓ 官方网站                         │
│                                    │
│ blackmythwukong.com                │
│                                    │
│                          访问 →    │
└────────────────────────────────────┘
```

Steam：

```text
┌────────────────────────────────────┐
│ Steam                              │
│                                    │
│ Windows                            │
│                                    │
│ 官方商店                前往 Steam │
└────────────────────────────────────┘
```

Epic：

```text
Epic Games
PC
官方商店
```

PlayStation：

```text
PlayStation Store
PS5
官方商店
```

Xbox：

```text
Xbox Store
Xbox Series X|S
```

---

# 21. 官方认证标记

Verified Link：

```text
✓ 官方
```

显示为绿色小 Badge。

Tooltip：

```text
该地址来源于游戏开发商、发行商或官方平台，并经过验证。
```

不要使用：

```text
100% SAFE!!!
```

保持专业。

---

# 22. 下载按钮逻辑

根据资源类型改变文字。

免费游戏：

```text
官方下载
```

付费游戏：

```text
前往购买
```

Steam：

```text
在 Steam 查看
```

Epic：

```text
在 Epic Games 查看
```

Demo：

```text
下载 Demo
```

Launcher：

```text
下载官方客户端
```

游戏官网：

```text
访问官网
```

---

# 23. 游戏简介

结构：

```text
关于这款游戏

Black Myth: Wukong 是一款……
```

默认最多：

```text
5–8 段
```

过长：

```text
展开全文
```

正文宽度尽量：

```text
760–900px
```

避免横跨 1400px。

---

# 24. Screenshot Gallery

显示：

```text
2 行
```

第一张较大：

```text
2×2
```

其他：

```text
1×1
```

例如：

```text
┌────────────────────┬───────────┐
│                    │ screenshot│
│                    ├───────────┤
│       Main         │ screenshot│
│                    │           │
└────────────────────┴───────────┘
```

点击：

```text
Lightbox
```

支持：

```text
←
→
ESC
```

---

# 25. Video

优先嵌入：

```text
YouTube 官方 Trailer
```

不自行上传大型视频。

例如：

```text
官方预告片

┌───────────────────────────────────────────┐
│                                           │
│                ▶                          │
│                                           │
└───────────────────────────────────────────┘
```

---

# 26. 系统要求

使用 Tab：

```text
最低配置
推荐配置
```

布局：

```text
操作系统      Windows 10 64-bit

处理器        Intel Core i5-8400

内存          16GB

显卡          GTX 1060

DirectX       11

存储空间      130GB
```

桌面两列。

移动端单列。

---

# 27. 游戏信息

右侧信息 Card：

```text
开发商
Game Science

发行商
Game Science

发布日期
2024-08-20

类型
Action RPG

平台
Windows
PS5
Xbox

模式
Single Player

Controller
支持
```

---

# 28. External IDs

后台可以查看。

前台隐藏。

例如：

```text
IGDB
119133

Steam
2358720
```

---

# 29. 相关游戏

详情页底部：

```text
你可能还喜欢
```

算法 V1：

```text
相同 Genre
+
相同 Developer
+
相同 Franchise
```

显示：

```text
6 款
```

---

# 30. Search 页面

URL：

```text
/search?q=wukong
```

结构：

```text
搜索

"wukong"

找到 12 个结果
```

结果可以使用横向 Card：

```text
Cover
Black Myth: Wukong
Game Science · 2024
Action RPG
```

这样搜索信息密度更高。

---

# 31. Genre 页面

例如：

```text
/genres/action
```

Header：

```text
Action Games

动作游戏
```

描述：

```text
探索动作类电子游戏……
```

下面：

```text
热门
最新
全部
```

---

# 32. Platform 页面

例如：

```text
/platforms/steam
```

Header：

```text
Steam Games
```

展示：

```text
游戏数量
热门游戏
最新发布
```

---

# 33. Latest 页面

```text
/releases
```

按照日期：

```text
September 2026

Sep 1

Game A
Game B

Aug 31

Game C
```

SEO 价值很高。

---

# 34. Upcoming 页面

```text
/upcoming
```

按照：

```text
本周
本月
2026
2027
TBA
```

分类。

---

# 35. Admin 后台

地址：

```text
/admin
```

后台不公开导航入口。

页面：

```text
/admin

/admin/games

/admin/games/new

/admin/games/[id]

/admin/import

/admin/links

/admin/sync

/admin/settings
```

---

# 36. Admin Dashboard

显示：

```text
Total Games
58,423

Official Links
128,542

Broken Links
42

Pending Review
17

Last Steam Sync
2 hours ago

Last IGDB Sync
4 hours ago
```

---

# 37. 添加游戏

支持三种方式：

```text
Steam 导入

IGDB 导入

手动创建
```

---

# 38. Steam Import

后台：

```text
添加游戏

Steam 搜索

[ Black Myth Wukong                 ]

Search
```

结果：

```text
Cover

Black Myth: Wukong

AppID
2358720

Game Science

[预览]
[导入]
```

点击预览：

```text
Name
Developer
Publisher
Release Date
Genres
Screenshots
System Requirements
Steam URL
```

点击：

```text
Import
```

写入 D1。

---

# 39. IGDB Import

流程：

```text
Search
↓
IGDB API
↓
选择游戏
↓
Preview
↓
Import
```

IGDB 主要负责：

```text
游戏身份
封面
开发商
发行商
类型
平台
发布日期
系列
Franchise
```

---

# 40. 数据合并规则

如果游戏已经存在：

```text
Steam
+
IGDB
```

不能创建两个 Game。

统一映射：

```text
games.id
```

例如：

```text
Game

id
10001

title
Black Myth: Wukong
```

External IDs：

```text
game_external_ids

game_id     provider     external_id

10001       igdb         119133

10001       steam        2358720
```

---

# 41. 数据优先级

游戏名称：

```text
Manual
>
IGDB
>
Steam
```

系统配置：

```text
Manual
>
Steam
```

Official Website：

```text
Manual Verified
>
Official API
>
IGDB
```

截图：

```text
Official
>
Steam
>
IGDB
```

---

# 42. D1 数据库结构

建议：

```text
games

game_names

game_external_ids

game_genres

genres

game_platforms

platforms

game_companies

companies

game_images

game_videos

game_official_links

game_system_requirements

game_release_dates

sync_jobs

link_checks
```

---

# 43. games

```text
id

slug

title

title_cn

summary

description

cover_url

hero_url

release_date

release_status

developer_id

publisher_id

official_website

rating

rating_count

created_at

updated_at
```

---

# 44. game_external_ids

```text
id

game_id

provider

external_id

external_url

created_at

updated_at
```

Provider：

```text
igdb
steam
epic
gog
xbox
playstation
nintendo
itch
```

---

# 45. game_official_links

这是核心表。

```text
id

game_id

provider

platform

link_type

url

region

is_official

verification_method

verification_status

http_status

redirect_url

verified_at

last_checked_at

created_at

updated_at
```

link_type：

```text
website

store

purchase

download

demo

launcher

support
```

---

# 46. 链接状态

```text
verified

pending

broken

redirected

manual_review
```

---

# 47. verification_method

```text
official_api

publisher_site

developer_site

manual

store_api
```

---

# 48. 图片结构

R2 Bucket：

```text
gamehub-assets
```

目录：

```text
games/
    {game_id}/
        cover.webp

        hero.webp

        screenshots/
            001.webp
            002.webp
            003.webp

        thumbnails/
```

---

# 49. 图片规格

Cover：

```text
600 × 800
WebP
```

Hero：

```text
1920 × 800
WebP
```

Screenshot：

```text
1920 × 1080
WebP
```

Thumbnail：

```text
640px width
```

质量：

```text
WebP 75–85
```

---

# 50. R2 策略

第一阶段：

外部 API 图片：

```text
Steam CDN
IGDB CDN
```

允许直接使用。

有价值的图片逐步同步 R2。

这样避免一开始：

```text
50,000 games
×
10 screenshots
```

产生大量图片同步。

---

# 51. 搜索

V1 使用 D1。

建立：

```text
title index

slug index

release_date index

external_id index
```

搜索字段：

```text
title

title_cn

alternative_title

developer

Steam App ID
```

结果限制：

```text
20–50
```

---

# 52. SEO

每款游戏独立页面。

例如：

```text
/games/black-myth-wukong
```

Title：

```text
Black Myth: Wukong - 官网、Steam 与官方游戏信息 | GameHub
```

Description：

```text
查看 Black Myth: Wukong 游戏介绍、系统配置、截图以及官方网站、Steam、PlayStation 等官方入口。
```

---

# 53. Structured Data

游戏页面加入：

```text
VideoGame
BreadcrumbList
WebPage
```

Schema.org。

---

# 54. Sitemap

不要只有：

```text
/sitemap.xml
```

以后游戏数量大了拆分：

```text
/sitemap.xml

/sitemaps/games-1.xml

/sitemaps/games-2.xml

/sitemaps/genres.xml

/sitemaps/platforms.xml
```

每个游戏 Sitemap：

```text
50,000 URLs 以下
```

---

# 55. URL 规范

统一：

```text
/games/{slug}

/genres/{slug}

/platforms/{slug}
```

禁止：

```text
/game.php?id=123

/123-black-myth-wukong.html
```

---

# 56. Slug

例如：

```text
Black Myth: Wukong

↓

black-myth-wukong
```

重名游戏：

```text
doom-1993

doom-2016
```

---

# 57. Cloudflare Worker

主要处理：

```text
SSR

API

Admin Actions

Steam API

IGDB API

D1

R2
```

---

# 58. Cron Worker

定时任务：

```text
Daily
新游戏

Daily
近期发布

Daily
即将上线

Weekly
官方链接检查

Weekly
游戏 Metadata 更新
```

---

# 59. Link Checker

流程：

```text
official_links
     ↓
Worker
     ↓
HEAD / GET
     ↓
Status
```

结果：

```text
200
Verified

301
Redirected

404
Broken

403
Needs Review

Timeout
Retry
```

不要自动下载游戏文件。

只检查链接状态。

---

# 60. KV

KV V1 主要存：

```text
首页缓存

搜索建议缓存

热门游戏缓存

API Response Cache

Settings
```

不要把游戏主体数据放 KV。

主体数据属于：

```text
D1
```

---

# 61. 推荐目录结构

```text
gamehub/
│
├── app/
│   │
│   ├── (site)/
│   │   │
│   │   ├── page.tsx
│   │   │
│   │   ├── games/
│   │   │   ├── page.tsx
│   │   │   └── [slug]/
│   │   │       ├── page.tsx
│   │   │       ├── loading.tsx
│   │   │       └── not-found.tsx
│   │   │
│   │   ├── genres/
│   │   │   ├── page.tsx
│   │   │   └── [slug]/
│   │   │
│   │   ├── platforms/
│   │   │   ├── page.tsx
│   │   │   └── [slug]/
│   │   │
│   │   ├── releases/
│   │   │
│   │   ├── upcoming/
│   │   │
│   │   └── search/
│   │
│   ├── admin/
│   │   │
│   │   ├── page.tsx
│   │   │
│   │   ├── games/
│   │   │
│   │   ├── import/
│   │   │
│   │   ├── links/
│   │   │
│   │   └── sync/
│   │
│   └── api/
│       │
│       ├── search/
│       │
│       ├── games/
│       │
│       ├── steam/
│       │
│       ├── igdb/
│       │
│       └── admin/
│
├── components/
│   │
│   ├── layout/
│   │   ├── header.tsx
│   │   ├── footer.tsx
│   │   └── container.tsx
│   │
│   ├── game/
│   │   ├── game-card.tsx
│   │   ├── game-grid.tsx
│   │   ├── game-hero.tsx
│   │   ├── game-info.tsx
│   │   ├── game-gallery.tsx
│   │   ├── game-video.tsx
│   │   ├── game-requirements.tsx
│   │   └── official-links.tsx
│   │
│   ├── search/
│   │   ├── search-bar.tsx
│   │   ├── search-modal.tsx
│   │   └── search-result.tsx
│   │
│   ├── filters/
│   │
│   ├── admin/
│   │
│   └── ui/
│
├── db/
│   │
│   ├── schema/
│   │   ├── games.ts
│   │   ├── companies.ts
│   │   ├── genres.ts
│   │   ├── platforms.ts
│   │   ├── external-ids.ts
│   │   ├── official-links.ts
│   │   └── sync.ts
│   │
│   ├── queries/
│   │
│   ├── migrations/
│   │
│   └── index.ts
│
├── lib/
│   │
│   ├── steam/
│   │   ├── client.ts
│   │   ├── search.ts
│   │   ├── game.ts
│   │   └── mapper.ts
│   │
│   ├── igdb/
│   │   ├── client.ts
│   │   ├── search.ts
│   │   ├── game.ts
│   │   └── mapper.ts
│   │
│   ├── links/
│   │   ├── checker.ts
│   │   └── verifier.ts
│   │
│   ├── images/
│   │
│   ├── seo/
│   │
│   └── utils/
│
├── workers/
│   │
│   ├── game-sync.ts
│   ├── link-check.ts
│   └── image-sync.ts
│
├── public/
│
├── styles/
│
├── types/
│
├── drizzle.config.ts
│
├── wrangler.jsonc
│
├── next.config.ts
│
└── package.json
```

---

# 62. Component 原则

组件不要写成：

```text
1000 行 GamePage.tsx
```

拆：

```text
GameHero

OfficialLinks

GameDescription

GameGallery

GameVideo

SystemRequirements

GameInformation

RelatedGames
```

页面：

```text
page.tsx
```

只负责：

```text
Fetch
Compose
SEO
```

---

# 63. Responsive

Desktop：

```text
1440
1280
1024
```

Mobile：

```text
390
375
360
```

重点保证：

```text
iPhone
Android
iPad
13–14 inch Laptop
Desktop
```

---

# 64. 移动端详情页

Desktop：

```text
Cover | Info
```

Mobile：

```text
Hero Background

Cover

Game Title

Meta

Official Links

Description
```

官方下载按钮要：

```text
100% width
```

---

# 65. 动效

原则：

```text
150–250ms
```

使用：

```text
opacity
transform
scale
```

避免：

```text
复杂粒子
大范围 blur animation
大量 GSAP
3D Card
```

游戏图片本身已经有足够视觉冲击力。

---

# 66. Skeleton

所有：

```text
Game Grid

Detail

Search
```

都提供 Skeleton。

不要 Loading Spinner 满屏转。

---

# 67. Empty State

例如搜索不到：

```text
没有找到 “xxxxx”

尝试：
检查游戏名称
搜索英文名称
搜索开发商
```

---

# 68. Error State

外部 API 失败：

```text
当前无法获取最新游戏数据。

已有游戏页面继续正常显示。
```

外部 API 永远不能成为前台页面唯一数据来源。

重要数据必须写 D1。

---

# 69. Security

Admin：

```text
Cloudflare Access
```

优先使用 Cloudflare Access 保护：

```text
/admin/*
```

避免第一版自己写复杂管理员认证。

API：

```text
Rate Limit
Origin Validation
Admin Token
```

---

# 70. 环境变量

```text
IGDB_CLIENT_ID

IGDB_CLIENT_SECRET

STEAM_API_KEY

ADMIN_SECRET

R2_BUCKET

DATABASE
```

Secret：

```text
wrangler secret
```

禁止放进 GitHub。

---

# 71. GitHub

Repository：

```text
gamehub
```

分支：

```text
main

develop

feature/*
```

推荐：

```text
main
↓
Production

Pull Request
↓
Preview
```

---

# 72. 部署

```text
GitHub
   ↓
Cloudflare Build
   ↓
Workers
   ↓
games.binbho.com
```

第一阶段：

```text
dev
games-dev.binbho.com

production
games.binbho.com
```

---

# 73. V1 开发阶段

### Phase 1

项目框架。

完成：

```text
Next.js
vinext
Tailwind
shadcn
Cloudflare Workers
D1
Drizzle
R2
```

### Phase 2

基础 UI。

完成：

```text
Header
Footer
Container
GameCard
首页
游戏列表
游戏详情
Responsive
```

先使用 Mock Data。

### Phase 3

D1。

完成：

```text
Schema
Migration
Seed
Query Layer
```

### Phase 4

IGDB。

完成：

```text
Search
Import
Metadata
Cover
Genres
Platforms
Companies
```

### Phase 5

Steam。

完成：

```text
Steam Search
AppID
Metadata
Screenshots
Requirements
Steam Store Link
```

### Phase 6

官方链接。

完成：

```text
Official Website
Steam
Epic
GOG
Xbox
PlayStation
Nintendo
```

### Phase 7

后台。

完成：

```text
Dashboard
Games
Import
Edit
Official Links
Link Review
```

### Phase 8

自动同步。

完成：

```text
Cron
Game Update
Link Check
Sync Log
```

### Phase 9

SEO。

完成：

```text
Metadata
Canonical
Structured Data
Sitemap
Robots
OG
```

### Phase 10

正式上线。

```text
games.binbho.com
```

---

# 74. 第一版首页信息架构

最终：

```text
HEADER

HERO
Black Myth: Wukong

SEARCH

热门游戏

最新发布

免费游戏

即将上线

平台

类型

FOOTER
```

控制首页长度。

不要一开始塞：

```text
攻略
新闻
论坛
MOD
排行榜
硬件
配置检测
```

---

# 75. 第一版 Game 页面信息架构

```text
Hero

Game Title

Meta

Official Links

About

Screenshots

Trailer

System Requirements

Game Information

Related Games
```

这就是 V1 最核心模板。

---

# 76. 第一版视觉目标

用户第一次进入首页时应该感觉：

```text
“这是一个现代游戏数据库。”
```

进入游戏页后应该马上理解：

```text
“这里可以找到这个游戏真正的官方网站和官方获取方式。”
```

官方下载入口必须：

```text
清晰
可信
克制
```

视觉层级：

```text
游戏本身
↓
游戏官网
↓
官方平台
↓
游戏资料
```

不要让网站看起来像灰色资源站。

---

# 77. 品牌方向

第一阶段：

```text
GameHub
```

只是开发代号。

Logo：

```text
GAMEHUB
```

采用纯 Typography。

未来确认独立域名以后再做正式品牌。

Footer：

```text
GameHub

Discover games and their official sources.

游戏信息及商标归其各自所有者所有。
GameHub 仅提供游戏信息与官方资源导航。
```

---

# 78. Codex 第一阶段任务

第一条开发 Prompt 可以直接写：

```text
根据 docs/product-spec.md 中的产品规格创建 GameHub V1。

第一阶段只完成：

1. Next.js 16 项目结构
2. Cloudflare Workers / vinext 基础配置
3. TypeScript
4. Tailwind CSS
5. shadcn/ui
6. 深色 Design System
7. Responsive Header
8. Homepage
9. Games List
10. Game Detail
11. Search UI
12. 使用 Mock Data

暂时不要：
- 接 IGDB
- 接 Steam API
- 建正式同步 Worker
- 实现用户系统

必须：
- 将组件拆分
- 使用 App Router
- 页面 Responsive
- 不把所有代码塞进单个 page.tsx
- 建立清晰的 components/game、components/layout、lib、types 目录
- UI 按 product-spec.md 的视觉规范实现
```

第一阶段完成以后检查 UI。

确认首页和 Game Detail 的视觉方向以后，再进入：

```text
D1
+
IGDB
+
Steam
```

这样返工最少。

---

# 79. V1 最终目标

上线时至少拥有：

```text
500–1,000 款热门游戏
```

每款游戏至少包含：

```text
英文名称
中文名称（如果有）
封面
Hero
开发商
发行商
发布日期
类型
平台
介绍
截图
系统配置
官方网站
Steam / 官方平台
```

核心目标：

```text
用户搜索一款游戏
       ↓
找到游戏详情
       ↓
确认这是不是自己想找的游戏
       ↓
进入真正的官方网站
       ↓
进入官方商店或官方下载页
```

整个产品围绕这一条路径开发。
