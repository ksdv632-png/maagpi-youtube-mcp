/**
 * Tiny server-rendered HTML pages (status/setup, errors, publish approval).
 * Mobile-first, no external assets, no inline scripts → can use a strict CSP.
 * Every dynamic value goes through escapeHtml().
 */

export type Lang = "uk" | "en";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const T = {
  uk: {
    appName: "YouTube MCP",
    ready: "Сервер працює і налаштований ✅",
    notReady: "Сервер запущено, але ще не налаштований",
    missing: "Не вистачає змінних у Railway (Variables):",
    connectorUrl: "Адреса для Claude (Remote MCP server URL):",
    redirectUri: "Redirect URI для Google Cloud (Authorized redirect URI):",
    generatedKey: "Згенерований ключ для TOKEN_ENCRYPTION_KEY (скопіюйте):",
    keyNote: "Ключ показується лише поки TOKEN_ENCRYPTION_KEY не задано. Його ніде не збережено.",
    errorTitle: "Помилка",
    approveTitle: "Підтвердьте публікацію",
    approveIntro: "Claude просить зробити відео доступним. Нічого не буде опубліковано, доки ви не натиснете «Підтвердити».",
    video: "Відео",
    videoId: "ID відео",
    action: "Дія",
    makePublic: "Зробити ПУБЛІЧНИМ",
    makeUnlisted: "Зробити «за посиланням» (unlisted)",
    schedule: "Запланувати публікацію (стане публічним)",
    when: "Коли",
    currentPrivacy: "Зараз",
    approve: "Підтвердити",
    reject: "Скасувати",
    approvedTitle: "Підтверджено ✅",
    approvedText: "Поверніться в Claude і напишіть, що ви підтвердили — Claude завершить дію.",
    rejectedTitle: "Скасовано",
    rejectedText: "Нічого не змінено. Можете закрити цю сторінку.",
    expired: "Це посилання застаріло або вже використане. Попросіть Claude створити нове.",
    forbiddenAccount: "Цей Google-акаунт не має доступу до цього сервера.",
    noRefresh:
      "Google не повернув ключ оновлення. Відкрийте myaccount.google.com/permissions, приберіть доступ цього застосунку й спробуйте підключитися знову.",
    missingScopes: "Не надано обов'язкові дозволи YouTube. Підключіться знову й залишіть усі галочки увімкненими.",
    wrongChannel: "Підключено не той канал YouTube. Виберіть правильний канал під час входу.",
    noChannel: "У цьому Google-акаунті не знайдено YouTube-каналу.",
    sessionExpired: "Сесію входу втрачено або вона застаріла. Поверніться в Claude й спробуйте підключитися ще раз.",
    googleError: "Google повернув помилку під час входу.",
    tryAgain: "Поверніться в Claude й спробуйте ще раз.",
  },
  en: {
    appName: "YouTube MCP",
    ready: "Server is running and configured ✅",
    notReady: "Server is running but not configured yet",
    missing: "Missing Railway variables:",
    connectorUrl: "URL for Claude (Remote MCP server URL):",
    redirectUri: "Redirect URI for Google Cloud (Authorized redirect URI):",
    generatedKey: "Generated key for TOKEN_ENCRYPTION_KEY (copy it):",
    keyNote: "The key is only shown while TOKEN_ENCRYPTION_KEY is unset. It is not stored anywhere.",
    errorTitle: "Error",
    approveTitle: "Approve publishing",
    approveIntro: "Claude asks to make a video available. Nothing is published until you press “Approve”.",
    video: "Video",
    videoId: "Video ID",
    action: "Action",
    makePublic: "Make PUBLIC",
    makeUnlisted: "Make UNLISTED",
    schedule: "Schedule publishing (becomes public)",
    when: "When",
    currentPrivacy: "Currently",
    approve: "Approve",
    reject: "Cancel",
    approvedTitle: "Approved ✅",
    approvedText: "Go back to Claude and tell it you approved — Claude will finish the action.",
    rejectedTitle: "Cancelled",
    rejectedText: "Nothing was changed. You can close this page.",
    expired: "This link has expired or was already used. Ask Claude to create a new one.",
    forbiddenAccount: "This Google account is not allowed to use this server.",
    noRefresh:
      "Google did not return a refresh token. Open myaccount.google.com/permissions, remove this app's access and connect again.",
    missingScopes: "Required YouTube permissions were not granted. Connect again and keep all boxes ticked.",
    wrongChannel: "A different YouTube channel was connected. Pick the right channel when signing in.",
    noChannel: "No YouTube channel was found for this Google account.",
    sessionExpired: "The sign-in session was lost or expired. Go back to Claude and try connecting again.",
    googleError: "Google returned an error during sign-in.",
    tryAgain: "Go back to Claude and try again.",
  },
} as const;

