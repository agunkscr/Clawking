// ═══════════════════════════════════════════════════════════════════
// strategy-clawking.js — Bot ClawKing v1.0
// ═══════════════════════════════════════════════════════════════════

// ── Weapon & item stats (ClawKing) ─────────────────────────────
const WEAPONS = {
    claw:    { bonus: 5,  range: 0 },
    knife:   { bonus: 10, range: 0 },
    spear:   { bonus: 20, range: 1 },
    trident: { bonus: 35, range: 1 },
    net:     { bonus: 15, range: 2 },
};

const ITEM_PRIORITY = {
    antidote: 100,   // anti racun penting
    shield:   90,
    powerup:  85,
    medkit:   70,
    bandage:  65,
    ...Object.fromEntries(Object.keys(WEAPONS).map(w => [w, 80])), // senjata skor 80
};

const RECOVERY = {
    medkit: 50,
    bandage: 30,
};

// Cuaca ClawKing (asumsi)
const WEATHER_PENALTY = {
    clear: 0.0,
    storm: 0.15,
    fog:   0.10,
};

// ── Global memory ─────────────────────────────────────────────
let gameId = null;
let combatHistory = { lastHp: 100, damageThisTick: false, lastAttackerId: '' };

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════ */
export function decideActions(view, canAct) {
    resetIfNewGame(view);
    const actions = [];

    // Free actions
    actions.push(...buildFreeActions(view));

    // Main action
    const main = decideMainAction(view, canAct);
    if (main) actions.push(main);

    return actions;
}

/* ── Free actions ───────────────────────────────────────────── */
function buildFreeActions(view) {
    const actions = [];
    const self = view.self || {};
    const inv = self.inventory || [];
    const regionId = (view.currentRegion || {}).id || '';

    const visibleItems = unwrapItems(view.visibleItems || []);
    const localItems = visibleItems.filter(i => i.regionId === regionId && i.id);

    // Pickup
    if (localItems.length) {
        localItems.sort((a, b) => pickupScore(b, inv) - pickupScore(a, inv));
        const best = localItems[0];
        if (pickupScore(best, inv) > 0) {
            if (inv.length >= 10) {
                const drop = findDroppable(inv, best);
                if (drop) actions.push({ action: 'drop_item', data: { itemId: drop.id }, reason: 'FREE DROP' });
            }
            actions.push({ action: 'pickup', data: { itemId: best.id }, reason: 'FREE PICKUP' });
        }
    }

    // Equip senjata terbaik
    const equipped = self.equippedWeapon;
    const currentBonus = getWeaponBonus(equipped);
    let bestWpn = null, bestBonus = currentBonus;
    for (const item of inv) {
        if (item.category === 'weapon') {
            const bonus = getWeaponBonus(item);
            if (bonus > bestBonus) { bestWpn = item; bestBonus = bonus; }
        }
    }
    if (bestWpn) actions.push({ action: 'equip', data: { itemId: bestWpn.id }, reason: 'FREE EQUIP' });

    return actions;
}

