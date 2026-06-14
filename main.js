const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock, GoalXZ, GoalInvert, GoalFollow, GoalY } = require('mineflayer-pathfinder').goals;
const { Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { fakerEN_US, fakerZH_CN } = require('@faker-js/faker');
const { pinyin } = require('pinyin-pro');

const config = require('./config.json');
const botList = [];

function log(level, message) {
  const timestamp = new Date().toLocaleString('zh-CN');
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// ==================== AI 状态机 ====================
class AIStateMachine {
  constructor(bot) {
    this.bot = bot;
    this.state = 'idle';
    this.previousState = 'idle';
    this.stateTimer = null;
    this.stats = {
      logsChopped: 0,
      oresMined: 0,
      mobsKilled: 0,
      playersKilled: 0,
      blocksPlaced: 0,
      distanceTraveled: 0,
      timesAttacked: 0,
      timesEscapedWater: 0
    };
    // 威胁缓存
    this.lastThreatTime = 0;
    this.lastThreatEntity = null;
    this.combatCooldown = 0;
    // 水中状态
    this.inWater = false;
    this.waterEscapeAttempts = 0;
    // 行为锁（防止多个行为同时执行）
    this.busy = false;
  }

  setState(newState) {
    if (this.state === newState) return;
    this.previousState = this.state;
    this.state = newState;
    log('AI', `[${this.bot.username}] ${this.previousState} -> ${newState}`);
    this.clearTimer();
  }

  setTimer(callback, delay) {
    this.clearTimer();
    this.stateTimer = setTimeout(callback, delay);
  }

  clearTimer() {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
  }
}

// ==================== 环境感知 ====================
class EnvironmentScanner {
  constructor(bot, radius) {
    this.bot = bot;
    this.radius = radius;
  }

  scanBlocks(blockTypes) {
    const results = [];
    for (let x = -this.radius; x <= this.radius; x++) {
      for (let y = -this.radius; y <= this.radius; y++) {
        for (let z = -this.radius; z <= this.radius; z++) {
          const pos = this.bot.entity.position.offset(x, y, z);
          const block = this.bot.blockAt(pos);
          if (block && blockTypes.includes(block.name)) {
            results.push({ block, position: pos, distance: Math.sqrt(x*x + y*y + z*z) });
          }
        }
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  scanEntities(entityTypes) {
    const results = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (entity === this.bot.entity) continue;
      if (entityTypes.includes(entity.type) || entityTypes.includes(entity.name)) {
        const dx = entity.position.x - this.bot.entity.position.x;
        const dy = entity.position.y - this.bot.entity.position.y;
        const dz = entity.position.z - this.bot.entity.position.z;
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (distance <= this.radius) {
          results.push({ entity, distance, dx, dy, dz });
        }
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  scanPlayers() { return this.scanEntities(['player']); }
  scanHostileMobs(mobTypes) { return this.scanEntities(mobTypes); }
  scanTrees(treeTypes) { return this.scanBlocks(treeTypes); }
  scanOres(oreTypes) { return this.scanBlocks(oreTypes); }

  // 检测是否在水中
  isBotInWater() {
    const pos = this.bot.entity.position;
    const block = this.bot.blockAt(pos);
    const blockAbove = this.bot.blockAt(pos.offset(0, 1, 0));
    return (block && (block.name === 'water' || block.name === 'flowing_water')) ||
           (blockAbove && (blockAbove.name === 'water' || blockAbove.name === 'flowing_water'));
  }

  // 检测是否在熔岩中
  isBotInLava() {
    const pos = this.bot.entity.position;
    const block = this.bot.blockAt(pos);
    return block && (block.name === 'lava' || block.name === 'flowing_lava');
  }

  // 找最近的干燥地面（用于水中逃生）
  findDryGround(searchRadius) {
    const pos = this.bot.entity.position;
    let bestPos = null;
    let bestDist = Infinity;
    
    for (let x = -searchRadius; x <= searchRadius; x++) {
      for (let z = -searchRadius; z <= searchRadius; z++) {
        const groundPos = new Vec3(Math.floor(pos.x) + x, Math.floor(pos.y), Math.floor(pos.z) + z);
        const block = this.bot.blockAt(groundPos);
        const above = this.bot.blockAt(groundPos.offset(0, 1, 0));
        const above2 = this.bot.blockAt(groundPos.offset(0, 2, 0));
        
        if (block && !block.name.includes('water') && !block.name.includes('lava') &&
            (!above || above.name === 'air') && (!above2 || above2.name === 'air')) {
          const dist = Math.sqrt(x*x + z*z);
          if (dist < bestDist) {
            bestDist = dist;
            bestPos = groundPos;
          }
        }
      }
    }
    return bestPos;
  }

  // 找最近的陆地（用于逃离熔岩）
  findSafeGround(searchRadius) {
    return this.findDryGround(searchRadius);
  }
}

// ==================== 即时反应系统 ====================
class ThreatReactor {
  constructor(bot, aiManager, aiConfig) {
    this.bot = bot;
    this.ai = aiManager;
    this.config = aiConfig;
    this.lastAttackTime = 0;
    this.attackInterval = 500; // 攻击冷却 0.5 秒
  }

  // 受伤时立即反应
  onHurt(damage, attacker) {
    if (this.bot.health <= 0) return;
    
    this.ai.stateMachine.stats.timesAttacked++;
    const now = Date.now();
    
    // 停止当前所有行为
    this.bot.pathfinder?.stop();
    this.ai.stateMachine.busy = false;
    
    if (attacker) {
      const attackerName = attacker.username || attacker.name || '未知';
      const attackerType = attacker.type || 'unknown';
      log('COMBAT', `[${this.bot.username}] 被 ${attackerName}(${attackerType}) 攻击! 伤害: ${damage} 血量: ${this.bot.health}`);
      
      // 血量太低就逃跑
      if (this.bot.health <= (this.config.behaviors.pve?.fleeHealth || 4)) {
        log('COMBAT', `[${this.bot.username}] 血量过低，逃跑!`);
        this.fleeFrom(attacker);
        return;
      }
      
      // 立即反击
      this.counterAttack(attacker);
    } else {
      // 不知道谁打的，扫描周围敌人
      log('COMBAT', `[${this.bot.username}] 受到 ${damage} 点伤害，血量: ${this.bot.health}，扫描周围...`);
      this.scanAndFight();
    }
  }

  // 反击
  counterAttack(target) {
    const now = Date.now();
    if (now - this.lastAttackTime < this.attackInterval) return;
    this.lastAttackTime = now;
    
    try {
      // 装备武器
      this.equipBestWeapon();
      
      // 面向目标
      const lookPos = target.position.offset(0, 1, 0);
      this.bot.lookAt(lookPos);
      
      // 攻击
      this.bot.attack(target);
      log('COMBAT', `[${this.bot.username}] 反击 ${target.username || target.name}!`);
    } catch (e) {
      // 攻击失败
    }
  }

  // 扫描周围并战斗
  scanAndFight() {
    const scanner = this.ai.scanner;
    const pveConfig = this.config.behaviors.pve;
    const pvpConfig = this.config.behaviors.pvp;
    
    // 先检查玩家
    if (pvpConfig?.enabled) {
      const players = scanner.scanPlayers();
      for (const p of players) {
        if (p.distance <= (pvpConfig['attack-range'] || 4)) {
          this.counterAttack(p.entity);
          return;
        }
      }
    }
    
    // 再检查怪物
    if (pveConfig?.enabled) {
      const mobs = scanner.scanHostileMobs(pveConfig['hostile-mobs'] || []);
      for (const m of mobs) {
        if (m.distance <= (pveConfig['attack-range'] || 4)) {
          this.counterAttack(m.entity);
          return;
        }
      }
    }
  }

  // 逃跑
  fleeFrom(threat) {
    const pos = this.bot.entity.position;
    const dx = pos.x - threat.position.x;
    const dz = pos.z - threat.position.z;
    const dist = Math.sqrt(dx*dx + dz*dz) || 1;
    
    // 朝远离威胁的方向跑
    const fleeX = pos.x + (dx / dist) * 30;
    const fleeZ = pos.z + (dz / dist) * 30;
    
    try {
      this.bot.pathfinder.setGoal(new GoalXZ(fleeX, fleeZ));
      setTimeout(() => this.bot.pathfinder?.stop(), 5000);
    } catch (e) {}
    
    log('COMBAT', `[${this.bot.username}] 逃跑中...`);
  }

  // 装备最好的武器
  equipBestWeapon() {
    const weaponPriority = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];
    for (const weaponName of weaponPriority) {
      const weapon = this.bot.inventory.items().find(item => item.name === weaponName);
      if (weapon) {
        try { this.bot.equip(weapon, 'hand'); } catch(e) {}
        return;
      }
    }
  }
}

// ==================== 水中逃生行为 ====================
class WaterEscapeBehavior {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.config = aiConfig;
    this.lastEscapeTime = 0;
    this.escapeCooldown = 2000; // 2 秒冷却
  }

  canExecute(scanner) {
    return scanner.isBotInWater() || scanner.isBotInLava();
  }

  async execute(scanner, ai) {
    const now = Date.now();
    if (now - this.lastEscapeTime < this.escapeCooldown) return;
    this.lastEscapeTime = now;

    const pos = this.bot.entity.position;
    if (!pos || isNaN(pos.x)) return;

    const inLava = scanner.isBotInLava();
    log('SURVIVAL', `[${this.bot.username}] ${inLava ? '在熔岩中!' : '在水中!'} 寻找陆地逃生...`);

    // 找最近的干燥地面
    const searchRadius = inLava ? 16 : 12;
    const dryGround = scanner.findDryGround(searchRadius);
    
    if (!dryGround) {
      log('SURVIVAL', `[${this.bot.username}] 附近没有陆地，尝试跳跃...`);
      // 没有陆地，尝试跳起来
      this.bot.setControlState('jump', true);
      setTimeout(() => this.bot.setControlState('jump', false), 1000);
      return;
    }

    const dist = Math.sqrt(
      Math.pow(dryGround.x - pos.x, 2) + Math.pow(dryGround.z - pos.z, 2)
    );
    log('SURVIVAL', `[${this.bot.username}] 发现陆地距离 ${dist.toFixed(1)}格，游过去!`);

    try {
      // 设置目标
      const goal = new GoalNear(dryGround.x, dryGround.y, dryGround.z, 1);
      this.bot.pathfinder.setGoal(goal);
      
      // 在水中要一直按跳跃
      this.bot.setControlState('jump', true);
      
      // 等待到达或超时
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.bot.pathfinder?.stop();
          this.bot.setControlState('jump', false);
          resolve();
        }, 10000);
        
        // 每秒检查是否已经离开水
        const checkInterval = setInterval(() => {
          if (!scanner.isBotInWater() && !scanner.isBotInLava()) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            this.bot.setControlState('jump', false);
            this.bot.pathfinder?.stop();
            ai.stats.timesEscapedWater++;
            log('SURVIVAL', `[${this.bot.username}] 成功上岸!`);
            resolve();
          }
        }, 500);
      });
    } catch (e) {
      this.bot.setControlState('jump', false);
      this.bot.pathfinder?.stop();
    }
  }
}

