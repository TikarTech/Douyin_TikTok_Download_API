'use strict';

/* =======================================================================
   AlwaysDialog — Telegram Business-бот (автоматизация чата)
   Cloudflare Worker, один файл (worker.js)

   Как это работает:
     • Бот подключается к аккаунту через Telegram Business → Чат-боты
     • В любой личке, где включена автоматизация, бот видит сообщения
       (business_message) и отправляет ответы ОТ ИМЕНИ владельца аккаунта
       (sendMessage с business_connection_id)
     • Команды с точкой пишет владелец: .wordle, .love, .spam и т.д.
     • Ответ на сообщение с игрой вводит ход (например, слово в wordle)

   env:
     BOT_TOKEN        — токен бота (secret)
     KV               — KV namespace (обязателен для стабильной работы)
     WEBHOOK_SECRET   — secret_token Telegram (необязательно)
     SETUP_SECRET     — пароль для /?set=... (необязательно)

   Требуется: @BotFather → Bot Settings → Business Mode → Turn on
   ======================================================================= */

const MEM = new Map();
const MAXLEN = 4000;

/* ------------------------------- Telegram ------------------------------ */

function apiRoot(env) {
  return 'https://api.telegram.org/bot' + env.BOT_TOKEN;
}

async function api(env, method, payload, files) {
  payload = payload || {};
  const url = apiRoot(env) + '/' + method;
  let init;
  if (files) {
    const fd = new FormData();
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    for (const k of Object.keys(files)) {
      const f = files[k];
      fd.append(k, f.blob, f.name);
    }
    init = { method: 'POST', body: fd };
  } else {
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
  try {
    const res = await fetch(url, init);
    return await res.json();
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

/* --------------------------------- KV ---------------------------------- */

async function kvGet(env, key) {
  if (env.KV) {
    const raw = await env.KV.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  return MEM.has(key) ? MEM.get(key) : null;
}

async function kvSet(env, key, value, ttl) {
  if (env.KV) {
    const opts = ttl ? { expirationTtl: Math.max(60, ttl) } : undefined;
    await env.KV.put(key, JSON.stringify(value), opts);
    return;
  }
  MEM.set(key, value);
}

async function kvDel(env, key) {
  if (env.KV) {
    await env.KV.delete(key);
    return;
  }
  MEM.delete(key);
}

/* -------------------------------- utils -------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const esc = (s) =>
  String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function maskId(id) {
  const s = String(id);
  if (s.length < 6) return s;
  return s.slice(0, 3) + '•••' + s.slice(-2);
}

function mskTime() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date());
}

function humanDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${sec} с`;
  return `${sec} с`;
}

/* ------------------------------ text magic ----------------------------- */

const LEET = {
  а: 'a', б: '6', в: 'B', г: 'r', д: 'd', е: 'e', ж: 'ж', з: '3', и: 'u',
  й: 'u', к: 'k', л: 'JI', м: 'M', н: 'H', о: '0', п: 'n', р: 'p', с: 'c',
  т: 'T', у: 'y', ф: 'f', х: 'x', ц: 'u', ч: '4', ш: 'w', щ: 'w', ъ: 'b',
  ы: 'bl', ь: 'b', э: 'e', ю: 'io', я: 'R',
};

function zalgo(s) {
  const marks = ['\u0300', '\u0301', '\u0302', '\u0303', '\u0308', '\u030A', '\u0327', '\u034F'];
  let out = '';
  for (const ch of s) {
    out += ch;
    if (Math.random() < 0.7) out += pick(marks);
    if (Math.random() < 0.3) out += pick(marks);
  }
  return out;
}

function leetify(s) {
  return s
    .split('')
    .map((ch) => {
      const low = ch.toLowerCase();
      const rep = LEET[low];
      if (!rep) return ch;
      return ch === low ? rep : rep.toUpperCase();
    })
    .join('');
}

function kawaiify(s) {
  const face = pick(['(｡•‿•｡)', '(◕‿◕✿)', '(๑˃ᴗ˂)ﻭ', '(๑>ᴗ<๑)', '(づ｡◕‿‿◕｡)づ']);
  return '✨ ' + s + ' ' + face + ' ✨';
}

/* ------------------------------- send API ------------------------------ */

function bizWrap(biz, payload) {
  if (biz) payload.business_connection_id = biz;
  return payload;
}

function sendIn(env, biz, chatId, text, extra) {
  return api(env, 'sendMessage', bizWrap(biz, Object.assign(
    {
      chat_id: chatId,
      text: cut(text, MAXLEN),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
    extra || {}
  )));
}

function editIn(env, biz, chatId, messageId, text, extra) {
  return api(env, 'editMessageText', bizWrap(biz, Object.assign(
    {
      chat_id: chatId,
      message_id: messageId,
      text: cut(text, MAXLEN),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
    extra || {}
  )));
}

function rawSendIn(env, biz, chatId, text, extra) {
  return api(env, 'sendMessage', bizWrap(biz, Object.assign(
    { chat_id: chatId, text: cut(text, MAXLEN) },
    extra || {}
  )));
}

function rawEditIn(env, biz, chatId, messageId, text, extra) {
  return api(env, 'editMessageText', bizWrap(biz, Object.assign(
    { chat_id: chatId, message_id: messageId, text: cut(text, MAXLEN) },
    extra || {}
  )));
}

function copyIn(env, biz, chatId, fromChatId, messageId) {
  return api(env, 'copyMessage', bizWrap(biz, {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  }));
}

function actionIn(env, biz, chatId, action) {
  return api(env, 'sendChatAction', bizWrap(biz, { chat_id: chatId, action }));
}

async function tryDelete(env, biz, chatId, messageId) {
  if (!messageId) return;
  try {
    await api(env, 'deleteMessage', bizWrap(biz, { chat_id: chatId, message_id: messageId }));
  } catch (_) {}
}

async function animate(env, biz, chatId, frames, delay, extra) {
  const first = await rawSendIn(env, biz, chatId, frames[0], extra);
  const id = first && first.result && first.result.message_id;
  if (!id) return;
  for (let i = 1; i < frames.length; i++) {
    await sleep(delay);
    await rawEditIn(env, biz, chatId, id, frames[i], extra);
  }
}

/* ------------------------------ chat state ----------------------------- */

const DEF_STATS = () => ({
  msgs: 0,
  chars: 0,
  photos: 0,
  voices: 0,
  stickers: 0,
  games: 0,
  wins: 0,
});

function DEF_CHAT() {
  return {
    id: 0,
    mutedUntil: 0,
    nomute: false,
    afk: false,
    afkText: '',
    kawai: false,
    troll: '',
    since: 0,
    peer: null,
    stats: DEF_STATS(),
    typing: { on: false, action: 'auto', token: '', until: 0 },
    lastBotMsg: 0,
    lastBotText: '',
  };
}

function normalizeChat(raw, id) {
  const c = Object.assign(DEF_CHAT(), raw || {});
  c.stats = Object.assign(DEF_STATS(), (raw && raw.stats) || {});
  c.typing = Object.assign({ on: false, action: 'auto', token: '', until: 0 }, (raw && raw.typing) || {});
  if (id) c.id = id;
  return c;
}

async function getChat(env, chatId) {
  return normalizeChat(await kvGet(env, 'c:' + chatId), chatId);
}

async function saveChat(env, c) {
  await kvSet(env, 'c:' + c.id, c);
}

/* ----------------------------- connections ----------------------------- */

async function getConn(env, connId) {
  if (!connId) return null;
  let conn = await kvGet(env, 'conn:' + connId);
  if (!conn) {
    const r = await api(env, 'getBusinessConnection', { business_connection_id: connId });
    if (r && r.ok && r.result) {
      conn = r.result;
      await kvSet(env, 'conn:' + connId, conn);
    }
  }
  return conn;
}

async function saveConn(env, conn) {
  if (!conn || !conn.id) return;
  await kvSet(env, 'conn:' + conn.id, conn);
  if (conn.user && conn.user.id) {
    await kvSet(env, 'ownerconn:' + conn.user.id, conn.id);
  }
}

/* -------------------------------- context ------------------------------ */

function makeCtx(env, chatId, biz, ownerId, isOwner, chat, msg, args, text, origin) {
  const ctx = {
    env,
    chatId,
    biz,
    ownerId,
    isOwner,
    chat,
    msg,
    args,
    text,
    origin: origin || '',
    reply(t, extra) {
      return sendIn(env, biz, chatId, t, extra).then((r) => {
        const id = r && r.result && r.result.message_id;
        if (id) {
          chat.lastBotMsg = id;
          chat.lastBotText = t;
        }
        return r;
      });
    },
    raw(t, extra) {
      return rawSendIn(env, biz, chatId, t, extra);
    },
    edit(messageId, t, extra) {
      return editIn(env, biz, chatId, messageId, t, extra);
    },
    copy(messageId) {
      return copyIn(env, biz, chatId, chatId, messageId);
    },
    action(a) {
      return actionIn(env, biz, chatId, a);
    },
  };
  return ctx;
}

/* -------------------------------- help --------------------------------- */

const HELP_TEXT = [
  '✏️ <b>Команды AlwaysDialog</b>',
  '',
  'Пиши команду прямо в личке — бот выполнит её от твоего имени, а команду удалит.',
  '',
  '🔒 <code>.mute [минуты]</code> — не отслеживать сообщения собеседника',
  '🔓 <code>.unmute</code> — снять мут',
  '📷 <code>.nomute</code> — обход мута (вкл/выкл)',
  '❤️ <code>.love</code> — анимация сердечек',
  '✈️ <code>.spam [n] [текст]</code> — отправить текст n раз (до 50)',
  '🔃 <code>.spek</code> — переливать последнее сообщение бота',
  '🏹 <code>.zero</code> — крестики-нолики',
  '📈 <code>.status</code> — статистика чата',
  '❗ <code>.info</code> — информация о собеседнике',
  '🚀 <code>.troll | .troll send [текст]</code> — троллинг-сообщение',
  '⌛ <code>.afk [текст]</code> — автоответ в этом чате',
  '📱 <code>.бурмалда</code> — секретная бурмалда',
  '⭕ <code>.crash</code> — «краш» собеседника',
  '🪙 <code>.flip</code> — монетка',
  '🪨 <code>.rps</code> — камень-ножницы-бумага',
  '📃 <code>.anim [текст]</code> — анимация сообщения',
  '📸 <code>.save [ссылка]</code> — скачать видео (TikTok/прямые ссылки)',
  '🔗 Любая ссылка на видео в сообщении → кнопка «Скачать»',
  '⭕ <code>.krom</code> — кружок из видео (ответом)',
  '📋 <code>.voicemod</code> — голосовой мод (ответом)',
  '💸 <code>.niks</code> — время МСК',
  '💰 <code>.stik</code> — стикер из фото (ответом)',
  '🔄 <code>.kawai</code> — аниме-стиль (вкл/выкл)',
  '📃 <code>.mon</code> — Tbl Kрyt0i?',
  '🏡 <code>.clone</code> — клон профиля собеседника',
  '➕ <code>.gif</code> — фото/видео в GIF (ответом)',
  '📲 <code>.story</code> — оформление профиля из фото (ответом)',
  '👁 <code>.type [режим]</code> — эмуляция активности до выключения',
  '📃 <code>.wordle</code> — угадай слово (ответом на сообщение)',
  '🆔 <code>.id</code> — id чата и собеседника',
  '',
  '┄┄┄',
  'Игры: команда создаёт сообщение, а твой <b>ответ</b> на него — это ход.',
  'Wordle: ответь словом из 5 букв. Крестики-нолики: жми кнопки.',
].join('\n');

/* ------------------------------- команды ------------------------------- */

async function cmdStart(ctx) {
  const hello =
    '👋 <b>AlwaysDialog</b>\n\n' +
    'Это бот для автоматизации личных чатов через <b>Telegram Business</b>.\n\n' +
    '<b>Как подключить:</b>\n' +
    '1. @BotFather → /mybots → твой бот → Bot Settings → <b>Business Mode</b> → Turn on\n' +
    '2. Telegram → Настройки → <b>Telegram Business</b> → Чат-боты → добавить этого бота\n' +
    '3. Включи автоматизацию для нужных чатов\n\n' +
    'После этого пиши в любой личке <code>.wordle</code>, <code>.love</code>, <code>.help</code> — ' +
    'бот выполнит команду от твоего имени и удалит её из чата.\n\n' +
    (ctx.biz
      ? '🟢 Этот чат уже под автоматизацией.'
      : '⚪ Сейчас ты в личке с ботом — тут команды работают как песочница.');
  await ctx.reply(hello);
}

async function cmdHelp(ctx) {
  await ctx.reply(HELP_TEXT);
}

async function cmdId(ctx) {
  const peer = ctx.chat.peer;
  await ctx.reply(
    '🆔 <b>Чат:</b> <code>' + ctx.chatId + '</code>\n' +
    '🆔 <b>Владелец:</b> <code>' + (ctx.ownerId || '—') + '</code>\n' +
    (peer
      ? '👤 <b>Собеседник:</b> <code>' + maskId(peer.id) + '</code>' + (peer.username ? ' · @' + esc(peer.username) : '')
      : '👤 Собеседник пока не писал.') +
    '\n🔌 Business connection: <code>' + esc(ctx.biz || 'нет') + '</code>'
  );
}

async function cmdMute(ctx) {
  const minutes = Math.min(1440, Math.max(1, parseInt(ctx.args[0], 10) || 5));
  ctx.chat.mutedUntil = Date.now() + minutes * 60000;
  ctx.chat.nomute = false;
  await saveChat(ctx.env, ctx.chat);
  await ctx.reply('🔒 Мут на <b>' + minutes + ' мин</b>. Сообщения собеседника не отслеживаются.');
}

async function cmdUnmute(ctx) {
  ctx.chat.mutedUntil = 0;
  await saveChat(ctx.env, ctx.chat);
  await ctx.reply('🔓 Мут снят.');
}

async function cmdNomute(ctx) {
  ctx.chat.nomute = !ctx.chat.nomute;
  await saveChat(ctx.env, ctx.chat);
  await ctx.reply(
    ctx.chat.nomute
      ? '📷 Обход мута <b>включён</b>. Бот снова отслеживает сообщения.'
      : '📷 Обход мута <b>выключен</b>.'
  );
}

async function cmdLove(ctx) {
  const frames = [
    '❤️',
    '❤️❤️',
    '❤️🧡',
    '❤️🧡💛',
    '❤️🧡💛💚',
    '❤️🧡💛💚💙',
    '❤️🧡💛💚💙💜',
    '‎  ❤️  ❤️\n ❤️❤️❤️❤️\n  ❤️❤️❤️\n   ❤️❤️\n    ❤️',
    '‎❣️  l o v e  ❣️',
  ];
  await animate(ctx.env, ctx.biz, ctx.chatId, frames, 650);
}

async function cmdSpam(ctx) {
  const n = Math.min(50, Math.max(1, parseInt(ctx.args[0], 10) || 3));
  const raw = ctx.args.slice(1).join(' ') || '👋';
  const text = ctx.chat.kawai ? kawaiify(raw) : raw;
  const total = Math.min(n, 25);
  for (let i = 0; i < total; i++) {
    await sendIn(ctx.env, ctx.biz, ctx.chatId, esc(text));
    await sleep(120);
  }
}

async function cmdSpek(ctx) {
  const { env, chat } = ctx;
  if (!chat.lastBotMsg) return ctx.reply('Нечего переливать — сначала отправь что-нибудь ботом.');
  const base = chat.lastBotText || '👁';
  const zw = ['\u200b', '\u200c', '\u200d', '\u2060', '\u180e'];
  const marks = ['•', '·', '∘', '○', '◌', '⠂'];
  for (let i = 0; i < 12; i++) {
    const noise = i % 3 === 0 ? pick(marks) + ' ' : '';
    const flavor = pick(zw).repeat(rnd(0, 4));
    await rawEditIn(env, ctx.biz, ctx.chatId, chat.lastBotMsg, noise + base + flavor);
    await sleep(420);
  }
  await rawEditIn(env, ctx.biz, ctx.chatId, chat.lastBotMsg, base);
}

function zeroKeyboard(board, done) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const v = board[i];
      row.push({
        text: v === 'X' ? '❌' : v === 'O' ? '⭕' : done ? '⬜' : '·',
        callback_data: done ? 'noop' : 'z:' + i,
      });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

const ZERO_WINS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function zeroWinner(b) {
  for (const line of ZERO_WINS) {
    const [a, c, d] = line;
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  }
  return b.every(Boolean) ? 'D' : null;
}

function zeroRender(status) {
  return '🏹 <b>Крестики-нолики</b>\nТы — ❌, бот — ⭕\n' + (status ? '\n' + status : '');
}

async function botZeroMove(board) {
  const empty = board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!empty.length) return;
  for (const i of empty) {
    const t = board.slice();
    t[i] = 'O';
    if (zeroWinner(t) === 'O') { board[i] = 'O'; return; }
  }
  for (const i of empty) {
    const t = board.slice();
    t[i] = 'X';
    if (zeroWinner(t) === 'X') { board[i] = 'O'; return; }
  }
  if (!board[4]) { board[4] = 'O'; return; }
  const corners = [0, 2, 6, 8].filter((i) => !board[i]);
  if (corners.length && Math.random() < 0.7) { board[pick(corners)] = 'O'; return; }
  board[pick(empty)] = 'O';
}

async function cmdZero(ctx) {
  const board = new Array(9).fill(null);
  const sent = await ctx.reply(zeroRender(''), { reply_markup: zeroKeyboard(board, false) });
  const msgId = sent && sent.result && sent.result.message_id;
  if (!msgId) return;
  await kvSet(ctx.env, 'zg:' + ctx.chatId + ':' + msgId, { board, done: false }, 86400);
}

async function cmdStatus(ctx) {
  const c = ctx.chat;
  const s = c.stats || DEF_STATS();
  const peer = c.peer;
  let text = '📈 <b>Статистика чата</b>\n\n';
  text += '🕒 Наблюдаю с: <b>' + (c.since ? new Date(c.since).toLocaleString('ru-RU') : 'только что') + '</b>\n';
  text += '💬 Сообщений: <b>' + s.msgs + '</b> · символов: <b>' + s.chars + '</b>\n';
  text += '🖼 Фото: ' + s.photos + ' · 🎙 Голосовых: ' + s.voices + ' · 🎨 Стикеров: ' + s.stickers + '\n';
  text += '🎮 Игр: ' + s.games + ' (побед ' + s.wins + ')\n';
  if (peer) {
    text += '\n👤 Собеседник: <b>' + esc(peer.first || 'скрыт') + '</b> (<code>' + maskId(peer.id) + '</code>)\n';
    text += '🕒 Активность: ' + (peer.seen && Date.now() - peer.seen < 120000 ? '🟢 сейчас' : '⚪ ' + (peer.seen ? new Date(peer.seen).toLocaleString('ru-RU') : 'давно')) + '\n';
  }
  const muted = c.mutedUntil > Date.now() ? '🔒 мут ' + Math.ceil((c.mutedUntil - Date.now()) / 60000) + ' мин' : '🔊 без мута';
  text += '\n' + muted + (c.nomute ? ' · 📷 обход' : '') + (c.kawai ? ' · ✨ kawai' : '') + (c.afk ? ' · ⌛ AFK' : '');
  await ctx.reply(text);
}

async function cmdInfo(ctx) {
  const peer = ctx.chat.peer;
  if (!peer) return ctx.reply('❗ Собеседник ещё не писал — нечего показывать.');
  const initials = ((peer.first || '?')[0] + ((peer.last || '')[0] || '')).toUpperCase();
  await ctx.reply([
    '❗ <b>Информация о собеседнике</b>',
    '',
    '👤 Имя: <b>' + esc(peer.first || 'скрыто') + (peer.last ? ' ' + esc(peer.last[0]) + '.' : '') + '</b>',
    '🔗 Юзернейм: ' + (peer.username ? '@' + esc(peer.username) : 'скрыт'),
    '🆔 id: <code>' + maskId(peer.id) + '</code>',
    '🌐 Язык: ' + esc((peer.lang || '—').toUpperCase()),
    '💎 Premium: ' + (peer.premium ? 'да' : 'нет'),
    '🔤 Инициалы: <b>' + esc(initials) + '</b>',
    '💬 Сообщений в чате: <b>' + (ctx.chat.stats.msgs || 0) + '</b>',
  ].join('\n'));
}

const TROLLS = [
  'Я тебя вычислил по IP. Жди.',
  'Твой интернет — это два стакана и верёвка.',
  'Ты печатаешь быстрее, чем думаешь. Это не комплимент.',
  'Я уже скачал твой профиль. Он весит 3 кб.',
  'Собеседник года. Премия — тишина.',
  'Ты как обновление Windows: не вовремя и без спроса.',
  'Мне кажется, ты бот. И я прав.',
];

async function cmdTroll(ctx) {
  const mode = (ctx.args[0] || '').toLowerCase();
  if (mode === 'send' || mode === 'set') {
    const custom = ctx.args.slice(1).join(' ').trim();
    if (!custom) return ctx.reply('Напиши текст: <code>.troll send привет</code>');
    ctx.chat.troll = custom;
    await saveChat(ctx.env, ctx.chat);
    return ctx.reply('🚀 ' + esc(ctx.chat.kawai ? kawaiify(custom) : custom));
  }
  const out = ctx.chat.troll || pick(TROLLS);
  await ctx.reply('🚀 ' + esc(ctx.chat.kawai ? kawaiify(out) : out));
}

async function cmdAfk(ctx) {
  const c = ctx.chat;
  const custom = ctx.args.join(' ').trim();
  if (custom) {
    c.afk = true;
    c.afkText = custom;
  } else {
    c.afk = !c.afk;
    if (c.afk && !c.afkText) c.afkText = 'Отошёл, вернусь позже 💤';
  }
  await saveChat(ctx.env, c);
  await ctx.reply(c.afk ? '⌛ AFK включён: «' + esc(c.afkText) + '»' : '⌛ AFK выключен.');
}

async function cmdBurmalda(ctx) {
  const frames = [
    '📱',
    '📱 б',
    '📱 бу',
    '📱 бур',
    '📱 бурм',
    '📱 бурма',
    '📱 бурмал',
    '📱 бурмалд',
    '📱 бурмалда',
    '🐹 БУРМАЛДА 🐹\n\n ╭( ͡° ͜ʖ ͡°)╮\n ╰────────╯',
  ];
  await animate(ctx.env, ctx.biz, ctx.chatId, frames, 260);
}

async function cmdCrash(ctx) {
  const chunks = [
    '⭕'.repeat(300),
    zalgo('Твой телефон сейчас задумается о жизни'),
    '▄︻デ═══一 '.repeat(60),
    '🌀'.repeat(200),
  ];
  for (const c of chunks) {
    await rawSendIn(ctx.env, ctx.biz, ctx.chatId, c);
    await sleep(150);
  }
}

async function cmdFlip(ctx) {
  const frames = ['🪙', '🪙 орёл...', '🪙 решка...', '🪙 орёл...', '🪙 решка...'];
  const first = await rawSendIn(ctx.env, ctx.biz, ctx.chatId, frames[0]);
  const id = first && first.result && first.result.message_id;
  if (!id) return;
  for (let i = 1; i < frames.length; i++) {
    await sleep(320);
    await rawEditIn(ctx.env, ctx.biz, ctx.chatId, id, frames[i]);
  }
  await editIn(ctx.env, ctx.biz, ctx.chatId, id, Math.random() < 0.5 ? '🦅 <b>Орёл!</b>' : '🪙 <b>Решка!</b>');
}

function rpsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🪨 Камень', callback_data: 'rps:r' },
        { text: '✂️ Ножницы', callback_data: 'rps:s' },
        { text: '📄 Бумага', callback_data: 'rps:p' },
      ],
    ],
  };
}

async function cmdRps(ctx) {
  await ctx.reply('🪨✂️📄 <b>Камень-ножницы-бумага</b>\nВыбирай:', { reply_markup: rpsKeyboard() });
}

async function cmdAnim(ctx) {
  const base = ctx.args.join(' ') || 'AlwaysDialog';
  const tail = ['', '.', '..', '...', '....', '.....', '....', '...', '..', '.'];
  const frames = [
    '📃 ' + base,
    ...tail.map((t, i) => '📃 ' + base.slice(0, Math.max(1, Math.ceil((base.length * (i + 1)) / tail.length))) + t),
    '📃 ' + base + ' ✨',
  ];
  await animate(ctx.env, ctx.biz, ctx.chatId, frames, 240);
}

/* ----------------------------- видео и ссылки --------------------------- */

const LINK_RE = /https?:\/\/[^\s<>"'«»]+/gi;
const VIDEO_HOST_RE = /(tiktok\.com|douyin\.com|instagram\.com|youtu\.be|youtube\.com|vk\.com\/video|vimeo\.com|twitch\.tv|likee\.video|pinterest\.)/i;
const DIRECT_VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function unescapeTikTok(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

async function tiktokFromPage(link) {
  const r = await fetch(link, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!r.ok) throw new Error(String(r.status));
  const html = await r.text();

  const found = [];
  const push = (re) => {
    let m;
    const g = new RegExp(re.source, 'g');
    while ((m = g.exec(html))) {
      const u = unescapeTikTok(m[1]);
      if (/^https?:\/\//i.test(u) && found.indexOf(u) === -1) found.push(u);
    }
  };
  push(/"playAddr":"([^"]+)"/);
  push(/"downloadAddr":"([^"]+)"/);
  push(/"play_addr":\{"url_list":\["([^"]+)"/);

  if (!found.length) throw new Error('no playAddr');
  const desc = html.match(/"desc":"([^"]{0,200})"/);
  return {
    url: found[0],
    alt: found[1] || '',
    headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/' },
    title: desc ? unescapeTikTok(desc[1]) : '',
    author: '',
    duration: 0,
  };
}

function isResolvable(env, link) {
  let host = '';
  try {
    host = new URL(link).hostname.replace(/^www\./, '');
  } catch (_) {
    return false;
  }
  if (/tiktok|douyin|likee/.test(host)) return true;
  if (DIRECT_VIDEO_RE.test(link)) return true;
  return !!env.SAVE_API;
}

function findVideoLink(text) {
  if (!text) return '';
  const m = String(text).match(LINK_RE);
  if (!m) return '';
  for (const raw of m) {
    const link = raw.replace(/[),.!?]+$/, '');
    if (DIRECT_VIDEO_RE.test(link) || VIDEO_HOST_RE.test(link)) return link;
  }
  return '';
}

async function resolveVideo(env, link) {
  const errors = [];
  let host = '';
  try {
    host = new URL(link).hostname.replace(/^www\./, '');
  } catch (_) {
    return { error: 'битая ссылка' };
  }

  /* 1. SAVE_API — внешний сервис (yt-dlp / douyin.wtf / свой), самый надёжный */
  if (env.SAVE_API) {
    try {
      const u = env.SAVE_API.replace('{url}', encodeURIComponent(link));
      const j = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }).then((x) => x.json());
      const out =
        (j && (j.url || j.video || j.download || j.download_url || j.data?.url || j.data?.video || j.data?.download_url)) || '';
      if (/^https?:/i.test(out)) {
        return {
          url: out,
          title: (j.title || j.data?.title || '').trim(),
          author: j.author?.username ? '@' + j.author.username : (j.data?.author?.username ? '@' + j.data.author.username : ''),
          duration: j.duration || j.data?.duration || 0,
        };
      }
      throw new Error('empty');
    } catch (e) {
      errors.push('saveapi:' + (e && e.message ? e.message : 'fail'));
    }
  }

  /* 2. TikTok: парсим страницу (работает, но CDN даёт 403 без кук — резерв) */
  if (/tiktok|douyin|likee/.test(host)) {
    try {
      const v = await tiktokFromPage(link);
      if (v && v.url) return v;
    } catch (e) {
      errors.push('page:' + (e && e.message ? e.message : 'fail'));
    }
  }

  /* 3. tikwm (часто 403) */
  if (/tiktok|douyin|likee/.test(host)) {
    try {
      const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(link) + '&hd=1', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const d = j && j.data;
      const raw = d && (d.hdplay || d.play || d.wmplay);
      if (raw) {
        return {
          url: /^https?:/i.test(raw) ? raw : 'https://www.tikwm.com' + raw,
          title: (d.title || '').trim(),
          author: d.author && d.author.unique_id ? '@' + d.author.unique_id : '',
          duration: d.duration || 0,
        };
      }
      throw new Error('empty');
    } catch (e) {
      errors.push('tikwm:' + (e && e.message ? e.message : 'fail'));
    }
  }

  /* 4. tiklydown (нестабилен) */
  if (/tiktok|douyin|likee/.test(host)) {
    try {
      const r = await fetch('https://api.tiklydown.eu.org/api/download?url=' + encodeURIComponent(link), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const v = j && j.video;
      const raw = v && (v.noWatermark || v.watermark);
      if (raw) return { url: raw, title: (j.title || '').trim(), author: '', duration: 0 };
      throw new Error('empty');
    } catch (e) {
      errors.push('tiklydown:' + (e && e.message ? e.message : 'fail'));
    }
  }

  /* 5. Прямые mp4/mov/webm — всегда работают */
  if (DIRECT_VIDEO_RE.test(link)) {
    return { url: link, title: '', author: '', duration: 0 };
  }

  return { error: errors.join(', ') || 'нет подходящего способа для ' + host };
}

