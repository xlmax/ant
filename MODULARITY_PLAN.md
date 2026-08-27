# План развития модульности ANT

## Цель

Превратить ANT из хорошо разделённого монолита в приложение со статически
подключаемыми и независимо заменяемыми модулями. Новый provider, frontend,
session store или tool pack должен подключаться добавлением реализации и одной
регистрацией в composition root — без изменений в `app`, существующих адаптерах
и центральных union-типах.

Динамическая загрузка сторонних плагинов не является ближайшей целью. Сначала
нужно стабилизировать контракты и подтвердить их пригодность несколькими
реализациями.

## Текущее состояние

Уже сделано:

- зависимости между слоями направлены внутрь и контролируются AST-тестом;
- `core` не зависит от инфраструктуры;
- основные порты принадлежат слоям `core` и `app`;
- `main.ts` служит composition root;
- runtime, frontend, model provider, session store и environment можно подменять
  при сборке приложения;
- runtime-циклы и запрещённые межслойные импорты обнаруживаются тестами.

Основные ограничения:

- `ModelSettings` и конфигурация приложения знают о DeepSeek;
- terminal frontend владеет значительной частью прикладной оркестрации;
- `AntHostContext` отдаёт frontend низкоуровневые сервисы вместо прикладных
  сценариев;
- набор инструментов статически задан в `createCodingTools`;
- настройки всех компонентов собраны в одном центральном типе и parser;
- session storage связан с внутренними `AgentState` и `AgentObserver`;
- REPL-команды, updater, Git change tracking и terminal I/O тесно связаны внутри
  слоя `ui`;
- у модулей нет общего lifecycle, версии API и диагностики совместимости.

## Принципы реализации

1. Сначала укреплять логические контракты, затем разделять код на пакеты.
2. Каждый новый порт подтверждать как минимум двумя реализациями.
3. Прикладные сценарии должны принадлежать `app`, а frontend — только управлять
   вводом, выводом и пользовательским взаимодействием.
4. Конкретные provider/tool/storage настройки должны принадлежать реализующему
   модулю.
5. Сохранять обратную совместимость настроек и JSONL-сессий либо предоставлять
   явные миграции.
6. Каждый этап должен оставлять репозиторий в рабочем состоянии и проходить все
   существующие проверки.

## Этап 1. Прикладные сценарии вместо оркестрации во frontend

Вынести из `TerminalFrontend`, `repl.ts`, `command-controller.ts` и
`TurnRunner` прикладные операции в слой `app`.

Предполагаемый API:

- `startSession`;
- `resumeSession`;
- `submitTurn`;
- `cancelTurn`;
- `compactContext`;
- `selectModel`;
- `selectThinking`;
- `getContextStatus`;
- `listModels`.

Frontend должен вызывать эти операции и отображать события, не соединяя
самостоятельно runtime, provider, session store и environment.

Критерии готовности:

- one-shot и REPL используют один прикладной путь выполнения хода;
- terminal frontend не создаёт модель, summarizer и session controller вручную;
- бизнес-правила переключения модели, compaction и отмены тестируются без
  terminal I/O;
- существующее поведение CLI и REPL не изменилось.

## Этап 2. Provider-neutral модельный контракт

Убрать знания о DeepSeek из `app/configuration.ts` и общих контрактов.

Предполагаемые сущности:

- `ModelSelection { providerId, modelId }`;
- `ModelDescriptor` с capabilities: vision, reasoning, context window;
- `ModelProvider.id`;
- `ModelProvider.listModels`;
- `ModelProvider.createModel`;
- конфигурация provider, валидируемая самим provider-модулем.

DeepSeek-специфичные `thinking`, `reasoning_effort`, эвристика vision и `baseUrl`
должны принадлежать модулю DeepSeek.

Критерии готовности:

- `app` не содержит литерал или union-тип `deepseek`;
- альтернативный provider можно зарегистрировать без изменения общих типов;
- capabilities получаются через контракт, а не выводятся UI;
- текущие настройки DeepSeek продолжают загружаться или мигрируются явно;
- есть тестовая вторая реализация provider.

## Этап 3. Tool registry и tool packs

Перенести публичный контракт инструмента из конкретного слоя `tools` в слой
контрактов (`app` или отдельный contracts-слой) и добавить `ToolRegistry`.

Текущие инструменты собрать в первый пакет, например `coding-tools`:

- filesystem: `read`, `glob`, `grep`, `edit`, `write`;
- process: `bash`.

Factory инструмента должен получать ограниченный `ToolContext`: workspace,
настройки, logger и явно разрешённые platform capabilities.

Метаданные инструмента должны описывать как минимум:

- read-only или side-effecting поведение;
- возможность параллельного запуска;
- требуемые capabilities;
- namespace или стабильный id владельца.

Критерии готовности:

- новый tool pack подключается регистрацией в composition root;
- `createCodingTools` перестаёт быть центральным списком всех инструментов;
- конфликт имён диагностируется до запуска агента;
- правила последовательного и параллельного выполнения покрыты contract tests;
- текущие шесть инструментов сохраняют публичное поведение.

## Этап 4. Модульная конфигурация

Заменить растущий центральный `AppSettings` композицией секций настроек,
принадлежащих модулям.

Каждый configurable-модуль объявляет:

- стабильный namespace/id;
- defaults;
- schema и validator;
- версию и миграции;
- правила user/project override;
- секретные поля и способ их получения.

Центральный configuration service отвечает только за загрузку слоёв, merge,
маршрутизацию секций владельцам и безопасное сохранение.

