# Xinhao Minecraft 机器人

基于 mineflayer 的 Minecraft 智能机器人系统，支持自动注册登录、AI 行为（探索、砍树、挖矿、建造、PvP、PvE）。

## 快速开始

```bash
# 安装依赖
npm install

# 启动机器人
npm start
```

## 配置文件说明

所有配置在 `config.json` 中，以下是每个字段的详细说明：

---

### 基础配置

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `version` | string | Minecraft 服务器版本，必须与服务器一致 | `"1.21.10"` |
| `server.address` | string | 服务器 IP 或域名 | `"你的ip"` |
| `server.port` | number | 服务器端口 | `25565` |

---

### 机器人连接配置 (`bot`)

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `join-interval` | number | 每个机器人启动间隔（秒），避免同时连接被服务器限流 | `100` |
| `reconnect-delay.min` | number | 掉线后最小重连延迟（秒） | `100` |
| `reconnect-delay.max` | number | 掉线后最大重连延迟（秒），每个机器人独立随机 | `200` |

> **注意**：`join-interval` 是固定间隔，机器人 #0 在 0 秒启动，#1 在 100 秒启动，#2 在 200 秒启动，以此类推。重连延迟是随机的，避免所有机器人同时重连卡服。

---

### 机器人名字 (`bot-names`)

```json
"bot-names": [
  "Kiilo",
  "Bupu_oo",
  "coco_z"
]
```

- 数组中的每个名字对应一个机器人
- **机器人数量 = 数组长度**，不需要单独设置数量
- 每个机器人固定使用对应位置的名字，掉线重连时保持同一个名字
- 如果数组为空，会自动生成随机真人风格的名字

---

### 动作序列 (`actions`)

机器人连接成功后按顺序执行的动作列表：

```json
"actions": [
  { "id": "sleep", "value": 5000 },
  { "id": "command", "value": "reg <密码> <重复你的密码>" },
  { "id": "sleep", "value": 1000 },
  { "id": "command", "value": "l <你的密码>" },
  { "id": "sleep", "value": 2000 },
  { "id": "command", "value": "warp 资源" },
  { "id": "sleep", "value": 8000 },
  { "id": "command", "value": "rt" },
  { "id": "sleep", "value": 8000 }
]
```

**动作类型：**

| id | 说明 | value 格式 |
|------|------|------|
| `sleep` | 等待指定毫秒数 | 数字，单位毫秒 |
| `command` | 执行服务器命令（自动加 `/` 前缀） | 命令内容，不含 `/` |
| `chat` | 发送聊天消息 | 消息文本 |

**占位符：**

| 占位符 | 替换为 |
|--------|--------|
| `{password}` | 自动生成的机器人密码 |
| `{name}` | 机器人名字 |

**执行流程示例（以上面配置为例）：**

```
1. 等待 5 秒（让服务器加载完成）
2. 执行 /reg 15185279411tink 15185279411tink（注册）
3. 等待 1 秒
4. 执行 /l 15185279411tink（登录）
5. 等待 2 秒
6. 执行 /warp 资源（传送到资源世界）
7. 等待 8 秒（等传送完成）
8. 执行 /rt（随机传送）
9. 等待 8 秒（等传送完成）
10. 所有动作完成，启动 AI 系统
```

---

### 密码配置 (`password-pattern`)

```json
"password-pattern": "Bot_{uuid}"
```

- 每个机器人自动生成一个密码，重连时保持同一个密码
- `{uuid}` 会被替换为随机字符串
- 可以自定义格式，例如 `"MyPassword123"` 让所有机器人用同一个密码

---

### AI 系统配置 (`ai`)