async function sendVideoTo(env, biz, chatId, v) {
  const parts = ['🎬'];
  if (v.title) parts.push('<b>' + esc(cut(v.title, 160)) + '</b>');
  if (v.author) parts.push(esc(v.author));
  const caption = parts.join(' ');

  const sources = [v.url, v.alt].filter(Boolean);
  let last = null;
  const notes = [];

  for (const src of sources) {
    /* 1. качаем сами и заливаем файлом — самый надёжный путь */
    try {
      const res = await fetch(src, { headers: v.headers || {}, redirect: 'follow' });
      if (res.ok) {
        const length = Number(res.headers.get('content-length') || 0);
        if (length > 48 * 1024 * 1024) {
          notes.push('size:' + Math.round(length / 1048576) + 'MB');
          continue;
        }
        const blob = await res.blob();
        if (blob.size > 0 && blob.size <= 48 * 1024 * 1024) {
          const up = await api(
            env,
            'sendVideo',
            bizWrap(biz, { chat_id: chatId, caption, parse_mode: 'HTML', supports_streaming: true }),
            { video: { blob, name: 'video.mp4' } }
          );
          if (up && up.ok) return up;
          notes.push('upload:' + ((up && up.description) || 'fail'));
          last = up;
        } else {
          notes.push('size:' + Math.round(blob.size / 1048576) + 'MB');
        }
      } else {
        notes.push('fetch:' + res.status);
      }
    } catch (e) {
      notes.push('fetch:' + ((e && e.message) || 'fail'));
    }

    /* 2. пусть Telegram скачает по URL */
    const byUrl = await api(env, 'sendVideo', bizWrap(biz, {
      chat_id: chatId,
      video: src,
      caption,
      parse_mode: 'HTML',
      supports_streaming: true,
    }));
    if (byUrl && byUrl.ok) return byUrl;
    notes.push('url:' + ((byUrl && byUrl.description) || 'fail'));
    last = byUrl;
  }

  if (last) last.debug = notes.join(' | ');
  return last;
}

