# Plugin UI standard / Стандарт интерфейсов плагинов

## Русский

- Панели используют шрифт и цвета темы BB. Основной текст и заголовки секций — 14 px, подсказки — 12 px; заголовок страницы — 20 px.
- Одинаковые боковые отступы: 20 px на широком экране, 16 px на мобильном. Секции используют одну ширину и одинаковые интервалы.
- Кнопки: минимум 36 px высоты, на мобильном 40 px. Обычные действия одной ширины 160 px, в мобильной сетке — одинаковые колонки. Короткие языковые/иконные кнопки одинаковой компактной ширины.
- Чекбоксы 16 px, подпись рядом, зона нажатия минимум 36 px. Поля для коротких чисел остаются компактными. Длинные названия переносятся, не расширяют панель.
- Один язык интерфейса за раз. RU по умолчанию, EN доступен отдельным компактным переключателем и сохраняется на клиенте. Переводятся заголовки, действия, подсказки, состояния и ограничения; идентификаторы CLI не переводятся.
- Одинаковые действия называются одинаково: «Обновить», «Восстановить», «Заблокировать», «Снять блок». Опасное действие выделяется цветом и явно описывает область воздействия. Изменение не должно выглядеть успешным до ответа сервера; при ошибке перечитать фактическое состояние.
- Настройка поведения и разовое действие разделены. Чекбокс включает или выключает политику; восстановление ресурсов — отдельное действие с конкретным названием («Восстановить плагины»). Отключение политики не выдаётся за восстановление. Недоступные необязательные интеграции показывают состояние и подключение, без пустого набора кнопок.
- Учитывать ширину самой панели, а не только окна браузера. Основное состояние и управление видны сразу; подробные настройки раскрываются по требованию. Переполненные названия переносятся. Панель не создаёт собственный вложенный скролл; обычная вертикальная прокрутка страницы на малом экране допустима.
- Перед публикацией: функциональные проверки, сборка, просмотр настоящей панели с синтетическими данными на 320, 390 и широком экране, RU/EN, светлой и тёмной теме. Проверить переполнение, длинные имена, высоты, выравнивание, доступность с клавиатуры и состояния ошибки/блокировки.
- Применять стандарт к новым и изменяемым панелям. Массовое изменение всех существующих плагинов — отдельная задача. Базовый стандарт согласован в документации карточки Account Pooler.

## English

Use BB theme colours and inherited fonts: body/section headings 14 px, help 12 px, page title 20 px. Keep equal side padding (20 px desktop, 16 px mobile) and consistent section spacing. Action controls are at least 36 px high, 40 px on mobile; desktop actions are 160 px wide and mobile actions use equal grid columns. Compact language/icon controls share their own equal width. Checkboxes are 16 px with an adjacent label and generous click target. Short numeric fields stay compact; long names wrap.

Show one language at a time: Russian by default with a persisted RU/EN selector. Translate labels, actions, state, help and limits, keeping CLI identifiers unchanged. Reuse action wording, distinguish dangerous actions and their scope, and display actual server state after failures. Before publication inspect the real panel with synthetic data at 320/390/desktop widths in both languages and light/dark themes. Check overflow, long names, alignment, keyboard focus and error/block states. Apply to new or changed panels; repository-wide migration is a separate task.

Separate persistent policies from one-time actions: a checkbox changes a policy, while restoration uses an explicitly scoped action such as Restore plugins. Turning off a policy does not imply restoration. Unconnected optional integrations show setup rather than unusable actions. Design for the panel's width, including narrow panels inside wide windows. Keep primary state and controls visible; disclose detailed settings on demand. Avoid nested panel scrolling and horizontal overflow; ordinary vertical page scrolling remains available on small screens.