```json
"ai": {
  "enabled": true,
  "tick-interval": 3000,
  "scan-radius": 32,
  "behaviors": { ... }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用 AI 系统 |
| `tick-interval` | number | AI 决策间隔（毫秒），每隔多久检查一次周围环境并决定行为 |
| `scan-radius` | number | 环境扫描半径（格），机器人能"看到"多远的方块和生物 |

---

### AI 行为配置 (`ai.behaviors`)

AI 系统包含 6 种行为，按**优先级**从高到低执行（数字越小优先级越高）：

#### 1. 探索 (`explore`) — 优先级 1

机器人随机走动，探索地图。

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | boolean | 是否启用 | `true` |
| `priority` | number | 优先级（数字越小越优先） | `1` |
| `walk-distance` | number | 每次走动目标距离（格） | `20` |
| `walk-interval` | [min, max] | 两次走动之间的随机间隔（秒） | `[5, 15]` |

#### 2. 砍树 (`chop-wood`) — 优先级 2

自动识别并砍伐周围的树木。

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | boolean | 是否启用 | `true` |
| `priority` | number | 优先级 | `2` |
| `max-logs` | number | 最多砍多少棵树 | `20` |
| `tree-types` | string[] | 识别的树木类型（Minecraft 方块名） | 所有原木类型 |

#### 3. 挖矿 (`mine`) — 优先级 3

自动识别并挖掘周围的矿石，找不到矿石时向下挖掘。

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | boolean | 是否启用 | `true` |
| `priority` | number | 优先级 | `3` |
| `max-ores` | number | 最多挖多少块矿石 | `30` |
| `ore-types` | string[] | 识别的矿石类型 | 所有常见矿石 |
| `dig-down` | boolean | 找不到矿石时是否向下挖 | `true` |
| `max-depth` | number | 向下挖掘的最大深度（格） | `30` |

#### 4. 建造 (`build`) — 优先级 4

自动建造房子（需要背包里有建筑材料）。

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | boolean | 是否启用 | `true` |
| `priority` | number | 优先级 | `4` |
| `house-size` | number | 房子边长（格），7 表示 7x7 | `7` |
| `wall-height` | number | 墙的高度（格） | `4` |
| `build-material` | string | 建筑材料（Minecraft 物品名） | `"oak_planks"` |

> 建造流程：先清理地面 → 建四面外墙 → 留一个 1x2 的门洞

#### 5. PvP (`pvp`) — 优先级 5

检测周围玩家并自动攻击，血量低时逃跑。

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | boolean | 是否启用 | `true` |
| `priority` | number | 优先级 | `5` |
| `attack-range` | number | 攻击范围（格） | `4` |
| `flee-health` | number | 血量低于多少时逃跑（半颗心为单位，20=满血） | `4` |
| `weapon-types` | string[] | 优先使用的武器类型 | 所有剑 |

#### 6. PvE (`pve`) — 优先级 5

检测周围怪物并自动攻击，血量低时逃跑。

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | boolean | 是否启用 | `true` |
| `priority` | number | 优先级 | `5` |
| `attack-range` | number | 攻击范围（格） | `4` |
| `flee-health` | number | 血量低于多少时逃跑 | `4` |
| `hostile-mobs` | string[] | 需要攻击的怪物类型 | 所有常见敌对生物 |

---

### 行为优先级说明

AI 每 `tick-interval` 毫秒执行一次决策，按优先级从高到低检查：

```
PvP/PvE (5) → 砍树 (2) → 挖矿 (3) → 建造 (4) → 探索 (1)
```

**实际执行顺序是按 priority 数字从小到大**：

1. 先检查 PvP/PvE（priority=5，但战斗优先级最高，代码中排在前面）
2. 再检查砍树（priority=2）
3. 再检查挖矿（priority=3）
4. 再检查建造（priority=4）
5. 最后探索（priority=1）

**每次只执行一个行为**，执行完后等下一个 tick 再决策。

---

## 机器人行为规则

### 死亡与复活

| 场景 | 行为 |
|------|------|
| 首次连接时已死亡 | 自动复活一次，然后正常执行动作 |
| 执行动作过程中死亡 | **不复活**，保持死亡状态 |
| 掉线重连时仍死亡 | 自动复活一次，继续执行 |
| 重连后再次死亡 | **不复活** |

### 掉线重连

- 每个机器人独立计算重连延迟（`reconnect-delay.min` ~ `max` 之间随机）
- 重连时保持原来的名字和密码
- 不会因为一个机器人掉线影响其他机器人

---

## 依赖

```bash
npm install mineflayer mineflayer-pathfinder vec3 @faker-js/faker pinyin-pro
```

| 依赖 | 用途 |
|------|------|
| `mineflayer` | Minecraft 协议客户端 |
| `mineflayer-pathfinder` | 自动寻路 |
| `vec3` | 三维向量计算 |
| `@faker-js/faker` | 生成随机名字（备用） |
| `pinyin-pro` | 中文转拼音（备用） |

---

## 注意事项

### GrimAC 反作弊

如果服务器使用 GrimAC 反作弊插件，机器人会触发 `TickTimer type=flying` 警报。这是因为 mineflayer 的 Node.js 定时器无法完美模拟真实客户端的包发送时序（精度要求 1.005 倍）。

**解决方案**：在 GrimAC 配置中把机器人账号加到豁免列表：

```yaml
# plugins/GrimAC/config.yml
exempt-players:
  - Kiilo
  - Bupu_oo
  - coco_z
  # ... 所有机器人名字
```

或使用权限节点：

```bash
/lp user Kiilo permission set grimac.bypass true
/lp user Bupu_oo permission set grimac.bypass true
# ... 每个机器人都要加
```

### 服务器限流

如果日志出现 `Connection throttled`，说明同时连接太多机器人被服务器限流。解决方法：

1. 增大 `join-interval`（如从 100 改到 120）
2. 减少 `bot-names` 中的机器人数量

### 性能

- 每个机器人每 3 秒执行一次 AI 决策
- 环境扫描范围 32x32x32 = 32768 个方块
- 建议同时运行的机器人数量不超过 20 个，否则可能卡顿