async function offerDownload(env, biz, chatId, link, ownerId) {
  const id = Math.random().toString(36).slice(2, 10);
  await kvSet(env, 'dl:' + id, { url: link, chat: chatId, biz: biz || '', owner: ownerId || 0 }, 86400);
  return sendIn(
    env,
    biz,
    chatId,
    '🎬 <b>Нашёл видео</b>\n' + esc(cut(link, 180)) + '\n\nСкачать в чат?',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да, скачать', callback_data: 'dl:' + id },
            { text: '❌ Нет', callback_data: 'dlx:' + id },
          ],
        ],
      },
    }
  );
}

async function cmdSave(ctx) {
  const { env } = ctx;
  let link = ctx.args[0];
  if (!link && ctx.msg.reply_to_message) {
    const m = ctx.msg.reply_to_message;
    link = m.text || m.caption;
  }
  if (link && !/^https?:\/\//i.test(link)) link = findVideoLink(link);
  if (!link || !/^https?:\/\//i.test(link)) {
    return ctx.reply('📸 Дай ссылку: <code>.save https://...</code>');
  }
  await ctx.reply('⏳ Достаю видео...');
  const v = await resolveVideo(env, link);
  if (!v || !v.url) {
    return ctx.reply('📸 Не смог достать видео.\nПричина: <code>' + esc((v && v.error) || 'неизвестно') + '</code>\n\n🔗 ' + esc(link));
  }
  const sent = await sendVideoTo(env, ctx.biz, ctx.chatId, v);
  if (!sent || !sent.ok) {
    await ctx.reply(
      '⚠️ Telegram не принял видео: ' + esc((sent && sent.description) || 'неизвестно') +
      (sent && sent.debug ? '\n<code>' + esc(sent.debug) + '</code>' : '')
    );
  }
}

async function cmdKrom(ctx) {
  const r = ctx.msg.reply_to_message;
  if (!r || !(r.video || r.video_note || r.animation)) {
    return ctx.reply('⭕ Ответь на видео и напиши <code>.krom</code>.');
  }
  await ctx.reply('⭕ Кружок требует перекодирования (ffmpeg), в воркере его нет. Отправляю как есть.');
  if (r.video) {
    await api(ctx.env, 'sendVideo', bizWrap(ctx.biz, { chat_id: ctx.chatId, video: r.video.file_id }));
  } else if (r.animation) {
    await api(ctx.env, 'sendAnimation', bizWrap(ctx.biz, { chat_id: ctx.chatId, animation: r.animation.file_id }));
  } else {
    await api(ctx.env, 'sendVideoNote', bizWrap(ctx.biz, { chat_id: ctx.chatId, video_note: r.video_note.file_id }));
  }
}

async function cmdVoicemod(ctx) {
  const r = ctx.msg.reply_to_message;
  if (!r || !(r.voice || r.audio)) return ctx.reply('📋 Ответь на голосовое и напиши <code>.voicemod</code>.');
  await ctx.reply('📋 Мод голоса требует обработки аудио (ffmpeg/pitch-shift). В воркере недоступно. Пересылаю как есть.');
  await ctx.copy(r.message_id);
}

async function cmdNiks(ctx) {
  await ctx.reply('💸 <b>Время по МСК:</b> <code>' + mskTime() + '</code>\nФамилия часа: <b>' + pick(['Никс', 'Никсов', 'Никсон', 'Никич']) + '</b>');
}

async function cmdStik(ctx) {
  const { env } = ctx;
  const r = ctx.msg.reply_to_message;
  if (!r || !r.photo || !r.photo.length) return ctx.reply('💰 Ответь на фото и напиши <code>.stik</code>.');
  await ctx.reply('💰 Делаю стикер...');
  const fileId = r.photo[r.photo.length - 1].file_id;
  const f = await api(env, 'getFile', { file_id: fileId });
  if (!f.ok) return ctx.reply('Не смог скачать фото.');
  const res = await fetch('https://api.telegram.org/file/bot' + env.BOT_TOKEN + '/' + f.result.file_path);
  if (!res.ok) return ctx.reply('Не смог скачать фото.');
  const blob = await res.blob();
  const sticker = await api(env, 'sendSticker', bizWrap(ctx.biz, { chat_id: ctx.chatId }), {
    sticker: { blob, name: 'sticker.png' },
  });
  if (!sticker.ok) await ctx.reply('⚠️ Telegram отказал: ' + esc(sticker.description || ''));
}

async function cmdKawai(ctx) {
  ctx.chat.kawai = !ctx.chat.kawai;
  await saveChat(ctx.env, ctx.chat);
  await ctx.reply(ctx.chat.kawai ? '🔄 Аниме-стиль <b>включён</b> ✨' : '🔄 Аниме-стиль <b>выключен</b>.');
}

async function cmdMon(ctx) {
  const text = ctx.args.join(' ') || 'Tbl Kрyt0i?';
  await ctx.reply(esc(leetify(text)));
}

async function cmdClone(ctx) {
  const { env } = ctx;
  const peer = ctx.chat.peer;
  if (!peer) return ctx.reply('🏡 Собеседник ещё не писал — некого клонировать.');
  const photos = await api(env, 'getUserProfilePhotos', { user_id: peer.id, limit: 1 });
  const name = esc(peer.first || 'Собеседник') + (peer.last ? ' ' + esc(peer.last) : '');
  const uname = peer.username ? '@' + esc(peer.username) : '';
  const caption =
    '🏡 <b>' + name + '</b>\n' +
    (uname ? '<a href="tg://user?id=' + peer.id + '">' + uname + '</a>\n' : '') +
    '🆔 <code>' + maskId(peer.id) + '</code>\n' +
    '💎 ' + (peer.premium ? 'Premium' : 'обычный') + ' · 🌐 ' + esc((peer.lang || '—').toUpperCase()) + '\n\n' +
    '<i>профиль клонирован</i>';

  if (photos.ok && photos.result.total_count > 0) {
    const p0 = photos.result.photos[0][photos.result.photos[0].length - 1];
    return api(env, 'sendPhoto', bizWrap(ctx.biz, {
      chat_id: ctx.chatId,
      photo: p0.file_id,
      caption,
      parse_mode: 'HTML',
    }));
  }
  await ctx.reply(caption);
}

async function cmdGif(ctx) {
  const r = ctx.msg.reply_to_message;
  if (!r) return ctx.reply('➕ Ответь на фото или видео и напиши <code>.gif</code>.');
  if (r.animation) {
    await api(ctx.env, 'sendAnimation', bizWrap(ctx.biz, { chat_id: ctx.chatId, animation: r.animation.file_id }));
    return;
  }
  await ctx.reply('➕ Конвертация в GIF требует ffmpeg, в воркере недоступна. Пересылаю как есть.');
  await ctx.copy(r.message_id);
}

async function cmdStory(ctx) {
  const r = ctx.msg.reply_to_message;
  if (!r || !r.photo || !r.photo.length) return ctx.reply('📲 Ответь на фото и напиши <code>.story</code>.');
  const peer = ctx.chat.peer;
  const caption =
    '📲 <b>Story-оформление</b>\n\n' +
    '╭──────────────╮\n' +
    '  ' + esc((peer && peer.first) || 'Собеседник') + '\n' +
    '  “всегда на связи”\n' +
    '╰──────────────╯\n\n' +
    '<i>стиль: neon · фон: фото</i>';
  await api(ctx.env, 'sendPhoto', bizWrap(ctx.biz, {
    chat_id: ctx.chatId,
    photo: r.photo[r.photo.length - 1].file_id,
    caption,
    parse_mode: 'HTML',
  }));
}

/* ---------------------------- .type / activity -------------------------- */

const TYPE_ACTIONS = {
  auto: [
    'typing',
    'upload_photo',
    'record_video',
    'record_voice',
    'choose_sticker',
    'upload_video_note',
    'find_location',
  ],
  typing: ['typing'],
  photo: ['upload_photo'],
  video: ['upload_video'],
  record: ['record_video'],
  voice: ['record_voice'],
  note: ['record_video_note'],
  circle: ['record_video_note'],
  sticker: ['choose_sticker'],
  doc: ['upload_document'],
  geo: ['find_location'],
  game: ['typing'],
};

const TYPE_ALIASES = {
  '': 'auto',
  auto: 'auto',
  'авто': 'auto',
  typing: 'typing',
  'печатает': 'typing',
  'печать': 'typing',
  'текст': 'typing',
  photo: 'photo',
  'фото': 'photo',
  video: 'video',
  'видео': 'video',
  record: 'record',
  'запись': 'record',
  'записывает': 'record',
  voice: 'voice',
  'голос': 'voice',
  'голосовое': 'voice',
  note: 'note',
  circle: 'circle',
  'кружок': 'circle',
  sticker: 'sticker',
  'стикер': 'sticker',
  doc: 'doc',
  'файл': 'doc',
  'документ': 'doc',
  geo: 'geo',
  'гео': 'geo',
  'локация': 'geo',
  game: 'game',
  'игра': 'game',
};

const TYPE_LABELS = {
  auto: 'всё подряд (авто)',
  typing: 'печатает',
  photo: 'отправляет фото',
  video: 'отправляет видео',
  record: 'записывает видео',
  voice: 'записывает голосовое',
  note: 'записывает кружок',
  circle: 'записывает кружок',
  sticker: 'выбирает стикер',
  doc: 'отправляет файл',
  geo: 'ищет геопозицию',
  game: 'играет (typing)',
};

const TYPE_TTL = 24 * 3600 * 1000;

function typeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

async function typeBurst(env, biz, chatId, token, budget, origin) {
  const st = await getChat(env, chatId);
  if (!st.typing || !st.typing.on || st.typing.token !== token) return;
  const list = TYPE_ACTIONS[st.typing.action] || TYPE_ACTIONS.auto;
  const started = Date.now();
  let i = 0;
  while (Date.now() - started < budget) {
    const fresh = await getChat(env, chatId);
    if (!fresh.typing || !fresh.typing.on || fresh.typing.token !== token) return;
    if (Date.now() > (fresh.typing.until || 0)) return;
    await actionIn(env, biz, chatId, list[i % list.length]);
    i++;
    await sleep(4000);
  }
  const last = await getChat(env, chatId);
  if (!last.typing || !last.typing.on || last.typing.token !== token) return;
  if (Date.now() > (last.typing.until || 0)) return;
  if (!origin) return;
  try {
    await fetch(
      origin +
      '/tick?c=' + chatId +
      '&t=' + encodeURIComponent(token) +
      '&b=' + encodeURIComponent(biz || '')
    );
  } catch (_) {}
}

async function cmdType(ctx) {
  const { env, chat } = ctx;
  const arg = (ctx.args[0] || '').toLowerCase();
  const current = chat.typing || null;

  if (arg === 'off' || arg === 'stop' || arg === 'выкл' || arg === 'стоп') {
    chat.typing = { on: false, action: 'auto', token: '', until: 0 };
    await saveChat(env, chat);
    return ctx.reply('👁 Эмуляция активности <b>выключена</b>.');
  }

  if (!arg && current && current.on) {
    chat.typing = { on: false, action: 'auto', token: '', until: 0 };
    await saveChat(env, chat);
    return ctx.reply('👁 Эмуляция активности <b>выключена</b>. (Включить снова: <code>.type</code>)');
  }

  const action = TYPE_ALIASES[arg] || (TYPE_ACTIONS[arg] ? arg : 'auto');
  chat.typing = { on: true, action, token: typeToken(), until: Date.now() + TYPE_TTL };
  await saveChat(env, chat);

  await ctx.reply(
    '👁 <b>Эмуляция активности включена</b>\n' +
    'Режим: <b>' + (TYPE_LABELS[action] || action) + '</b>\n' +
    'Работает до выключения (макс. 24 ч).\n\n' +
    'Сменить: <code>.type фото</code> · <code>.type голос</code> · <code>.type кружок</code> · <code>.type игра</code> · <code>.type авто</code>\n' +
    'Выключить: <code>.type off</code> или ещё раз <code>.type</code>'
  );

  await typeBurst(env, ctx.biz, ctx.chatId, chat.typing.token, 12000, ctx.origin);
}

/* -------------------------------- wordle ------------------------------- */

const WORDS = [
  'ГОРОД', 'КНИГА', 'ПИРОГ', 'ЛИМОН', 'БАНАН', 'СОСНА', 'ТРАВА', 'ЗЕМЛЯ',
  'ВЕТЕР', 'КОШКА', 'МЫШКА', 'СЛОВО', 'ШКОЛА', 'САХАР', 'КАРТА', 'ЛАМПА',
  'РУЧКА', 'ТУЧКА', 'ДОМИК', 'ЗАМОК', 'ПЕСОК', 'ЛЕСОК', 'БЕРЕГ', 'ОГОНЬ',
  'ДВЕРЬ', 'СТЕНА', 'ПОЛКА', 'ВИЛКА', 'ЛОЖКА', 'БУЛКА', 'ПТИЦА', 'ЗВЕЗДА',
];

function wordleScore(word, guess) {
  const res = new Array(5).fill('⬛');
  const left = word.split('');
  for (let i = 0; i < 5; i++) {
    if (guess[i] === word[i]) {
      res[i] = '🟩';
      left[i] = null;
    }
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] === '🟩') continue;
    const idx = left.indexOf(guess[i]);
    if (idx >= 0) {
      res[i] = '🟨';
      left[idx] = null;
    }
  }
  return res.join('');
}