export type Strings = (typeof T)["uk"];
export function strings(lang: Lang): Strings {
  return T[lang] as Strings;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#14171a;--mut:#5b6670;--card:#f4f6f8;--bd:#d9dee3;--ac:#1a6bff;--ok:#0a7f3f;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#101316;--fg:#eceff1;--mut:#9aa6b0;--card:#1a1f24;--bd:#2c343b;--ac:#6ea3ff;--ok:#4cc27e;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.35rem;margin:.2rem 0 1rem}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin:12px 0}
.k{color:var(--mut);font-size:.85rem;margin:0 0 2px}
code,.mono{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;user-select:all;-webkit-user-select:all}
ul{padding-left:1.2rem}
form{display:flex;gap:10px;margin-top:16px}
button{flex:1;font:inherit;font-weight:600;padding:14px;border-radius:12px;border:1px solid var(--bd);background:var(--card);color:var(--fg)}
button.primary{background:var(--ac);border-color:var(--ac);color:#fff}
.ok{color:var(--ok)}.bad{color:var(--bad)}
img{max-width:100%;border-radius:8px}
`;

export function renderPage(lang: Lang, title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style></head>
<body><main>${bodyHtml}</main></body></html>`;
}

export function errorPage(lang: Lang, message: string): string {
  const s = strings(lang);
  return renderPage(lang, s.errorTitle, `<h1 class="bad">${escapeHtml(s.errorTitle)}</h1><div class="card">${escapeHtml(message)}</div>`);
}

export function statusPage(
  lang: Lang,
  args: {
    missing: Array<{ name: string; hint: string }>;
    connectorUrl?: string;
    redirectUri?: string;
    generatedKey?: string;
  }
): string {
  const s = strings(lang);
  const ready = args.missing.length === 0;
  let body = `<h1>${escapeHtml(s.appName)}</h1><div class="card ${ready ? "ok" : "bad"}">${escapeHtml(
    ready ? s.ready : s.notReady
  )}</div>`;
  if (!ready) {
    body += `<div class="card"><p class="k">${escapeHtml(s.missing)}</p><ul>${args.missing
      .map((m) => `<li><code>${escapeHtml(m.name)}</code><br><span class="k">${escapeHtml(m.hint)}</span></li>`)
      .join("")}</ul></div>`;
  }
  if (args.generatedKey) {
    body += `<div class="card"><p class="k">${escapeHtml(s.generatedKey)}</p><code>${escapeHtml(
      args.generatedKey
    )}</code><p class="k">${escapeHtml(s.keyNote)}</p></div>`;
  }
  if (args.connectorUrl) {
    body += `<div class="card"><p class="k">${escapeHtml(s.connectorUrl)}</p><code>${escapeHtml(args.connectorUrl)}</code></div>`;
  }
  if (args.redirectUri) {
    body += `<div class="card"><p class="k">${escapeHtml(s.redirectUri)}</p><code>${escapeHtml(args.redirectUri)}</code></div>`;
  }
  return renderPage(lang, s.appName, body);
}

export interface ApprovalView {
  kind: "set_privacy" | "schedule";
  videoId: string;
  videoTitle?: string;
  thumbnailUrl?: string;
  currentPrivacy?: string;
  privacyStatus?: "public" | "unlisted";
  publishAtUtc?: string;
  publishAtLocal?: string;
  timeZone?: string;
}

export function approvalPage(lang: Lang, id: string, csrf: string, v: ApprovalView): string {
  const s = strings(lang);
  const actionText =
    v.kind === "schedule" ? s.schedule : v.privacyStatus === "unlisted" ? s.makeUnlisted : s.makePublic;
  const rows: string[] = [];
  rows.push(`<p class="k">${escapeHtml(s.video)}</p><p><strong>${escapeHtml(v.videoTitle ?? v.videoId)}</strong></p>`);
  if (v.thumbnailUrl && /^https:\/\/([a-z0-9-]+\.)*ytimg\.com\//i.test(v.thumbnailUrl)) {
    rows.push(`<img src="${escapeHtml(v.thumbnailUrl)}" alt="" referrerpolicy="no-referrer">`);
  }
  rows.push(`<p class="k">${escapeHtml(s.videoId)}</p><p class="mono">${escapeHtml(v.videoId)}</p>`);
  rows.push(`<p class="k">${escapeHtml(s.action)}</p><p><strong>${escapeHtml(actionText)}</strong></p>`);
  if (v.kind === "schedule") {
    rows.push(
      `<p class="k">${escapeHtml(s.when)}</p><p><strong>${escapeHtml(v.publishAtLocal ?? "")}</strong> (${escapeHtml(
        v.timeZone ?? ""
      )})<br><span class="k">UTC: ${escapeHtml(v.publishAtUtc ?? "")}</span></p>`
    );
  }
  if (v.currentPrivacy) {
    rows.push(`<p class="k">${escapeHtml(s.currentPrivacy)}</p><p>${escapeHtml(v.currentPrivacy)}</p>`);
  }
  const body = `<h1>${escapeHtml(s.approveTitle)}</h1>
<p>${escapeHtml(s.approveIntro)}</p>
<div class="card">${rows.join("")}</div>
<form method="post" action="/approve/${encodeURIComponent(id)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="primary" type="submit" name="decision" value="approve">${escapeHtml(s.approve)}</button>
<button type="submit" name="decision" value="reject">${escapeHtml(s.reject)}</button>
</form>`;
  return renderPage(lang, s.approveTitle, body);
}

export function approvalResultPage(lang: Lang, approved: boolean): string {
  const s = strings(lang);
  return renderPage(
    lang,
    approved ? s.approvedTitle : s.rejectedTitle,
    `<h1 class="${approved ? "ok" : ""}">${escapeHtml(approved ? s.approvedTitle : s.rejectedTitle)}</h1><div class="card">${escapeHtml(
      approved ? s.approvedText : s.rejectedText
    )}</div>`
  );
}
