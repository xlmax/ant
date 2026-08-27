# План развития модульности ANT

## Цель

Превратить ANT в устойчивую модульную платформу для coding-agent приложений, в
которой ядро и прикладные сценарии не зависят от конкретной модели, интерфейса,
хранилища, набора инструментов и способа конфигурации, а функциональность
собирается из заменяемых модулей через стабильные версионированные контракты.

Новый provider, frontend, session store, tool pack или инфраструктурный модуль
должен подключаться добавлением собственной реализации и регистрацией в
composition root или plugin manifest — без изменения `core`, `app`, существующих
адаптеров и центральных union-типов. Замена одного модуля не должна требовать
переписывания остальных или нарушать совместимость пользовательских настроек и
сохранённых сессий.

Модульность не является самоцелью: итоговая архитектура должна сохранять
простоту установки и запуска ANT как единого CLI, текущее пользовательское
поведение, наблюдаемость ошибок и предсказуемое управление ресурсами. Внешнее
расширение допускается только через явно версионированный API, диагностику
совместимости и модель доверия/разрешений.

## Конечное состояние и критерии готовности всего плана

Весь план считается выполненным только при одновременном выполнении следующих
условий.

### Независимость ядра и приложения

- `core` содержит только предметную модель и runtime-контракты и не зависит от
  Node.js API, файловой системы, terminal UI, конкретных providers и storage;
- `app` владеет прикладными сценариями и публичными портами, но не знает о
  DeepSeek, JSONL, terminal, Git, Bash и других конкретных адаптерах;
- frontend обращается к application API и не собирает runtime, provider,
  environment и session store самостоятельно;
- архитектурные тесты запрещают обратные зависимости, внутренние импорты
  модулей и runtime-циклы.

### Реальная заменяемость модулей

- model provider, frontend, session store и tool pack имеют стабильные
  версионированные контракты;
- для каждого ключевого контракта существуют минимум две независимые реализации
  или production-реализация и полноценная reference/fake-реализация;
- каждая реализация проходит общий reusable contract test suite;
- добавление реализации не требует изменения общих типов, `core`, `app` или уже
  существующих адаптеров;
- активный набор модулей определяется только composition root/registry и, для
  внешних расширений, manifest.

### Модульная конфигурация и совместимость данных

- каждый configurable-модуль владеет своим namespace, schema, defaults,
  валидацией и миграциями;
- секреты и опасные endpoint-настройки имеют отдельные правила доверия и не
  могут быть незаметно подменены проектом;
- формат сессий явно версионирован и отделён от внутренней формы `AgentState`;
- настройки и сессии поддерживаемых старых версий читаются напрямую или
  мигрируются атомарно с тестами обратной совместимости;
- замена storage adapter не меняет семантику сессий для приложения и frontend.

### Композиция, lifecycle и диагностика

- каждый подключаемый модуль имеет стабильный id, API version, declared
  capabilities и, при необходимости, lifecycle `start`/`dispose`;
- конфликты id, отсутствующие capabilities и несовместимые версии выявляются до
  запуска пользовательской сессии;
- startup diagnostics позволяют определить, какие модули и версии активны;
- ресурсы корректно освобождаются при штатном завершении, отмене и ошибке;
- сбой необязательного внешнего модуля диагностируется без повреждения настроек,
  сессий и остальных модулей.

### Поставка и расширение

- логические модули физически разделены на workspace packages с ограниченными
  public exports;
- штатная поставка остаётся единым устанавливаемым CLI и не требует от
  пользователя ручной сборки модулей;
- встроенная конфигурация ANT полностью собирается через тот же публичный
  механизм, который предназначен для альтернативных модулей;
- внешний совместимый модуль можно установить, обнаружить, проверить и
  подключить без изменения исходного кода ANT;
- для внешних модулей определены manifest, совместимость API, permissions/trust
  model и безопасное поведение при ошибке загрузки.

### Качество и сохранение поведения

- все unit-, contract-, architecture- и integration-тесты проходят на
  поддерживаемых платформах;
- end-to-end тест подтверждает полный цикл: запуск, создание/возобновление
  сессии, модельный ход, tool calls, compaction, завершение и повторное открытие;
- минимум одна end-to-end конфигурация использует альтернативный provider,
  frontend или storage, а не только штатный набор адаптеров;