function wordleRender(game, status) {
  const head = '📃 <b>Wordle</b> — ответь на это сообщение словом из 5 букв\n';
  const body = game.tries.length ? '\n' + game.tries.map((t) => t.guess + '\n' + t.row).join('\n\n') : '';
  return head + body + (status ? '\n\n' + status : '');
}

async function cmdWordle(ctx) {
  const game = { word: pick(WORDS), tries: [], done: false };
  const sent = await ctx.reply(wordleRender(game, ''));
  const msgId = sent && sent.result && sent.result.message_id;
  if (!msgId) return;
  await kvSet(ctx.env, 'wg:' + ctx.chatId + ':' + msgId, game, 86400);
}

async function wordleGuess(ctx, game, key) {
  const text = ctx.text || '';
  const guess = text.toUpperCase().replace(/[^А-ЯЁ]/g, '');
  if (guess.length !== 5) return;

  game.tries.push({ guess, row: wordleScore(game.word, guess) });
  const win = guess === game.word;
  const lose = !win && game.tries.length >= 6;
  let status = '';

  if (win) {
    status = '🎉 <b>Угадал!</b> Слово: <b>' + game.word + '</b>';
    game.done = true;
    ctx.chat.stats.games++;
    ctx.chat.stats.wins++;
  } else if (lose) {
    status = '💀 Попытки кончились. Слово: <b>' + game.word + '</b>';
    game.done = true;
    ctx.chat.stats.games++;
  } else {
    status = 'Осталось попыток: <b>' + (6 - game.tries.length) + '</b>';
  }

  await kvSet(ctx.env, key, game, 86400);
  await editIn(ctx.env, ctx.biz, ctx.chatId, ctx.repliedId, wordleRender(game, status));
  await saveChat(ctx.env, ctx.chat);
}

