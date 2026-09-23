/**
 * Скрипт для консоли my.itmo.ru: копирует access+refresh одним JSON.
 * Nuxt Auth хранит токены и в localStorage, и в cookie; cookie браузер может отбросить (размер),
 * поэтому сначала localStorage. Значение "false" — так Nuxt Auth помечает отсутствующий токен.
 */
export const TOKEN_SCRIPT =
  "(()=>{const c=n=>decodeURIComponent((document.cookie.match('(^|; )'+n.replace(/\\./g,'\\\\.')+'=([^;]*)')||[])[2]||'');" +
  "const g=n=>{let v='';try{v=localStorage.getItem(n)||''}catch(e){}if(!v||v==='false')v=c(n);return v==='false'?'':v};" +
  "const a=g('auth._token.itmoId'),r=g('auth._refresh_token.itmoId');const s=JSON.stringify({access:a,refresh:r});" +
  "try{copy(s)}catch(e){prompt('Скопируй:',s)}" +
  "console.log(r?'%c✓ Скопировано (access + refresh) — вставь в бота':'%c⚠ Скопирован только access: refresh-токен не найден. Выйди из my.itmo.ru, войди заново и запусти ещё раз',r?'color:#6f8a2a;font-weight:bold':'color:#b7791f;font-weight:bold')})()";
