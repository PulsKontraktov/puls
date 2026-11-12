// Пульс контрактов — бот Telegram + нейросеть Gemini
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GEMINI = Deno.env.get("GEMINI_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const PANEL = "https://pulskontraktov.github.io/puls/?k=";
const MON = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];

async function secret(): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("puls:" + TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}
async function log(kind: string, data: unknown) { await db.from("bot_log").insert({ kind, data }); }
function fmt(d: string) { const p = d.split("-"); return `${+p[2]} ${MON[+p[1] - 1]}`; }
function money(v: number) { return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸"; }
function days(n: number) { const a = Math.abs(n) % 10, b = Math.abs(n) % 100; return n + " " + (a == 1 && b != 11 ? "день" : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? "дня" : "дней"); }
function esc(s: string) { return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

let goodModel = "";
async function pickModels(): Promise<string[]> {
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": GEMINI } });
    const j = await r.json();
    const names: string[] = (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => String(m.name).replace("models/", ""))
      .filter((n: string) => /flash/.test(n) && !/(lite|image|tts|audio|live|preview|exp|thinking)/.test(n));
    const ver = (n: string) => parseFloat((n.match(/(\d+(\.\d+)?)/) ?? ["0"])[0]);
    const pref = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.6-flash", "gemini-2.5-flash"];
    const order = pref.filter((p) => p === "gemini-flash-latest" || names.includes(p)).concat(names.filter((n) => !pref.includes(n)));
    await log("models", { order });
    return order;
  } catch (e) { await log("models_error", { e: String(e) }); return ["gemini-flash-latest"]; }
}
async function gemini(prompt: string): Promise<any> {
  const list = goodModel ? [goodModel] : await pickModels();
  for (const m of list) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
    let r: Response;
    try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { signal: ctl.signal,
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 } }) });
    } catch (e) { clearTimeout(tm); await log("gemini_error", { model: m, err: "timeout" }); continue; }
    clearTimeout(tm);
    const j = await r.json();
    if (r.ok) { goodModel = m; const t = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") || "{}"; try { return JSON.parse(t); } catch { return JSON.parse(t.replace(/^```json|```$/g, "")); } }
    await log("gemini_error", { model: m, status: r.status, err: j?.error?.message });
  }
  return null;
}

async function contractFor(chatId: number, isGroup: boolean) {
  let { data: c } = await db.from("contracts").select("*").eq(isGroup ? "tg_group_id" : "boss_tg_id", chatId).maybeSingle();
  return c;
}

async function onGroupMessage(m: any) {
  const chat = m.chat.id;
  let c = await contractFor(chat, true);
  if (!c) {
    const { data: free } = await db.from("contracts").select("*").is("tg_group_id", null).order("created_at").limit(1).maybeSingle();
    if (!free) return;
    await db.from("contracts").update({ tg_group_id: chat }).eq("id", free.id);
    c = { ...free, tg_group_id: chat };
    await tg("sendMessage", { chat_id: chat, parse_mode: "HTML",
      text: `Здравствуйте! Я <b>Пульс контрактов</b>. Подключён к контракту «${esc(c.title)}».\nПишите, как обычно: что задерживается, что сломалось, что пришло. Я разберусь, к какой работе это относится, и пересчитаю срок.` });
  }
  const text: string = m.text ?? m.caption ?? "";
  if (!text || text.startsWith("/") || m.from?.is_bot) return;
  const author = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || "участник";
  const { data: ev } = await db.from("events").insert({ contract_id: c.id, source: "telegram", author, raw_text: text,
    status: "new", tg_chat_id: chat, tg_message_id: m.message_id }).select().single();

  const { data: works } = await db.from("works").select("id,code,section,title,kind,calc_start,calc_end").eq("contract_id", c.id).order("sort");
  const today = c.demo_today ?? new Date().toISOString().slice(0, 10);
  const list = (works ?? []).map((w: any) => `${w.code}: ${w.title} (${w.calc_start} — ${w.calc_end})`).join("\n");
  const prompt = `Ты — диспетчер исполнения госконтракта «${c.title}». Сегодня ${today}.
Работы контракта (код: название, плановые даты):
${list}

Сообщение из рабочей группы от «${author}»:
"""${text}"""

Определи, сообщает ли оно о событии, которое может сдвинуть сроки (задержка, поломка, нехватка людей, поставка, погода, акт, согласование и т.п.).
Ответь строго JSON:
{"relevant": true|false,
 "work_code": "код работы из списка, к которой это относится, или null",
 "delay_days": целое число дней задержки (оценка, если не сказано прямо; 0 если задержки нет),
 "summary": "коротко, до 80 знаков, по-русски, что случилось",
 "confident": true|false}
Если работа ещё не началась или уже закончена — выбери ближайшую подходящую будущую работу этого участка.`;
  const a = await gemini(prompt);
  await log("gemini", { text, a });
  if (!a) {
    await tg("sendMessage", { chat_id: chat, reply_to_message_id: m.message_id, text: "Принял. Нейросеть сейчас недоступна — запишу как есть, руководитель увидит в панели." });
    return;
  }
  const w = (works ?? []).find((x: any) => x.code === a.work_code);
  if (!a.relevant || !w || !(a.delay_days > 0)) {
    await db.from("events").update({ status: "info", summary: a.summary ?? text.slice(0, 80), ai: a }).eq("id", ev.id);
    return;
  }
  await db.from("events").update({ status: "asked", work_id: w.id, delay_days: a.delay_days, summary: a.summary, ai: a }).eq("id", ev.id);
  const q = await tg("sendMessage", { chat_id: chat, reply_to_message_id: m.message_id, parse_mode: "HTML",
    text: `Понял: <b>${esc(w.title)}</b> — задержка около <b>${days(a.delay_days)}</b>.\n${esc(a.summary ?? "")}\nВерно?`,
    reply_markup: { inline_keyboard: [[{ text: "Да, верно", callback_data: `ok:${ev.id}` }, { text: "Нет, уточню", callback_data: `no:${ev.id}` }]] } });
  if (q?.result?.message_id) await db.from("events").update({ tg_reply_id: q.result.message_id }).eq("id", ev.id);
}