// ==================== 战斗行为（主动索敌） ====================
class CombatBehavior {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.config = aiConfig;
    this.attacking = false;
    this.combatTick = 0;
  }

  canExecute(scanner) {
    if (!this.config.behaviors.pve?.enabled && !this.config.behaviors.pvp?.enabled) return false;
    
    // 快速扫描周围有没有敌人（只扫 8 格，快速检测）
    const pveConfig = this.config.behaviors.pve;
    const pvpConfig = this.config.behaviors.pvp;
    
    if (pvpConfig?.enabled) {
      const players = scanner.scanPlayers();
      for (const p of players) {
        if (p.distance <= (pvpConfig['attack-range'] || 4)) return true;
      }
    }
    
    if (pveConfig?.enabled) {
      const mobs = scanner.scanHostileMobs(pveConfig['hostile-mobs'] || []);
      for (const m of mobs) {
        if (m.distance <= (pveConfig['attack-range'] || 4)) return true;
      }
    }
    
    return false;
  }

  async execute(scanner, ai) {
    if (!this.bot.entity || this.bot.health <= 0) return;
    if (this.attacking) return;
    
    this.attacking = true;
    this.combatTick++;
    
    const pveConfig = this.config.behaviors.pve || {};
    const pvpConfig = this.config.behaviors.pvp || {};
    const fleeHealth = pveConfig['flee-health'] || 4;
    const attackRange = pveConfig['attack-range'] || 4;
    
    // 血量太低就逃跑
    if (this.bot.health <= fleeHealth) {
      log('COMBAT', `[${this.bot.username}] 血量过低 (${this.bot.health})，逃跑!`);
      this.flee();
      this.attacking = false;
      return;
    }

    // 找最近的敌人（玩家优先）
    let target = null;
    let targetDist = Infinity;
    let isPlayer = false;
    
    if (pvpConfig.enabled) {
      const players = scanner.scanPlayers();
      for (const p of players) {
        if (p.distance <= attackRange && p.distance < targetDist) {
          target = p.entity;
          targetDist = p.distance;
          isPlayer = true;
        }
      }
    }
    
    if (!target && pveConfig.enabled) {
      const mobs = scanner.scanHostileMobs(pveConfig['hostile-mobs'] || []);
      for (const m of mobs) {
        if (m.distance <= attackRange && m.distance < targetDist) {
          target = m.entity;
          targetDist = m.distance;
          isPlayer = false;
        }
      }
    }
    
    if (!target) {
      this.attacking = false;
      return;
    }

    const targetName = target.username || target.name || '未知';
    log('COMBAT', `[${this.bot.username}] 战斗: 攻击 ${targetName} 距离 ${targetDist.toFixed(1)}格`);

    try {
      // 装备武器
      const weaponPriority = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];
      for (const w of weaponPriority) {
        const weapon = this.bot.inventory.items().find(item => item.name === w);
        if (weapon) {
          await this.bot.equip(weapon, 'hand');
          break;
        }
      }

      // 面向目标并攻击
      this.bot.lookAt(target.position.offset(0, 1, 0));
      this.bot.attack(target);
      
      if (isPlayer) ai.stats.playersKilled++;
      else ai.stats.mobsKilled++;
    } catch (e) {}
    
    this.attacking = false;
  }

  flee() {
    const angle = Math.random() * Math.PI * 2;
    const fleeX = this.bot.entity.position.x + Math.cos(angle) * 20;
    const fleeZ = this.bot.entity.position.z + Math.sin(angle) * 20;
    try {
      this.bot.pathfinder.setGoal(new GoalXZ(fleeX, fleeZ));
      setTimeout(() => this.bot.pathfinder?.stop(), 5000);
    } catch (e) {}
  }
}