/* ── Main decision ──────────────────────────────────────────── */
function decideMainAction(view, canAct) {
    const self = view.self || {};
    const region = view.currentRegion || {};
    const hp = self.hp ?? 100;
    const ep = self.ep ?? 10;
    const atk = self.atk ?? 10;
    const def = self.def ?? 5;
    const isAlive = self.isAlive ?? true;
    const inv = self.inventory || [];
    const equipped = self.equippedWeapon;
    const myId = self.id || '';

    const visibleAgents = view.visibleAgents || [];
    const visibleMonsters = view.visibleMonsters || [];
    const connections = view.connectedRegions || region.connections || [];
    const pendingDZ = view.pendingDeathzones || [];
    const regionId = region.id || '';
    const terrain = (region.terrain || '').toLowerCase();
    const weather = (region.weather || '').toLowerCase();

    if (!isAlive) return null;

    // Danger zones (poison)
    const dangerIds = new Set();
    for (const dz of pendingDZ) dangerIds.add(typeof dz === 'string' ? dz : dz.id);
    for (const conn of connections) {
        const r = resolveRegion(conn, view);
        if (r?.isDeathZone) dangerIds.add(r.id);
    }

    updateCombatHistory(hp, view.recentLogs || [], myId);
    const moveEpCost = getMoveEpCost(terrain, weather);
    const enemies = visibleAgents.filter(a => !a.isGuardian && a.isAlive && a.id !== myId);

    // 1. Escape death zone
    if (region.isDeathZone || dangerIds.has(regionId)) {
        const safe = findSafeRegion(connections, dangerIds, view);
        if (safe && ep >= moveEpCost)
            return { action: 'move', data: { regionId: safe }, reason: 'DZ ESCAPE' };
    }

    // 2. Antidote jika dalam poison zone (atau region beracun)
    if (region.isPoisonZone || region.isDeathZone) { // asumsikan ada properti isPoisonZone
        const antidote = inv.find(i => i.typeId?.toLowerCase() === 'antidote');
        if (antidote)
            return { action: 'use_item', data: { itemId: antidote.id }, reason: 'ANTIDOTE' };
    }

    // 3. Desperate flee
    const hasHealing = inv.some(i => RECOVERY[i.typeId?.toLowerCase()] > 0);
    if (hp < 20 && !hasHealing && enemies.length) {
        const safe = findSafeRegion(connections, dangerIds, view);
        if (safe) return { action: 'move', data: { regionId: safe }, reason: 'DESPERATE FLEE' };
    }

    // 4. Counter-attack
    if (combatHistory.damageThisTick) {
        const attacker = findAttacker(combatHistory.lastAttackerId, visibleAgents);
        if (attacker) {
            const range = getWeaponRange(equipped);
            if (isInRange(attacker, regionId, range, connections)) {
                combatHistory.damageThisTick = false;
                return { action: 'attack', data: { targetId: attacker.id, targetType: 'agent' }, reason: 'COUNTER-ATTACK' };
            } else {
                const move = moveTowardTarget(attacker, connections, dangerIds, view);
                if (move) {
                    combatHistory.damageThisTick = false;
                    return { action: 'move', data: { regionId: move }, reason: 'CHASE ATTACKER' };
                }
            }
        }
    }

    if (!canAct) return null;

    // 5. Healing
    if (hp < 25) {
        const heal = findHealing(inv, true);
        if (heal) return { action: 'use_item', data: { itemId: heal.id }, reason: 'CRITICAL HEAL' };
    } else if (hp < 50) {
        const heal = findHealing(inv, false);
        if (heal) return { action: 'use_item', data: { itemId: heal.id }, reason: 'HEAL' };
    }

    // 6. Shield usage (jika ada dan HP < 50)
    const shield = inv.find(i => i.typeId?.toLowerCase() === 'shield');
    if (shield && hp < 50 && enemies.length) {
        return { action: 'use_item', data: { itemId: shield.id }, reason: 'SHIELD' };
    }

    // 7. PowerUp (level up) jika tersedia
    const powerup = inv.find(i => i.typeId?.toLowerCase() === 'powerup');
    if (powerup && hp >= 50 && enemies.length === 0) {
        return { action: 'use_item', data: { itemId: powerup.id }, reason: 'POWERUP' };
    }

    // 8. Combat (agent)
    if (enemies.length && ep >= 2 && hp >= 35) {
        const target = selectBestTarget(enemies, atk, equipped, def, weather);
        if (isInRange(target, regionId, getWeaponRange(equipped), connections)) {
            const myDmg = calcDamage(atk, getWeaponBonus(equipped), target.def || 5, weather);
            const eDmg = calcDamage(target.atk || 10, estimateWeaponBonus(target), def, weather);
            if (myDmg > eDmg || (target.hp || 100) <= myDmg * 2.5)
                return { action: 'attack', data: { targetId: target.id, targetType: 'agent' }, reason: 'COMBAT' };
        } else {
            const move = moveTowardTarget(target, connections, dangerIds, view);
            if (move && ep >= moveEpCost)
                return { action: 'move', data: { regionId: move }, reason: 'CHASE' };
        }
    }

    // 9. Monster farming
    const monsters = visibleMonsters.filter(m => m.hp > 0);
    if (monsters.length && ep >= 2 && hp >= 25) {
        const target = selectBestTarget(monsters, atk, equipped, def, weather);
        if (isInRange(target, regionId, getWeaponRange(equipped), connections))
            return { action: 'attack', data: { targetId: target.id, targetType: 'monster' }, reason: 'MONSTER FARM' };
    }

    // 10. Explore (movement scoring sederhana)
    if (ep >= moveEpCost && connections.length) {
        const target = chooseMoveTarget(connections, dangerIds, region, enemies);
        if (target) return { action: 'move', data: { regionId: target }, reason: 'EXPLORE' };
    }

    // 11. Rest
    if (ep < 3 && !enemies.length && !region.isDeathZone && !dangerIds.has(regionId))
        return { action: 'rest', data: {}, reason: 'REST' };

    return null;
}

