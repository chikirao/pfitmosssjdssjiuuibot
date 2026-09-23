/** Скрипт для консоли my.itmo.ru: копирует access+refresh одним JSON. */
export const TOKEN_SCRIPT =
  "(()=>{const g=n=>decodeURIComponent((document.cookie.match('(^|; )'+n.replace(/\\./g,'\\\\.')+'=([^;]*)')||[])[2]||'');" +
  "const s=JSON.stringify({access:g('auth._token.itmoId'),refresh:g('auth._refresh_token.itmoId')});" +
  "try{copy(s);console.log('%c✓ Скопировано — вставь в бота','color:#6f8a2a;font-weight:bold')}catch(e){prompt('Скопируй:',s)}})()";