// ==================== 探索行为 ====================
class ExploreBehavior {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.config = aiConfig.behaviors.explore;
    this.lastWalkTime = 0;
  }

  canExecute() { return this.config.enabled; }

  async execute(scanner, ai) {
    if (!this.bot.entity || this.bot.health <= 0) return;
    
    const pos = this.bot.entity.position;
    if (!pos || isNaN(pos.x)) return;
    
    // 不要在水里探索
    if (scanner.isBotInWater() || scanner.isBotInLava()) return;
    
    const now = Date.now();
    const walkInterval = this.config['walk-interval'] || [5, 15];
    const interval = (walkInterval[0] + Math.random() * (walkInterval[1] - walkInterval[0])) * 1000;
    
    if (now - this.lastWalkTime < interval) return;
    this.lastWalkTime = now;

    const angle = Math.random() * Math.PI * 2;
    const distance = this.config['walk-distance'] || 20;
    const targetX = pos.x + Math.cos(angle) * distance;
    const targetZ = pos.z + Math.sin(angle) * distance;
    
    try {
      const targetBlock = this.bot.blockAt(new Vec3(Math.floor(targetX), Math.floor(pos.y), Math.floor(targetZ)));
      if (targetBlock && (targetBlock.name.includes('water') || targetBlock.name.includes('lava'))) return;
    } catch (e) { return; }

    log('AI', `[${this.bot.username}] 探索: 走向 (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`);
    
    try {
      this.bot.pathfinder.setGoal(new GoalXZ(targetX, targetZ));
      await new Promise(resolve => setTimeout(resolve, 8000));
      this.bot.pathfinder.stop();
      ai.stats.distanceTraveled += distance;
    } catch (e) {
      this.bot.pathfinder.stop();
    }
  }
}