Критерии готовности:

- новый модуль не требует правки центрального parser для собственных настроек;
- неизвестные namespace и несовместимые версии дают понятную диагностику;
- `model.baseUrl` и секреты сохраняют текущую защиту от проектной подмены;
- старые `settings.json` поддерживаются или мигрируются атомарно;
- правила приоритета user/project покрыты тестами.

## Этап 5. Версионированный session contract

Отвязать хранилище сессий от внутреннего представления `AgentState` и механизма
`AgentObserver`.

Предполагаемый контракт:

- версионированные сериализуемые session records;
- явные операции create/append/read/list;
- разделение durable history и transient lifecycle events;
- codec/migration boundary между journal records и состоянием runtime;
- возможность восстановления после неполной последней записи.

Критерии готовности:

- формат JSONL имеет явную schema version;
- старые журналы открываются через миграцию/совместимый reader;
- session store не принимает внутренний mutable `AgentState`;
- MemorySessionStore и JsonlSessionStore проходят общий набор contract tests;
- смена внутренней формы state не требует переписывать storage adapter.

## Этап 6. Декомпозиция terminal frontend

Разделить текущий слой `ui` на самостоятельные адаптеры и сервисы:

- terminal input/output;
- renderer;
- registry обработчиков REPL-команд;
- process signals и clock;
- updater;
- Git change detector;
- presentation моделей, сессий и контекста.

REPL-команды должны регистрироваться handlers, а не добавляться в центральный
`switch`.

Критерии готовности:

- `/update`, `/model`, `/compact` представлены отдельными handlers;
- updater и Git detector подменяются в тестах через порты;
- command registry допускает добавление команды без изменения controller;
- renderer не выполняет прикладные операции;
- terminal frontend зависит только от API приложения и presentation-портов.

## Этап 7. Lifecycle, capabilities и contract tests

Ввести общий descriptor/lifecycle для подключаемых модулей:

- `id`;
- `apiVersion`;
- declared capabilities;
- `start`/`dispose` при необходимости;
- health/diagnostics;
- проверка конфликтов и совместимости при composition.

Для основных портов создать переиспользуемые contract test suites:

- ModelProvider;
- SessionStore;
- ToolPack/Tool;
- Frontend или application client;
- configuration section.

Критерии готовности:

- несовместимый модуль отклоняется до начала пользовательской сессии;
- ресурсы корректно освобождаются при штатном завершении и ошибке запуска;
- каждая production-реализация проходит соответствующий contract suite;
- startup diagnostics перечисляет активные модули и их версии.

## Этап 8. Физическое разделение на packages

После стабилизации контрактов перейти на npm workspaces. Возможная структура:

- `packages/contracts`;
- `packages/core`;
- `packages/app`;
- `packages/provider-deepseek`;
- `packages/session-jsonl`;
- `packages/tools-coding`;
- `packages/frontend-terminal`;
- `packages/cli`.

Критерии готовности:

- package exports отражают только публичные контракты;
- adapters зависят от contracts/app, но не друг от друга;
- архитектурные проверки работают между workspace packages;
- сборка и публикация CLI остаются единым пользовательским артефактом;
- внутренние импорты между пакетами запрещены.

## Этап 9. Динамические внешние плагины

Переходить к динамической загрузке только после появления нескольких реальных
альтернативных модулей и стабилизации API.

Потребуются:

- manifest и discovery;
- диапазоны совместимых API versions;
- разрешение зависимостей и конфликтов;
- trust model и явные permissions;
- изоляция или ясное предупреждение об исполнении доверенного кода;
- политика установки, обновления и удаления;
- диагностика ошибки загрузки без падения всего приложения.

Этот этап не должен блокировать предыдущие: статическая регистрация остаётся
полноценным поддерживаемым способом композиции.

## Рекомендуемый порядок ближайших задач

1. Спроектировать application API для `submitTurn`, session lifecycle и
   compaction.
2. Перевести one-shot и REPL на единый application service.
3. Обобщить `ModelProvider` и удалить DeepSeek-зависимости из app contracts.
4. Добавить второй минимальный provider для проверки контракта.
5. Ввести `ToolRegistry` и оформить текущие инструменты как tool pack.
6. Разделить конфигурацию по namespace модулей.
7. Версионировать session records и внедрить storage contract tests.
8. Декомпозировать REPL-команды и инфраструктурные части terminal frontend.
9. Добавить общий module lifecycle и diagnostics.
10. После стабилизации границ перейти на npm workspaces.
11. Рассматривать динамические плагины только на основе накопленного опыта.

## Общие критерии для каждого шага

- `npm run check`, `npm run lint` и все unit/integration tests проходят;
- архитектурный тест не ослабляется ради новой зависимости;
- публичное CLI/REPL-поведение меняется только намеренно;
- изменения настроек и формата сессий имеют миграционный тест;
- новая абстракция используется минимум двумя реализациями либо явно отмечена
  как подготовительная;
- README и этот план обновляются после завершения этапа.

## Статус

- [ ] Этап 1. Прикладные сценарии
- [ ] Этап 2. Provider-neutral модельный контракт
- [ ] Этап 3. Tool registry и tool packs
- [ ] Этап 4. Модульная конфигурация
- [ ] Этап 5. Версионированный session contract
- [ ] Этап 6. Декомпозиция terminal frontend
- [ ] Этап 7. Lifecycle и contract tests
- [ ] Этап 8. npm workspaces
- [ ] Этап 9. Динамические внешние плагины