/* ------------------------------- dispatch ------------------------------ */

const COMMANDS = {
  start: cmdStart,
  help: cmdHelp,
  id: cmdId,
  mute: cmdMute,
  unmute: cmdUnmute,
  nomute: cmdNomute,
  love: cmdLove,
  spam: cmdSpam,
  spek: cmdSpek,
  zero: cmdZero,
  status: cmdStatus,
  info: cmdInfo,
  troll: cmdTroll,
  afk: cmdAfk,
  'бурмалда': cmdBurmalda,
  burmalda: cmdBurmalda,
  crash: cmdCrash,
  flip: cmdFlip,
  rps: cmdRps,
  anim: cmdAnim,
  save: cmdSave,
  krom: cmdKrom,
  voicemod: cmdVoicemod,
  niks: cmdNiks,
  stik: cmdStik,
  kawai: cmdKawai,
  mon: cmdMon,
  clone: cmdClone,
  gif: cmdGif,
  story: cmdStory,
  type: cmdType,
  wordle: cmdWordle,
};

function parseCommand(text) {
  if (!text || !/^[./]/.test(text)) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  const parts = body.split(/\s+/);
  const name = (parts[0] || '').toLowerCase().replace(/@.*$/, '');
  if (!COMMANDS[name]) return null;
  return { name, args: parts.slice(1) };
}

