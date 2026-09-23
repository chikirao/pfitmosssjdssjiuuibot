import { TOKEN_SCRIPT } from "../../../src/shared/tokenScript";
import { api } from "../api";
import { emit, state } from "../state";
import { openLink } from "../tg";
import { $, closeSheet, copyText, icon, openSheet, toast, withLoading } from "../ui";

/** Шит «Подключить / сменить токен ИТМО». */
export function openTokenSheet(after?: () => void) {
  const replacing = state.me?.token.status === "ok";
  openSheet(
    `<div class="sheet-head"><h2>${replacing ? "Сменить токен ИТМО" : "Подключить my.itmo.ru"}</h2></div>
    <ol class="steps">
      <li><div>
        Скопируй скрипт — он достаёт токены из cookie my.itmo.ru
        <div class="actions" style="margin-top:8px"><button class="btn btn-primary has-icon" id="copyScript">${icon("copy")}<span>Скопировать скрипт</span></button></div>
      </div></li>
      <li><div>
        На компьютере открой my.itmo.ru, нажми <kbd>F12</kbd> → Console, вставь скрипт и <kbd>Enter</kbd>
        <p class="muted" style="margin:4px 0 0">Если Chrome не даёт вставить — один раз напечатай <code>allow pasting</code>.</p>
        <div class="actions" style="margin-top:8px"><button class="btn btn-tertiary has-icon" id="openItmo">${icon("ext")}<span>Открыть my.itmo.ru</span></button></div>
      </div></li>
      <li><div>
        Вставь сюда то, что скопировал скрипт (или просто пришли это боту)
        <textarea id="tokenInput" placeholder='{"access":"Bearer eyJ…","refresh":"eyJ…"}' spellcheck="false" autocomplete="off" style="margin-top:8px"></textarea>
        <div class="actions"><button class="btn btn-ok block lg" id="saveToken">Сохранить</button></div>
      </div></li>
    </ol>
    <div class="note">${icon("shield")} Токены хранятся на сервере бота только в зашифрованном виде (AES-256-GCM) и используются лишь для запросов к my.itmo.ru от твоего имени. Удалить их можно в «Профиле».</div>`,
    (body) => {
      const copyBtn = $<HTMLButtonElement>("#copyScript", body);
      copyBtn.onclick = async () => {
        const ok = await copyText(TOKEN_SCRIPT);
        if (!ok) return toast("Не удалось скопировать", true);
        copyBtn.querySelector("span")!.textContent = "Скопировано";
        copyBtn.querySelector("use")!.setAttribute("href", "#i-check");
        setTimeout(() => {
          copyBtn.querySelector("span")!.textContent = "Скопировать скрипт";
          copyBtn.querySelector("use")!.setAttribute("href", "#i-copy");
        }, 1800);
      };
      $<HTMLButtonElement>("#openItmo", body).onclick = () => openLink("https://my.itmo.ru/sport/sign");
      const save = $<HTMLButtonElement>("#saveToken", body);
      save.onclick = () =>
        withLoading(save, async () => {
          const text = $<HTMLTextAreaElement>("#tokenInput", body).value.trim();
          if (!text) throw new Error("Вставь вывод скрипта");
          const r = await api.setToken(text);
          if (state.me) state.me.token = r.token;
          emit("me");
          closeSheet();
          toast(r.hasRefresh ? "Токен сохранён" : "Сохранён только access-токен (≈30 мин)", !r.hasRefresh);
          after?.();
        });
    },
  );
}