- производительность, время запуска и размер поставки измерены и не имеют
  необоснованной регрессии относительно зафиксированной базовой версии;
- README и документация модулей позволяют реализовать и подключить новый модуль
  без изучения внутренних исходников ANT.

Итоговый практический тест цели: независимый разработчик, опираясь только на
публичные контракты и документацию, может создать новый модуль, проверить его
общим contract suite, подключить к установленному ANT и использовать в полной
сессии без изменения исходников платформы.

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

- до этапа 2 `ModelSettings` и конфигурация приложения знали о DeepSeek;
- terminal frontend владеет значительной частью прикладной оркестрации;
- до этапа 1 frontend получал низкоуровневые runtime, provider, environment и
  session store вместо прикладных сценариев;
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

## Порядок реализации каждого этапа

Каждый этап выполняется в отдельной ветке, созданной от актуальной
`feat/modularity`, и проходит один и тот же обязательный цикл.

1. **Согласовать критерии приёмки.** До изменения production-кода определить
   ожидаемое поведение, архитектурные границы, требования совместимости и
   проверяемые условия завершения этапа.
2. **Спроектировать проверки.** На основании критериев написать или обновить
   unit-, contract-, architecture- и, при необходимости, integration-тесты.
   Тесты должны проверять поведение и границы модуля, а не детали конкретной
   реализации.
3. **Реализовать этап.** Изменять production-код до выполнения всех критериев
   приёмки и прохождения подготовленных тестов. Объём изменений ограничивать
   текущим этапом.
4. **Провести полную проверку.** Запустить typecheck, lint, unit- и
   integration-тесты, проверить миграции и обратную совместимость, если этап их
   затрагивает, и выполнить архитектурный review итогового diff.
5. **Зафиксировать результат.** Обновить документацию и статус этапа, описать
   принятые решения и известные ограничения.
6. **Завершить этап.** Этап считается завершённым только после выполнения всех
   критериев приёмки и успешного прохождения полного набора проверок. Только
   после этого его ветка может быть перенесена в `feat/modularity`.

Если в процессе реализации меняются границы или критерии этапа, сначала
обновляются критерии приёмки и тесты, и лишь затем продолжается production-код.

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
- frontend получает application client, а не контейнер низкоуровневых runtime,
  provider, environment и session store;
- application client владеет активной сессией, текущей моделью и summarizer и
  предоставляет их состояние только через read-only API;
- `submitTurn` создаёт или продолжает сессию, надёжно журналирует пользовательский
  ввод и делегирует выполнение runtime с переданными observers/stream callbacks;
- `compactContext` не изменяет сессию без достаточного числа ходов, при
  неэффективном резюме или при ошибке/отмене; успешное сжатие сохраняется до
  изменения in-memory state;
- `selectModel` и `selectThinking` сохраняют настройку и пересоздают model и
  summarizer только после успешного сохранения;
- one-shot и REPL сохраняют текущее поведение CLI, вывод, отмену, таймауты,
  change summary и exit code;
- прикладные сценарии имеют unit-тесты без terminal I/O, а полный CLI-цикл
  подтверждён integration-тестом.

Вне объёма этапа:

- provider-neutral settings и несколько model providers (этап 2);
- tool registry (этап 3);
- изменение формата JSONL-сессий (этап 5);
- registry REPL-команд и полная декомпозиция terminal UI (этап 6).

Результат этапа 1:

- добавлен стабильный presentation-контракт `AntApplicationApi` и его реализация
  `AntApplicationClient`;
- application client владеет активной сессией, model/summarizer, выполнением
  ходов, таймаутами, compaction и переключением model/thinking;
- one-shot и REPL выполняют ход через единый `submitTurn`;
- terminal frontend больше не получает runtime, provider, environment и session
  store и не создаёт их зависимые объекты;
- удалён низкоуровневый `AntHostContext`, ранее передававший инфраструктуру во
  frontend;
- архитектурный тест запрещает UI прямые зависимости от model provider, session
  controller и runtime;
- сценарии application client покрыты unit-тестами, полный CLI-цикл подтверждён
  integration-тестом.

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
- application contract использует `ModelConfiguration` с `providerId`,
  `modelId` и непрозрачными `providerOptions`, которые интерпретирует только
  provider adapter;
