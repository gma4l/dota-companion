'use strict';

/*
 * Разбор матча по правилам — без ИИ.
 * Возвращает наблюдения по матчу и по каждому игроку.
 */

const MIN = 60;

export function matchFindings(match) {
  const players = match.players || [];
  const duration = match.duration || 0;
  const minutes = Math.max(1, duration / MIN);
  const notes = [];

  if (duration && duration < 25 * MIN) notes.push('Короткая игра — меньше 25 минут.');
  if (duration > 60 * MIN) notes.push('Затяжная игра — больше часа.');

  const radiant = players.filter((p) => p.isRadiant);
  const dire = players.filter((p) => !p.isRadiant);
  const netWorth = (team) => team.reduce((sum, p) => sum + (p.net_worth || 0), 0);
  const diff = netWorth(radiant) - netWorth(dire);

  if (Math.abs(diff) > 40000) {
    const leader = diff > 0 ? 'Radiant' : 'Dire';
    notes.push(`Большой разрыв по нетворсу: ${leader} впереди на ${Math.round(Math.abs(diff) / 1000)}k.`);
  }

  const feeder = players.find((p) => p.deaths >= 12);
  if (feeder) notes.push(`Есть игрок с ${feeder.deaths} смертями — стоит посмотреть, где терялся темп.`);

  const noDeaths = players.find((p) => p.deaths === 0 && duration > 20 * MIN);
  if (noDeaths) notes.push('Один игрок прошёл матч без смертей.');

  return {
    notes,
    players: players.map((p) => ({
      slot: p.player_slot,
      heroId: p.hero_id,
      win: Boolean(p.win),
      isRadiant: Boolean(p.isRadiant),
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      assists: p.assists || 0,
      gpm: p.gold_per_min || 0,
      xpm: p.xp_per_min || 0,
      lastHits: p.last_hits || 0,
      denies: p.denies || 0,
      heroDamage: p.hero_damage || 0,
      netWorth: p.net_worth || 0,
      level: p.level || 0,
      findings: playerFindings(p, minutes),
    })),
  };
}

function playerFindings(p, minutes) {
  const out = [];
  const lhPerMin = (p.last_hits || 0) / minutes;

  if ((p.deaths || 0) >= 10) out.push(`много смертей (${p.deaths})`);
  if ((p.gold_per_min || 0) > 0 && p.gold_per_min < 300) out.push(`низкий GPM (${p.gold_per_min})`);
  if ((p.xp_per_min || 0) > 0 && p.xp_per_min < 400) out.push(`низкий XPM (${p.xp_per_min})`);
  if ((p.hero_damage || 0) > 0 && p.hero_damage < 8000) out.push(`мало урона по героям (${Math.round(p.hero_damage / 1000)}k)`);
  // Низкие добивания — проблема только для кора: у саппорта это норма.
  if ((p.gold_per_min || 0) >= 400 && (p.last_hits || 0) > 0 && lhPerMin < 3) {
    out.push(`мало добиваний для кора (${lhPerMin.toFixed(1)}/мин)`);
  }

  return out.slice(0, 3);
}

export function heroName(heroById, heroId) {
  const h = heroById && heroById[String(heroId)];
  return h ? h.localized_name : `Герой #${heroId}`;
}

export function heroSlug(heroById, heroId) {
  const h = heroById && heroById[String(heroId)];
  return h ? String(h.name).replace(/^npc_dota_hero_/, '') : null;
}

export function formatDuration(seconds) {
  const m = Math.floor((seconds || 0) / 60);
  const s = (seconds || 0) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