/* ------------------------------- callbacks ----------------------------- */

async function handleCallback(env, cb, origin) {
  const data = cb.data || '';
  if (data === 'noop') return api(env, 'answerCallbackQuery', { callback_query_id: cb.id });

  const msg = cb.message || {};
  const chatId = msg.chat ? msg.chat.id : cb.from.id;
  const biz = msg.business_connection_id || (await kvGet(env, 'chatconn:' + chatId)) || '';
  const chat = await getChat(env, chatId);
  const conn = biz ? await getConn(env, biz) : null;
  const ownerId = conn && conn.user ? conn.user.id : cb.from.id;

  if (data.indexOf('dl:') === 0) {
    const job = await kvGet(env, 'dl:' + data.slice(3));
    if (!job) {
      return api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Ссылка устарела' });
    }
    if (cb.from.id !== job.owner) {
      return api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Нажать может только владелец чата' });
    }
    await api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Скачиваю…' });
    const v = await resolveVideo(env, job.url);
    if (!v || !v.url) {
      return editIn(env, biz, chatId, msg.message_id,
        '📸 Не получилось достать видео.\nПричина: <code>' + esc((v && v.error) || 'неизвестно') + '</code>');
    }
    const sent = await sendVideoTo(env, job.biz || biz, job.chat || chatId, v);
    if (sent && sent.ok) {
      await tryDelete(env, biz, chatId, msg.message_id);
    } else {
      await editIn(env, biz, chatId, msg.message_id,
        '⚠️ Не смог отправить видео: ' + esc((sent && sent.description) || 'неизвестно') +
        (sent && sent.debug ? '\n<code>' + esc(sent.debug) + '</code>' : ''));
    }
    return;
  }

  if (data.indexOf('dlx:') === 0) {
    await api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Ок' });
    return tryDelete(env, biz, chatId, msg.message_id);
  }

  if (data.indexOf('z:') === 0) {
    const cell = parseInt(data.slice(2), 10);
    const key = 'zg:' + chatId + ':' + msg.message_id;
    const game = await kvGet(env, key);
    if (!game || game.done) {
      return api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Игра устарела: .zero' });
    }
    if (game.board[cell]) {
      return api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Занято' });
    }
    game.board[cell] = 'X';
    let status = '';

    if (zeroWinner(game.board) === 'X') {
      game.done = true;
      chat.stats.games++;
      chat.stats.wins++;
      status = '🎉 <b>Ты победил!</b>';
    } else if (zeroWinner(game.board) === 'D') {
      game.done = true;
      chat.stats.games++;
      status = '🤝 Ничья.';
    } else {
      await botZeroMove(game.board);
      const w = zeroWinner(game.board);
      if (w === 'O') {
        game.done = true;
        chat.stats.games++;
        status = '🤖 <b>Бот победил.</b>';
      } else if (w === 'D') {
        game.done = true;
        chat.stats.games++;
        status = '🤝 Ничья.';
      }
    }
    await kvSet(env, key, game, 86400);
    await saveChat(env, chat);
    await api(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    return editIn(env, biz, chatId, msg.message_id, zeroRender(status), {
      reply_markup: zeroKeyboard(game.board, game.done),
    });
  }

  if (data.indexOf('rps:') === 0) {
    const choice = data.slice(4);
    if (choice === 'again') {
      await api(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      return editIn(env, biz, chatId, msg.message_id,
        '🪨✂️📄 <b>Камень-ножницы-бумага</b>\nВыбирай:', { reply_markup: rpsKeyboard() });
    }
    const bot = pick(['r', 's', 'p']);
    const names = { r: '🪨 Камень', s: '✂️ Ножницы', p: '📄 Бумага' };
    let status;
    if (choice === bot) status = '🤝 Ничья!';
    else if (
      (choice === 'r' && bot === 's') ||
      (choice === 's' && bot === 'p') ||
      (choice === 'p' && bot === 'r')
    ) {
      status = '🎉 Ты победил!';
      chat.stats.games++;
      chat.stats.wins++;
    } else {
      status = '🤖 Бот победил.';
      chat.stats.games++;
    }
    await saveChat(env, chat);
    await api(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: status });
    return editIn(env, biz, chatId, msg.message_id,
      '🪨✂️📄 Ты: ' + names[choice] + '\nБот: ' + names[bot] + '\n\n' + status,
      { reply_markup: { inline_keyboard: [[{ text: '🔁 Ещё раз', callback_data: 'rps:again' }]] } }
    );
  }

  return api(env, 'answerCallbackQuery', { callback_query_id: cb.id });
}

/* ------------------------------- messages ------------------------------ */

async function runCommand(ctx, parsed, commandMsgId) {
  const { env } = ctx;
  ctx.args = parsed.args;
  try {
    await COMMANDS[parsed.name](ctx);
  } catch (err) {
    await ctx.reply('⚠️ Ошибка: <code>' + esc(String(err && err.message ? err.message : err)) + '</code>');
  }
  await saveChat(env, ctx.chat);
  if (commandMsgId) await tryDelete(env, ctx.biz, ctx.chatId, commandMsgId);
}

async function handleBusiness(env, msg, origin) {
  const biz = msg.business_connection_id || '';
  const chatId = msg.chat.id;
  await kvSet(env, 'chatconn:' + chatId, biz, 86400 * 30);

  const conn = biz ? await getConn(env, biz) : null;
  let ownerId = conn && conn.user ? conn.user.id : 0;
  const from = msg.from || {};
  if (!ownerId && biz) {
    ownerId = (await kvGet(env, 'connowner:' + biz)) || 0;
    if (!ownerId) {
      ownerId = from.id;
      await kvSet(env, 'connowner:' + biz, ownerId, 86400 * 30);
    }
  }
  const isOwner = !!ownerId && from.id === ownerId;
  const text = msg.text || msg.caption || '';
  const now = Date.now();

  const chat = await getChat(env, chatId);
  if (!chat.since) chat.since = now;

  const muted = chat.mutedUntil > now && !chat.nomute;

  /* статистика */
  if (!(!isOwner && muted)) {
    chat.stats.msgs++;
    chat.stats.chars += text.length;
    if (msg.photo) chat.stats.photos++;
    if (msg.voice) chat.stats.voices++;
    if (msg.sticker) chat.stats.stickers++;
  }

  if (!isOwner) {
    chat.peer = {
      id: from.id,
      first: from.first_name || '',
      last: from.last_name || '',
      username: from.username || '',
      premium: !!from.is_premium,
      lang: from.language_code || '',
      seen: now,
    };
  }

  if (chat.typing && chat.typing.on) {
    chat.typing.until = Math.max(chat.typing.until || 0, now + 3600 * 1000);
  }

  /* ответ на wordle */
  if (isOwner && text && msg.reply_to_message && !muted) {
    const key = 'wg:' + chatId + ':' + msg.reply_to_message.message_id;
    const game = await kvGet(env, key);
    if (game && !game.done) {
      const ctx = makeCtx(env, chatId, biz, ownerId, isOwner, chat, msg, [], text, origin);
      ctx.repliedId = msg.reply_to_message.message_id;
      await wordleGuess(ctx, game, key);
      if (isOwner) await tryDelete(env, biz, chatId, msg.message_id);
      await saveChat(env, chat);
      return;
    }
  }

  /* команда от владельца */
  if (isOwner && !muted) {
    const parsed = parseCommand(text);
    if (parsed) {
      const ctx = makeCtx(env, chatId, biz, ownerId, isOwner, chat, msg, parsed.args, text, origin);
      await runCommand(ctx, parsed, msg.message_id);
      return;
    }
  }

  /* предложение скачать видео по ссылке */
  if (!muted) {
    const link = findVideoLink(text);
    if (link && isResolvable(env, link)) await offerDownload(env, biz, chatId, link, ownerId);
  }

  /* AFK-автоответ собеседнику */
  if (!isOwner && chat.afk && !muted) {
    const last = (await kvGet(env, 'afkping:' + chatId)) || 0;
    if (now - last > 5 * 60000) {
      await kvSet(env, 'afkping:' + chatId, now, 3600);
      await sendIn(env, biz, chatId, '💤 ' + esc(chat.afkText || 'Отошёл, вернусь позже'));
    }
  }

  await saveChat(env, chat);
}

async function handleBotMessage(env, msg, origin) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = msg.text || msg.caption || '';
  const now = Date.now();
  const chat = await getChat(env, chatId);
  if (!chat.since) chat.since = now;

  chat.stats.msgs++;
  chat.stats.chars += text.length;

  const parsed = parseCommand(text);
  const ctx = makeCtx(env, chatId, '', from.id, true, chat, msg, parsed ? parsed.args : [], text, origin);
  if (parsed) {
    await runCommand(ctx, parsed, null);
    return;
  }

  await saveChat(env, chat);
  if (!text) return;

  const link = findVideoLink(text);
  if (link && isResolvable(env, link)) {
    await offerDownload(env, '', chatId, link, from.id);
    return;
  }

  await sendIn(env, '', chatId, 'ℹ️ Это личка с ботом. Команды тут работают как песочница.\nПодключи бота к своему аккаунту через <b>Telegram Business → Чат-боты</b>, и он начнёт работать в твоих диалогах.\n\n<code>.help</code> — команды');
}