// ==================== 砍树行为 ====================
class ChopWoodBehavior {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.config = aiConfig.behaviors['chop-wood'];
    this.logsChopped = 0;
  }

  canExecute() { return this.config.enabled && this.logsChopped < this.config.maxLogs; }

  async execute(scanner, ai) {
    if (!this.bot.entity || this.bot.health <= 0) return;
    
    const trees = scanner.scanTrees(this.config.treeTypes);
    if (trees.length === 0) return;

    const nearest = trees[0];
    if (nearest.distance > 16) return;

    log('AI', `[${this.bot.username}] 砍树: ${nearest.block.name} 距离 ${nearest.distance.toFixed(1)}格`);

    try {
      this.bot.pathfinder.setGoal(new GoalNear(nearest.position.x, nearest.position.y, nearest.position.z, 2));
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { this.bot.pathfinder.stop(); resolve(); }, 10000);
        this.bot.pathfinder.on('goal_reached', () => { clearTimeout(timeout); resolve(); });
        this.bot.pathfinder.on('error', () => { clearTimeout(timeout); resolve(); });
      });

      if (nearest.block && nearest.block.name.includes('log')) {
        await this.bot.dig(nearest.block);
        this.logsChopped++;
        ai.stats.logsChopped++;
        log('AI', `[${this.bot.username}] 砍树成功: ${this.logsChopped}/${this.config.maxLogs}`);
      }
    } catch (e) { this.bot.pathfinder.stop(); }
  }
}