- provider возвращает стандартный `ModelDescriptor` с context window и
  capabilities для vision/reasoning; application и UI не читают provider
  options напрямую;
- альтернативный provider можно зарегистрировать без изменения общих типов;
- capabilities получаются через контракт, а не выводятся UI;
- правила переключения модели и reasoning принадлежат provider и возвращают
  новую конфигурацию без мутации исходной;
- application сохраняет provider-owned update до замены активных model и
  summarizer; ошибка сохранения оставляет активную конфигурацию неизменной;
- DeepSeek adapter сам валидирует свои options, определяет vision fallback и
  поддерживаемые reasoning efforts;
- UI отображает только стандартный descriptor и не содержит DeepSeek-специфичной
  логики или названий;
- текущие настройки DeepSeek продолжают загружаться или мигрируются явно;
- прежние JSON-настройки (`provider`, `id`, `baseUrl`, `contextWindow`, `vision`,
  `thinking`) сохраняют поведение и правила безопасности `baseUrl`;
- есть тестовая вторая реализация provider с иными opaque options и
  capabilities, проходящая общий contract suite;
- architecture test запрещает `app` зависеть от каталога `models` и запрещает
  UI читать provider options.

Вне объёма этапа:

- динамическая регистрация нескольких providers из settings (будущая композиция
  и plugin lifecycle);
- namespaced schemas и миграционная инфраструктура конфигурации (этап 4);
- изменение DeepSeek API protocol и JSONL session format;
- динамическая загрузка внешних plugins.

Результат этапа 2:

- добавлены provider-neutral `ModelConfiguration`, `ModelDescriptor` и
  `ModelProvider`; provider-specific options остаются непрозрачными для `app` и
  UI;
- DeepSeek adapter владеет валидацией options, vision fallback, reasoning
  capabilities и правилами переключения модели/reasoning;
- application client сохраняет provider-owned изменения до замены активных
  model и summarizer;
- UI отображает стандартный descriptor и не содержит DeepSeek-специфичной
  политики;
- старый плоский формат DeepSeek-настроек продолжает загружаться, включая
  прежнее правило доверия для `baseUrl`; новый формат `model.options` позволяет
  хранить opaque provider options;
- общий contract suite проходит DeepSeek adapter и независимая тестовая
  реализация provider с другими options и capabilities;
- архитектурные тесты запрещают DeepSeek-зависимости в `app` и доступ UI к
  provider options.

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

- публичные `Tool`, `ToolMetadata`, `ToolContext` и `ToolPack` принадлежат
  application contract, а не конкретному adapter-каталогу `tools`;
- каждый tool объявляет стабильный owner/namespace, side-effect classification,
  `parallelSafe` и требуемые platform capabilities;
- factory пакета получает только ограниченный `ToolContext`: workspace,
  разрешённые filesystem/process capabilities и logger, без доступа к
  application container;
- `ToolRegistry` принимает независимые packs и собирает инструменты в порядке
  регистрации; новый pack подключается одной регистрацией в composition root;
- `createCodingTools` удалён: текущие `read`, `glob`, `grep`, `bash`, `edit` и
  `write` поставляются встроенным coding tool pack;
- registry до создания environment отклоняет повторный id пакета, пустой pack,
  несовпадение owner и конфликт имён с диагностикой обоих владельцев;
- environment принимает инструменты из registry и определяет параллельность
  только по стандартным metadata: группа выполняется параллельно, лишь когда
  каждый вызванный tool помечен `parallelSafe` и не имеет side effects;
- contract tests проверяют регистрацию второго независимого pack, порядок,
  диагностику конфликтов и правила последовательного/параллельного выполнения;
- architecture tests запрещают concrete tool adapters владеть публичным
  контрактом и не позволяют `app` зависеть от каталога `tools`;
- текущие шесть инструментов сохраняют имена, JSON-schema, результат, streaming,
  abort/timeout и фактическое поведение; полный CLI integration test проходит.

Вне объёма этапа:

- динамическая загрузка внешних пакетов и lifecycle plugins;
- permission prompts и sandbox enforcement;
- namespaced tool settings (этап 4);
- изменение модельного tool-call protocol;
- разбиение встроенного coding pack на отдельные npm-пакеты (этап 8).

Результат этапа 3:

- публичные `Tool`, `ToolMetadata`, `ToolContext` и `ToolPack` перенесены в
  application contract;