async function handleUpdate(env, update, origin) {
  if (update.business_connection) {
    await saveConn(env, update.business_connection);
    return;
  }
  if (update.business_message) {
    return handleBusiness(env, update.business_message, origin);
  }
  if (update.callback_query) {
    return handleCallback(env, update.callback_query, origin);
  }
  if (update.message) {
    return handleBotMessage(env, update.message, origin);
  }
}

/* -------------------------------- fetch -------------------------------- */

async function handleTick(env, request, ctx) {
  const url = new URL(request.url);
  const chatId = parseInt(url.searchParams.get('c'), 10);
  const token = url.searchParams.get('t') || '';
  const biz = url.searchParams.get('b') || '';
  if (!chatId || !token) return new Response('bad', { status: 400 });

  const chat = await getChat(env, chatId);
  if (!chat.typing || !chat.typing.on || chat.typing.token !== token) {
    return new Response('off');
  }
  if (Date.now() > (chat.typing.until || 0)) {
    chat.typing = { on: false, action: 'auto', token: '', until: 0 };
    await saveChat(env, chat);
    return new Response('expired');
  }

  ctx.waitUntil((async () => {
    const st = await getChat(env, chatId);
    if (!st.typing || !st.typing.on || st.typing.token !== token) return;
    const list = TYPE_ACTIONS[st.typing.action] || TYPE_ACTIONS.auto;
    const started = Date.now();
    let i = 0;
    while (Date.now() - started < 24000) {
      const fresh = await getChat(env, chatId);
      if (!fresh.typing || !fresh.typing.on || fresh.typing.token !== token) return;
      await actionIn(env, biz, chatId, list[i % list.length]);
      i++;
      await sleep(4000);
    }
    const last = await getChat(env, chatId);
    if (!last.typing || !last.typing.on || last.typing.token !== token) return;
    if (Date.now() > (last.typing.until || 0)) return;
    try {
      await fetch(
        url.origin + '/tick?c=' + chatId + '&t=' + encodeURIComponent(token) + '&b=' + encodeURIComponent(biz)
      );
    } catch (_) {}
  })());

  return new Response('ok');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/tick') {
      return handleTick(env, request, ctx);
    }

    if (request.method === 'GET') {
      const secret = url.searchParams.get('set');
      if (secret && env.SETUP_SECRET && secret === env.SETUP_SECRET) {
        const r = await api(env, 'setWebhook', {
          url: url.origin + '/',
          secret_token: env.WEBHOOK_SECRET || undefined,
          allowed_updates: [
            'message',
            'callback_query',
            'business_connection',
            'business_message',
            'edited_business_message',
            'deleted_business_messages',
          ],
          drop_pending_updates: true,
        });
        return new Response(JSON.stringify(r, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, name: 'AlwaysDialog', commands: Object.keys(COMMANDS).length }),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (env.WEBHOOK_SECRET) {
      const token = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (token !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch (_) {
      return new Response('bad request', { status: 400 });
    }

    ctx.waitUntil(
      handleUpdate(env, update, url.origin).catch((err) => {
        console.error('update failed', err);
      })
    );

    return new Response('ok');
  },
};