// ==================== 挖矿行为 ====================
class MineBehavior {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.config = aiConfig.behaviors.mine;
    this.oresMined = 0;
    this.currentDepth = 0;
  }

  canExecute() { return this.config.enabled && this.oresMined < this.config.maxOres; }

  async execute(scanner, ai) {
    if (!this.bot.entity || this.bot.health <= 0) return;

    const ores = scanner.scanOres(this.config.oreTypes);
    
    if (ores.length > 0 && ores[0].distance <= 8) {
      const nearest = ores[0];
      log('AI', `[${this.bot.username}] 挖矿: ${nearest.block.name} 距离 ${nearest.distance.toFixed(1)}格`);

      try {
        this.bot.pathfinder.setGoal(new GoalNear(nearest.position.x, nearest.position.y, nearest.position.z, 1));
        await new Promise(resolve => {
          setTimeout(() => { this.bot.pathfinder.stop(); resolve(); }, 8000);
        });

        if (nearest.block) {
          await this.bot.dig(nearest.block);
          this.oresMined++;
          ai.stats.oresMined++;
          log('AI', `[${this.bot.username}] 挖矿成功: ${this.oresMined}/${this.config.maxOres}`);
        }
      } catch (e) { this.bot.pathfinder.stop(); }
    } else if (this.config.digDown && this.currentDepth < this.config.maxDepth) {
      const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (blockBelow && blockBelow.name !== 'bedrock' && blockBelow.name !== 'lava') {
        log('AI', `[${this.bot.username}] 向下挖掘: 深度 ${this.currentDepth}/${this.config.maxDepth}`);
        try { await this.bot.dig(blockBelow); this.currentDepth++; } catch (e) {}
      } else {
        this.currentDepth = 0;
      }
    }
  }
}

// ==================== 建造行为 ====================
class BuildBehavior {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.config = aiConfig.behaviors.build;
    this.building = false;
    this.buildProgress = 0;
  }

  canExecute() { return this.config.enabled && !this.building; }

  async execute(scanner, ai) {
    if (!this.bot.entity || this.bot.health <= 0) return;
    
    const buildItem = this.bot.inventory.items().find(item => item.name === this.config.buildMaterial);
    if (!buildItem) return;

    this.building = true;
    const size = this.config.houseSize;
    const height = this.config.wallHeight;
    const pos = this.bot.entity.position;
    
    log('AI', `[${this.bot.username}] 开始建造 ${size}x${height} 房子`);

    try {
      for (let x = 0; x < size; x++) {
        for (let z = 0; z < size; z++) {
          for (let y = 0; y < 2; y++) {
            const block = this.bot.blockAt(new Vec3(Math.floor(pos.x)+x, Math.floor(pos.y)-1+y, Math.floor(pos.z)+z));
            if (block && block.name !== 'air') { try { await this.bot.dig(block); } catch(e) {} }
          }
        }
      }

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < size; x++) {
          for (let z = 0; z < size; z++) {
            if (x === 0 || x === size-1 || z === 0 || z === size-1) {
              if (x === Math.floor(size/2) && z === 0 && y < 2) continue;
              const placePos = new Vec3(Math.floor(pos.x)+x, Math.floor(pos.y)+y, Math.floor(pos.z)+z);
              const block = this.bot.blockAt(placePos);
              if (block && block.name === 'air') {
                try {
                  const refBlock = this.bot.blockAt(placePos.offset(0, -1, 0));
                  if (refBlock) {
                    await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                    ai.stats.blocksPlaced++;
                    this.buildProgress++;
                  }
                } catch (e) {}
              }
            }
          }
        }
      }
      log('AI', `[${this.bot.username}] 建造完成! 放置了 ${this.buildProgress} 个方块`);
    } catch (e) { log('ERROR', `[${this.bot.username}] 建造出错: ${e.message}`); }
    
    this.building = false;
  }
}