- добавлен `ToolRegistry`, который сохраняет порядок packs и до запуска
  диагностирует повторный pack id, пустые packs, неверного owner, конфликт имён
  и недостающие platform capabilities;
- `ToolEnvironment` определяет допустимость параллельного выполнения по
  стандартным metadata и выполняет side-effecting tools последовательно;
- прежний `createCodingTools` заменён встроенным `codingToolPack`; composition
  root и evaluation harness подключают его через registry;
- все шесть встроенных tools объявляют owner, side effects, parallel-safety и
  требуемые filesystem/process capabilities;
- contract tests подтверждают подключение независимых packs, порядок,
  диагностику и параллельность; architecture tests фиксируют владение
  контрактом слоем `app`.

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

- application получает `ConfigurationSnapshot` и извлекает типизированные
  секции по стабильным keys; центральный aggregate `AppSettings` удалён;
- публичный `ConfigurationSection` объявляет namespace, текущую schema version,
  defaults, validator/parser, migrations, merge policy, project override policy
  и secret/sensitive paths;
- `ConfigurationRegistry` принимает секции без изменения центрального parser;
  повторный namespace отклоняется при регистрации;
- filesystem service только читает user/project layers, распознаёт legacy или
  versioned envelope, маршрутизирует raw sections владельцам и выполняет
  validate/migrate/merge; он не знает полей model, UI, tools и других модулей;
- новый канонический формат имеет root schema version и version каждой секции;
  неизвестный namespace, будущая root/section version и отсутствующая migration
  дают понятную ошибку с source и namespace;
- существующие model, UI, prompts, tools, limits и verification оформлены
  отдельными зарегистрированными section modules;
- DeepSeek adapter владеет model-section parser/migrations/defaults и получает
  `DEEPSEEK_API_KEY` только из environment; секрет нельзя загрузить из user или
  project settings;
- project layer не может менять provider, endpoint/`baseUrl` и иные объявленные
  sensitive paths, но сохраняет разрешённые model/UI overrides;
- старый плоский `settings.json` полностью поддерживается при чтении; первая
  операция сохранения атомарно переводит user-файл в канонический формат без
  потери неизвестных безопасных данных зарегистрированных секций;
- generic save API обновляет только указанную секцию, валидирует результат и не
  пишет частичный/некорректный файл;
- contract tests со второй искусственной секцией доказывают регистрацию без
  правки service, defaults, обе layers, migration, version diagnostics,
  sensitive/secret policy и атомарное сохранение;
- прежние настройки и CLI-поведение проходят compatibility и полный integration
  tests.

Вне объёма этапа:

- динамическое обнаружение section modules и plugin lifecycle;
- шифрование secret storage или vault integration;
- изменение JSONL session format;
- удалённая конфигурация и live reload.

Результат этапа 4:

- центральный `AppSettings` и монолитный parser удалены; application читает
  типизированные секции из `ConfigurationSnapshot`;
- добавлены `ConfigurationSection`, `ConfigurationRegistry` и section-agnostic
  `FileConfigurationService` с versioned envelope, migrations и атомарным save;
- model-конфигурация, defaults, legacy migration и secret/sensitive policy
  принадлежат DeepSeek-модулю; UI, prompts, tools, limits и verification
  зарегистрированы отдельными встроенными секциями;
- user/project layers валидируются и объединяются владельцами секций; project не
  может подменить provider, endpoint или сохранить секрет;
- старый плоский формат полностью поддерживается при чтении и переводится в
  канонический формат при первой операции сохранения;
- независимая тестовая секция подтверждает подключение без изменения service,
  миграции, версии, trust policy и отказоустойчивое сохранение;
- architecture tests фиксируют отсутствие знаний о конкретных полях в
  filesystem service и явную регистрацию секций в composition root.

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

- [x] Этап 1. Прикладные сценарии
- [x] Этап 2. Provider-neutral модельный контракт
- [x] Этап 3. Tool registry и tool packs
- [x] Этап 4. Модульная конфигурация
- [ ] Этап 5. Версионированный session contract
- [ ] Этап 6. Декомпозиция terminal frontend
- [ ] Этап 7. Lifecycle и contract tests
- [ ] Этап 8. npm workspaces
- [ ] Этап 9. Динамические внешние плагины