// ── Helper functions (sama seperti strategy.js Molty Royale, disesuaikan) ──
function calcDamage(atk, weaponBonus, def, weather) {
    const base = atk + weaponBonus - Math.floor(def * 0.5);
    const penalty = WEATHER_PENALTY[weather] || 0;
    return Math.max(1, Math.floor(base * (1 - penalty)));
}
function getWeaponBonus(item) {
    if (!item) return 0;
    const typeId = (item.typeId || '').toLowerCase();
    return WEAPONS[typeId]?.bonus || 0;
}
function getWeaponRange(item) {
    if (!item) return 0;
    const typeId = (item.typeId || '').toLowerCase();
    return WEAPONS[typeId]?.range || 0;
}
function estimateWeaponBonus(agent) {
    const weapon = agent?.equippedWeapon;
    if (!weapon) return 0;
    const typeId = (typeof weapon === 'string' ? weapon : weapon.typeId || '').toLowerCase();
    return WEAPONS[typeId]?.bonus || 0;
}
function selectBestTarget(targets, myAtk, equipped, myDef, weather) {
    let best = null, bestScore = -Infinity;
    const myBonus = getWeaponBonus(equipped);
    for (const t of targets) {
        const tHp = Math.max(t.hp || 100, 1);
        const myDmg = calcDamage(myAtk, myBonus, t.def || 5, weather);
        const theirDmg = calcDamage(t.atk || 10, estimateWeaponBonus(t), myDef, weather);
        const score = (myDmg / tHp) * 100 - theirDmg * 0.5;
        if (score > bestScore) { bestScore = score; best = t; }
    }
    return best || targets[0];
}
function findAttacker(attackerId, visibleAgents) {
    if (!attackerId || attackerId === 'unknown') return null;
    return visibleAgents.find(a => a.id === attackerId && a.isAlive) || null;
}