async function onCallback(cq: any) {
  const [act, id] = String(cq.data ?? "").split(":");
  const who = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(" ");
  const { data: ev } = await db.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev || ev.status !== "asked") { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Уже учтено" }); return; }
  const { data: c } = await db.from("contracts").select("*").eq("id", ev.contract_id).single();
  const { data: w } = await db.from("works").select("*").eq("id", ev.work_id).single();
  if (act === "no") {
    await db.from("events").update({ status: "rejected" }).eq("id", id);
    await tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Хорошо" });
    await tg("sendMessage", { chat_id: cq.message.chat.id, text: `${who}, напишите, пожалуйста, точнее: какой участок и на сколько дней задержка.` });
    return;
  }
  const { data: before } = await db.from("forecasts").select("*").eq("contract_id", c.id).order("id", { ascending: false }).limit(1).single();
  await db.from("works").update({ extra_days: (w.extra_days ?? 0) + ev.delay_days }).eq("id", w.id);
  await db.from("events").update({ status: "confirmed" }).eq("id", id);
  const { data: r } = await db.rpc("recalc", { p_contract: c.id, p_reason: ev.summary });
  await tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Принято, пересчитываю" });
  const late = r.slack < 0;
  await tg("sendMessage", { chat_id: cq.message.chat.id, text: `✓ ${who} подтвердил. График пересчитан, руководитель получил сигнал.` });
  if (c.boss_tg_id) {
    const head = late ? "⚠️ <b>Сигнал по контракту</b>" : (r.slack <= (before?.slack_days ?? 99) ? "ℹ️ <b>Изменение по контракту</b>" : "ℹ️ <b>Изменение по контракту</b>");
    const status = late ? `опоздание <b>${days(-r.slack)}</b>` : (r.slack == 0 ? "впритык, без запаса" : `в срок, запас ${days(r.slack)}`);
    await tg("sendMessage", { chat_id: c.boss_tg_id, parse_mode: "HTML", disable_web_page_preview: true,
      text: `${head} «${esc(c.title)}»\n\nПрогноз сдачи: <b>${fmt(r.forecast)}</b> — ${status}` +
        (r.penalty > 0 ? `\nВозможная неустойка: <b>≈ ${money(r.penalty)}</b>` : "") +
        `\nБыло: ${before ? fmt(before.forecast_date) : "—"}\nПричина: ${esc(ev.summary ?? "")} (${esc(w.title)}, +${days(ev.delay_days)})\n\n<a href="${PANEL}${c.view_key}">Открыть панель</a>` });
  }
}

async function onPrivate(m: any) {
  const text: string = m.text ?? "";
  if (text.startsWith("/start")) {
    const { data: c } = await db.from("contracts").select("*").is("boss_tg_id", null).order("created_at").limit(1).maybeSingle();
    const mine = c ?? (await contractFor(m.chat.id, false));
    if (c) await db.from("contracts").update({ boss_tg_id: m.chat.id }).eq("id", c.id);
    await tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", disable_web_page_preview: true,
      text: mine ? `Здравствуйте! Я <b>Пульс контрактов</b>. Сюда буду присылать сигналы руководителю по контракту «${esc(mine.title)}» — только то, что требует внимания.\n\n<a href="${PANEL}${mine.view_key}">Панель руководителя</a>`
                 : "Здравствуйте! Я Пульс контрактов. Сигналы руководителю приходят сюда." });
    return;
  }
  const c = await contractFor(m.chat.id, false);
  await tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", disable_web_page_preview: true,
    text: c ? `Сводка и график — в панели: <a href="${PANEL}${c.view_key}">открыть</a>.\nСобытия пишите в рабочую группу контракта.` : "Напишите /start" });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (action === "setup") {
    const r = await tg("setWebhook", { url: `${SB_URL}/functions/v1/tg`, secret_token: await secret(),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
    const me = await tg("getMe", {});
    return Response.json({ setWebhook: r, bot: me?.result?.username });
  }
  if (action === "ping") {
    // @ts-ignore EdgeRuntime
    EdgeRuntime.waitUntil((async () => { const a = await gemini('Ответь JSON {"ok": true, "word": "привет"}'); await log("ping", { a, model: goodModel }); })());
    return Response.json({ started: true });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await secret()) return new Response("forbidden", { status: 403 });
  const u = await req.json();
  // @ts-ignore EdgeRuntime
  EdgeRuntime.waitUntil((async () => { try {
    await log("update", u);
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) {
      const t = u.message.chat.type;
      if (t === "private") await onPrivate(u.message);
      else if (t === "group" || t === "supergroup") await onGroupMessage(u.message);
    }
  } catch (e) { await log("error", { e: String(e) }); } })());
  return new Response("ok");
});