// ==================== AI 管理器 ====================
class AIManager {
  constructor(bot, aiConfig) {
    this.bot = bot;
    this.aiConfig = aiConfig;
    this.stateMachine = new AIStateMachine(bot);
    this.scanner = new EnvironmentScanner(bot, aiConfig.scanRadius);
    
    // 行为模块
    this.waterEscape = new WaterEscapeBehavior(bot, aiConfig);
    this.combat = new CombatBehavior(bot, aiConfig);
    this.threatReactor = new ThreatReactor(bot, this, aiConfig);
    this.explore = new ExploreBehavior(bot, aiConfig);
    this.chopWood = new ChopWoodBehavior(bot, aiConfig);
    this.mine = new MineBehavior(bot, aiConfig);
    this.build = new BuildBehavior(bot, aiConfig);

    this.tickInterval = null;
    this.combatInterval = null;
  }

  start() {
    if (!this.aiConfig.enabled) return;
    log('AI', `[${this.bot.username}] AI 系统启动`);
    
    // 主决策循环（3秒一次）
    this.tickInterval = setInterval(() => this.tick(), this.aiConfig.tickInterval);
    
    // 战斗快速检测（1秒一次）
    this.combatInterval = setInterval(() => this.combatTick(), 1000);
    
    // 监听受伤事件 — 即时反应
    this.bot.on('healthChanged', () => {
      // 通过血量变化检测受伤
    });
    
    // 监听实体受伤（包括自己被打）
    this.bot.on('entityHurt', (entity) => {
      if (entity === this.bot.entity) {
        // 自己被打了，但不知道谁打的
        this.threatReactor.onHurt(0, null);
      }
    });

    // 监听攻击事件
    this.bot.on('entitySwingArm', (entity) => {
      // 检测附近实体挥臂（攻击动作）
    });
  }

  stop() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    if (this.combatInterval) { clearInterval(this.combatInterval); this.combatInterval = null; }
    this.bot.pathfinder?.stop();
  }

  // 快速战斗检测（1秒一次）
  combatTick() {
    if (this.bot.health <= 0) return;
    if (this.stateMachine.busy) return;
    
    // 水中逃生优先级最高
    if (this.waterEscape.canExecute(this.scanner)) {
      this.stateMachine.busy = true;
      this.waterEscape.execute(this.scanner, this.stateMachine).finally(() => {
        this.stateMachine.busy = false;
      });
      return;
    }
    
    // 战斗检测
    if (this.combat.canExecute(this.scanner)) {
      this.stateMachine.busy = true;
      this.combat.execute(this.scanner, this.stateMachine).finally(() => {
        this.stateMachine.busy = false;
      });
      return;
    }
  }

  // 主决策循环
  async tick() {
    if (this.bot.health <= 0) {
      this.stateMachine.setState('dead');
      return;
    }
    if (this.stateMachine.busy) return;

    // 水中逃生优先级最高
    if (this.waterEscape.canExecute(this.scanner)) {
      this.stateMachine.setState('water-escape');
      this.stateMachine.busy = true;
      await this.waterEscape.execute(this.scanner, this.stateMachine);
      this.stateMachine.busy = false;
      return;
    }

    // 战斗
    if (this.combat.canExecute(this.scanner)) {
      this.stateMachine.setState('combat');
      this.stateMachine.busy = true;
      await this.combat.execute(this.scanner, this.stateMachine);
      this.stateMachine.busy = false;
      return;
    }

    // 砍树
    if (this.chopWood.canExecute()) {
      this.stateMachine.setState('chop-wood');
      this.stateMachine.busy = true;
      await this.chopWood.execute(this.scanner, this.stateMachine);
      this.stateMachine.busy = false;
      return;
    }

    // 挖矿
    if (this.mine.canExecute()) {
      this.stateMachine.setState('mine');
      this.stateMachine.busy = true;
      await this.mine.execute(this.scanner, this.stateMachine);
      this.stateMachine.busy = false;
      return;
    }

    // 建造
    if (this.build.canExecute()) {
      this.stateMachine.setState('build');
      this.stateMachine.busy = true;
      await this.build.execute(this.scanner, this.stateMachine);
      this.stateMachine.busy = false;
      return;
    }

    // 探索
    if (this.explore.canExecute()) {
      this.stateMachine.setState('explore');
      this.stateMachine.busy = true;
      await this.explore.execute(this.scanner, this.stateMachine);
      this.stateMachine.busy = false;
    }
  }
}