// ── World model helpers ──────────────────────────────────────
function getMoveEpCost(terrain, weather) {
    // ClawKing mungkin punya terrain berbeda, tapi kita buat umum
    return (terrain === 'water' || weather === 'storm') ? 3 : 2;
}
function resolveRegion(entry, view) {
    if (typeof entry === 'object') return entry;
    if (typeof entry === 'string')
        return (view.visibleRegions || []).find(r => r.id === entry) || null;
    return null;
}
function findSafeRegion(connections, dangerIds, view) {
    for (const conn of connections) {
        const rid = typeof conn === 'string' ? conn : conn.id;
        const resolved = typeof conn === 'object' ? conn : resolveRegion(conn, view);
        if (rid && !dangerIds.has(rid) && !resolved?.isDeathZone) return rid;
    }
    return null;
}
function isInRange(target, myRegion, weaponRange, connections) {
    const tr = target?.regionId;
    if (!tr || tr === myRegion) return true;
    if (weaponRange >= 1 && connections) {
        const adj = new Set(connections.map(c => typeof c === 'string' ? c : c.id));
        return adj.has(tr);
    }
    return false;
}
function moveTowardTarget(target, connections, dangerIds, view) {
    const tr = target?.regionId;
    if (!tr) return null;
    for (const conn of connections) {
        const rid = typeof conn === 'string' ? conn : conn.id;
        if (rid === tr && !dangerIds.has(rid) && !(typeof conn === 'object' && conn.isDeathZone)) return rid;
    }
    return findSafeRegion(connections, dangerIds, view);
}
function chooseMoveTarget(connections, dangerIds, region, enemies) {
    const enemyRegions = new Set((enemies || []).map(e => e.regionId));
    const candidates = [];
    for (const conn of connections) {
        const rid = typeof conn === 'string' ? conn : conn.id;
        const resolved = typeof conn === 'object' ? conn : null;
        if (!rid || dangerIds.has(rid) || resolved?.isDeathZone) continue;
        let score = 1;
        // Prefer region dengan musuh agar bisa combat
        if (enemyRegions.has(rid)) score += 5;
        candidates.push({ rid, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.rid || null;
}

// ── Inventory helpers ────────────────────────────────────────
function unwrapItems(raw) {
    const out = [];
    for (const entry of (raw || [])) {
        if (!entry || typeof entry !== 'object') continue;
        const inner = entry.item || entry;
        if (inner && typeof inner === 'object') {
            inner.regionId = entry.regionId || inner.regionId || '';
            out.push(inner);
        }
    }
    return out;
}
function pickupScore(item, inventory) {
    const typeId = (item.typeId || '').toLowerCase();
    if (typeId === 'rewards') return 1000; // prioritas tinggi
    if (item.category === 'weapon') {
        const bonus = getWeaponBonus(item);
        const currentBest = Math.max(0, ...inventory.filter(i => i.category === 'weapon').map(i => getWeaponBonus(i)));
        return bonus > currentBest ? 100 + bonus : 0;
    }
    return ITEM_PRIORITY[typeId] || 0;
}
function findDroppable(inventory, targetItem) {
    const targetScore = ITEM_PRIORITY[(targetItem.typeId || '').toLowerCase()] || 1;
    const candidates = inventory
        .filter(i => i.category?.toLowerCase() !== 'currency')
        .map(i => ({ item: i, score: ITEM_PRIORITY[(i.typeId || '').toLowerCase()] || 0 }));
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0]?.item || null;
}
function findHealing(inventory, critical = false) {
    const heals = inventory.filter(i => RECOVERY[i.typeId?.toLowerCase()] > 0);
    if (!heals.length) return null;
    heals.sort((a, b) => (RECOVERY[b.typeId?.toLowerCase()] || 0) - (RECOVERY[a.typeId?.toLowerCase()] || 0));
    return heals[0];
}

// ── Memory & tracking ────────────────────────────────────────
function resetIfNewGame(view) {
    const newId = view.gameId || '';
    if (newId && newId !== gameId) {
        gameId = newId;
        combatHistory = { lastHp: 100, damageThisTick: false, lastAttackerId: '' };
    }
}
function updateCombatHistory(currentHp, logs, myId) {
    const last = combatHistory.lastHp ?? currentHp;
    if (currentHp < last) {
        combatHistory.damageThisTick = true;
        for (const entry of logs) {
            if ((entry.message || '').toLowerCase().includes('damage')) {
                const aid = entry.attackerId || entry.sourceId || '';
                const tid = entry.targetId || '';
                if (tid === myId && aid && aid !== myId) {
                    combatHistory.lastAttackerId = aid;
                    return;
                }
            }
        }
        combatHistory.lastAttackerId = 'unknown';
    } else {
        combatHistory.damageThisTick = false;
    }
    combatHistory.lastHp = currentHp;
}