// ==================== 原有功能 ====================

function generateRandomName() {
  if (config['bot-names'] && config['bot-names'].length > 0) {
    return config['bot-names'][Math.floor(Math.random() * config['bot-names'].length)];
  }
  const isEnglish = Math.random() < 0.5;
  let name;
  if (isEnglish) {
    name = fakerEN_US.person.firstName() + fakerEN_US.person.lastName();
  } else {
    const fullName = fakerZH_CN.person.lastName() + fakerZH_CN.person.firstName();
    name = pinyin(fullName, { toneType: 'none', type: 'array' }).join('');
  }
  if (Math.random() < 0.3) name += Math.floor(Math.random() * 100);
  if (name.length < 2) name += 'MC';
  if (name.length > 16) name = name.substring(0, 16);
  return name;
}

const botPasswords = {};
const botSpawnPos = {};

function generatePassword(botIndex) {
  if (botPasswords[botIndex]) return botPasswords[botIndex];
  const pattern = config['password-pattern'] || 'Bot_{uuid}';
  const uuid = Math.random().toString(36).substring(2, 10);
  const password = pattern.replace('{uuid}', uuid);
  botPasswords[botIndex] = password;
  return password;
}

function randomReconnectDelay() {
  const min = config.bot['reconnect-delay'].min * 1000;
  const max = config.bot['reconnect-delay'].max * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function executeActions(bot, actions, index = 0, origWrite = null) {
  if (index >= actions.length) {
    log('INFO', `[${bot.username}] 所有动作完成，启动 AI 系统`);
    if (bot.aiManager) bot.aiManager.start();
    return;
  }
  const action = actions[index];
  const value = typeof action.value === 'string'
    ? action.value.replace(/\{password\}/g, bot.password).replace(/\{name\}/g, bot.username)
    : action.value;
  switch (action.id) {
    case 'command':
      log('INFO', `[${bot.username}] 执行命令: /${value}`);
      bot.chat(`/${value}`);
      setTimeout(() => executeActions(bot, actions, index + 1, origWrite), 500);
      break;
    case 'chat':
      log('INFO', `[${bot.username}] 发送消息: ${value}`);
      bot.chat(value);
      setTimeout(() => executeActions(bot, actions, index + 1, origWrite), 500);
      break;
    case 'sleep':
      log('INFO', `[${bot.username}] 等待 ${value}ms`);
      setTimeout(() => executeActions(bot, actions, index + 1, origWrite), value);
      break;
    default:
      executeActions(bot, actions, index + 1, origWrite);
  }
}

function onSpawned(bot, botIndex, username, origWrite) {
  if (bot.entity) {
    botSpawnPos[botIndex] = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    log('INFO', `[${username}] 出生点: (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y}, ${bot.entity.position.z.toFixed(1)})`);
  }
  log('INFO', `[${username}] 等待3秒后开始执行动作...`);
  setTimeout(() => executeActions(bot, config.actions, 0, origWrite), 3000);
}

function createBot(botIndex, isReconnect = false) {
  const botNames = config['bot-names'] || [];
  const username = botNames[botIndex] || generateRandomName();
  const password = generatePassword(botIndex);
  
  log('INFO', `正在创建机器人 #${botIndex}: ${username}${isReconnect ? ' (重连)' : ''}`);
  
  const bot = mineflayer.createBot({
    host: config.server.address,
    port: config.server.port,
    username: username,
    version: config.version,
    auth: 'offline',
    autoRespawn: false,
    physics: true
  });
  
  bot.password = password;
  bot.botIndex = botIndex;
  bot.aliveOnce = false;
  
  const origWrite = bot._client.write.bind(bot._client);
  
  if (config.ai && config.ai.enabled) {
    bot.aiManager = new AIManager(bot, config.ai);
  }
  
  bot.on('message', (message) => {
    log('CHAT', `[${username}] 服务器消息: ${message.toString()}`);
  });
  
  bot.once('spawn', () => {
    log('INFO', `机器人 ${username} 已成功连接到服务器`);
    
    try {
      bot.loadPlugin(pathfinder.pathfinder);
      setTimeout(() => {
        if (bot.pathfinder) {
          const defaultMove = new Movements(bot);
          defaultMove.canDig = true;
          defaultMove.canPlaceOn = true;
          bot.pathfinder.setMovements(defaultMove);
          log('INFO', `[${username}] pathfinder 已加载`);
        }
      }, 500);
    } catch (e) {
      log('WARN', `[${username}] pathfinder 加载失败: ${e.message}`);
    }
    
    if (bot.health <= 0) {
      log('INFO', `[${username}] 处于死亡状态，自动复活`);
      origWrite('client_command', { actionId: 0 });
      bot.aliveOnce = true;
      setTimeout(() => onSpawned(bot, botIndex, username, origWrite), 1000);
    } else {
      bot.aliveOnce = true;
      onSpawned(bot, botIndex, username, origWrite);
    }
  });
  
  bot.on('end', () => {
    log('WARN', `机器人 ${username} 已掉线`);
    if (bot.aiManager) bot.aiManager.stop();
    const index = botList.indexOf(bot);
    if (index > -1) botList.splice(index, 1);
    const delay = randomReconnectDelay();
    log('INFO', `将在 ${(delay / 1000).toFixed(1)} 秒后重连机器人 #${botIndex} (${username})`);
    setTimeout(() => {
      if (botList.length < botNames.length) createBot(botIndex, true);
    }, delay);
  });
  
  bot.on('error', (err) => {
    log('ERROR', `机器人 ${username} 发生错误: ${err.message}`);
  });
  
  bot.on('kicked', (reason) => {
    log('WARN', `机器人 ${username} 被踢出: ${reason}`);
  });
  
  bot.on('death', () => {
    log('WARN', `机器人 ${username} 已死亡，不复活`);
    bot.autoRespawn = false;
  });
  
  // 监听自己被打
  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity && bot.aiManager) {
      bot.aiManager.threatReactor.onHurt(0, null);
    }
  });
  
  // 监听其他实体被打（检测谁在攻击我们）
  bot.on('entitySwingArm', (entity) => {
    if (entity !== bot.entity && bot.aiManager) {
      const dx = entity.position.x - bot.entity.position.x;
      const dy = entity.position.y - bot.entity.position.y;
      const dz = entity.position.z - bot.entity.position.z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dist <= 5) {
        // 附近有实体挥臂，可能是攻击者
        bot.aiManager.threatReactor.onHurt(0, entity);
      }
    }
  });
  
  bot._client.write = function(name, data) {
    if (name === 'client_command' && data && data.actionId === 0) {
      if (bot.aliveOnce) {
        log('INFO', `[${username}] 拦截自动复活命令`);
        return false;
      }
    }
    return origWrite(name, data);
  };
  
  botList.push(bot);
  return bot;
}

function startAllBots() {
  const botNames = config['bot-names'] || [];
  if (botNames.length === 0) {
    log('ERROR', 'bot-names 列表为空，请在 config.json 中配置机器人名字');
    return;
  }
  const maxBots = botNames.length;
  const interval = config.bot['join-interval'] || 30;
  log('INFO', `准备启动 ${maxBots} 个机器人，每个间隔 ${interval} 秒`);
  log('INFO', `服务器: ${config.server.address}:${config.server.port}`);
  log('INFO', `版本: ${config.version}`);
  log('INFO', `AI 系统: ${config.ai?.enabled ? '已启用' : '已禁用'}`);
  
  for (let i = 0; i < maxBots; i++) {
    const delay = i * interval;
    log('INFO', `机器人 #${i} (${botNames[i]}) 将在 ${delay} 秒后启动`);
    setTimeout(() => createBot(i), delay * 1000);
  }
}

process.on('SIGINT', () => {
  log('INFO', '正在关闭所有机器人...');
  botList.forEach(bot => { if (bot.aiManager) bot.aiManager.stop(); bot.quit(); });
  setTimeout(() => { log('INFO', '所有机器人已关闭'); process.exit(0); }, 2000);
});

startAllBots();
