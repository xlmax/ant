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

- application-owned `SessionStore` оперирует immutable serializable records и
  явными `create`, `append`, `read`, `list`; он не импортирует `AgentState`,
  `AgentEvent` или `AgentObserver`;
- durable record envelope имеет schema version, session id, timestamp и opaque
  payload; новая JSONL-запись использует текущую версию формата;
- отдельный application codec переводит между runtime `HistoryEvent` и
  versioned payload, валидирует payload и является единственной границей знания
  о внутренней форме истории;
- transient lifecycle events не кодируются и не попадают в durable store;
- `SessionController`, а не storage adapter, предоставляет runtime observer и
  соблюдает write-before-memory: ошибка append не изменяет in-memory state;
- JSONL adapter читает прежние version 1 records с полем `event` через явную
  envelope migration и продолжает журнал уже текущими records;
- неизвестная будущая envelope/payload version даёт понятную ошибку с номером
  строки, не интерпретируется как torn tail и не повреждает файл;
- неполная последняя запись игнорируется и обрезается только при resume; валидная
  последняя запись без newline сохраняется;
- list использует sidecar только как cache, восстанавливает его из journal и
  изолирует повреждённые сессии warnings;
- reusable contract suite выполняется для `MemorySessionStore` и
  `JsonlSessionStore` и проверяет create/append/read/list, порядок, timestamps,
  isolation, неизвестный id и неизменяемость входных records;
- compatibility tests подтверждают старые task/decision/observation,
  attachments, verification и compaction records;
- полный CLI integration test создаёт, продолжает и повторно открывает сессию в
  новом формате без регрессии пользовательского поведения.

Вне объёма этапа:

- удалённое/распределённое session storage;
- шифрование журналов;
- compaction физического JSONL-файла;
- lifecycle модулей и динамическая регистрация stores.

Результат этапа 5:

- `SessionStore` оперирует только сериализуемыми opaque records через явные
  `create`, `append`, `read`, `list` и не зависит от состояния или observer
  runtime;
- application-owned codec изолирует `HistoryEvent`, версионирует payload и не
  сохраняет transient lifecycle events;
- `SessionController` создаёт observer и обеспечивает write-before-memory для
  прикладных изменений истории;
- JSONL adapter пишет envelope версии 2, читает старые records версии 1,
  продолжает смешанный журнал текущим форматом и диагностирует будущие версии;
- восстановление корректно различает оборванный хвост и валидную запись без
  newline, а metadata sidecar остаётся восстанавливаемым cache;
- добавлен независимый `MemorySessionStore`; обе реализации проходят общий
  contract suite, compatibility и architecture tests;
- CLI integration test создаёт сессию и дважды продолжает её из отдельных
  процессов, подтверждая восстановление полной истории в новом формате.

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

- parser и dispatcher не содержат union/switch со списком встроенных команд:
  `CommandRegistry` регистрирует descriptor, parser и handler каждого модуля и
  до запуска отклоняет повторные имена;
- `/update`, `/model` и `/compact` представлены отдельными handlers; независимая
  тестовая команда подключается одной регистрацией без изменения registry,
  parser, dispatcher или REPL loop;
- `/help`, подсказка опечатки, строгая проверка аргументов и порядок отображения
  команд формируются registry и сохраняют текущее пользовательское поведение;
- terminal input/output описан портом, который владеет readline, user frame,
  stdout/stderr и очисткой экрана; REPL loop не обращается к console/stdin/stdout
  напрямую и гарантированно закрывает input;
- process signals и timeout clock доступны через presentation-порты;
  `TurnRunner` и compact handler не используют global process и
  `AbortSignal.timeout` напрямую и снимают listener при успехе и ошибке;
- update check/install описаны `UpdateService`; startup notice и `/update`
  подменяются в тестах без сети или запуска npm;
- Git branch detection и turn change tracking создаются через порты/factories;
  REPL и `TurnRunner` не создают concrete Git adapters самостоятельно;
- renderer ограничен форматированием и выводом lifecycle/result: он не вызывает
  application API, settings, updater, Git или process operations;
- `TerminalFrontend` только собирает terminal presentation session из
  `AntApplicationApi` и внедрённых presentation dependencies; one-shot и REPL
  используют одну фабрику turn runner;
- contract/unit tests проверяют custom command, конфликт имён, cleanup terminal
  и signal listener, подмену updater/Git adapters и независимость renderer;
- architecture tests запрещают REPL/command infrastructure прямые импорты
  `node:process`, `node:readline`, concrete updater и Git process adapter;
- существующие CLI/REPL команды, тексты, one-shot режим, Windows input и полный
  CLI integration test работают без намеренных регрессий.

Вне объёма этапа:

- динамическая загрузка внешних команд и plugin lifecycle (этапы 7 и 9);
- физическое вынесение terminal frontend в npm package (этап 8);
- смена application API или формата настроек/сессий;
- новый GUI/web frontend;
- permission prompts и sandbox process abstraction.

Результат этапа 6:

- удалены центральные command union, parser и dispatch `switch`; новый
  `CommandRegistry` регистрирует descriptor/parser/handler и диагностирует
  конфликты имён;
- встроенные команды оформлены command modules, включая отдельные handlers для
  `/compact`, `/model` и `/update`; custom command contract test подтверждает
  расширение одной регистрацией;
- terminal input/output, process signals/timeouts, updater и Git presentation
  вынесены в порты с Node.js adapters, подключаемыми в composition root;
- REPL не обращается к global console/stdin/stdout/process, использует injected
  branch/update services и всегда закрывает terminal input;
- `TurnRunner` получает signal и change-tracker factories, снимает interrupt
  listener и освобождает renderer при любом исходе;
- concrete Git branch detector и `TurnChangeTracker` создаются только adapter
  layer, updater не импортируется command/repl infrastructure;
- architecture и unit tests фиксируют границы, cleanup ресурсов и подмену
  updater/Git/process/terminal без сети и внешних процессов;
- one-shot и REPL сохраняют единый turn path, пользовательские команды и
  существующее CLI-поведение.

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

- application-owned `ModuleDescriptor` содержит стабильные `id`, `kind`,
  `apiVersion`, provided/required capabilities; эти поля не принадлежат
  concrete adapters;
- `ModuleRegistry` до создания пользовательской сессии отклоняет пустой или
  повторный id, неподдерживаемую API version, неизвестный kind и неудовлетворённую
  capability с диагностикой модуля и требования;
- registry запускает модули в порядке регистрации только после успешной общей
  валидации; `dispose` вызывается один раз в обратном порядке при штатном
  завершении, ошибке frontend и частичном сбое startup;
- lifecycle state запрещает повторный `start`, регистрацию после запуска и
  использование host после dispose; ошибки cleanup агрегируются без потери
  исходной ошибки;
- health diagnostics различают registered, started, healthy/degraded/failed и
  содержат id, kind, API version, capabilities и сообщение без секретных config;
- composition root явно регистрирует runtime, configuration, provider, session
  store, tool pack и terminal frontend descriptors; startup diagnostics доступны
  application host до первого turn;
- reusable contract suites существуют для `ModelProvider`, `SessionStore`,
  `ToolPack`, `ConfigurationSection` и `Frontend`; все production реализации
  проходят соответствующие suites, минимум одна альтернативная fixture каждого
  контракта подтверждает его независимость;
- integration test подтверждает lifecycle вокруг полного CLI application run и
  cleanup при ошибке frontend, не меняя обычный пользовательский вывод;
- architecture tests запрещают concrete adapters определять собственную форму
  module descriptor или обходить registry при composition.

Вне объёма этапа:

- физическое разделение npm packages (этап 8);
- discovery и загрузка внешних manifests (этап 9);
- sandbox/изоляция исполняемого кода;
- semver ranges шире текущей major API version;
- live start/stop или hot reload модулей во время сессии.

Результат этапа 7:

- добавлены application-owned `ModuleDescriptor`, `AntModule` и
  `ModuleRegistry` с API version, kinds и capability requirements;
- вся композиция валидируется до startup; несовместимые версии, неизвестные
  kinds, конфликты id и отсутствующие capabilities имеют явную диагностику;
- lifecycle запускается в порядке регистрации и освобождается в обратном,
  включая rollback частичного startup и агрегацию ошибок cleanup;
- health diagnostics отражают descriptor, lifecycle state и состояние здоровья;
- composition root регистрирует descriptors runtime, configuration, DeepSeek
  provider, JSONL store, coding tools и terminal frontend;
- application оборачивает полный frontend run в lifecycle host;
- reusable suites provider/session/tool/configuration дополнены frontend и
  lifecycle contract tests; production и альтернативные fixtures проходят их.

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

- корневой проект использует npm workspaces, а исходный код физически разделён
  минимум на `contracts`, `core`, `app`, production adapters и `cli`;
- каждый workspace имеет собственный manifest, TypeScript build boundary и
  явные зависимости; полный build выполняется из корня в корректном порядке;
- package exports отражают только публичные контракты, а импорт чужого `src`,
  неэкспортированного subpath или артефакта `dist` запрещён тестом;
- `core` зависит только от `contracts`, `app` — только от `contracts` и `core`,
  adapters — от разрешённых contracts/app packages, но не друг от друга;
- архитектурные проверки анализируют workspace manifests, exports и импорты и
  обнаруживают нарушение границ на независимой fixture;
- unit-, contract-, architecture- и integration-тесты запускаются из корня без
  обращения к прежнему монолитному `src` layout;
- `npm pack` CLI workspace создаёт один устанавливаемый пользовательский
  артефакт с executable `ant`, runtime dependencies и необходимыми prompts;
- запуск упакованного CLI в чистом временном проекте проходит smoke/integration
  сценарий, включая загрузку production composition;
- публичное CLI-поведение, настройки и формат существующих сессий сохраняют
  обратную совместимость; старые пользовательские данные покрыты regression
  tests;
- старый корневой `src` удалён после переноса, документация описывает новую
  структуру, а `check`, `lint`, format check, полный test suite, build и pack
  verification проходят из чистого checkout.

Результат этапа 8:

- исходный код физически разделён на восемь npm workspace packages с отдельными
  manifests, public root exports и TypeScript project references;
- межпакетные импорты используют только package names; архитектурный analyzer
  проверяет manifests, допустимый dependency graph и запрет обхода exports и
  подтверждён независимой нарушающей fixture;
- прежний корневой `src` удалён, а unit-, research- и integration-код переведён
  на workspace layout;
- корневые `check`, `test`, `build` и остальные команды оркестрируют весь
  workspace без ручного выбора пакетов;
- production composition собирается в единый executable bundle; команда
  `npm pack --workspace ant` создаёт самодостаточный пользовательский tarball с
  prompt и необходимой Windows runtime dependency;
- integration test устанавливает tarball в чистый временный проект, читает
  legacy settings, выполняет модельный ход через production composition и
  проверяет создание versioned JSONL-сессии.

## Этап 9. Динамические внешние плагины

Добавить контролируемое внешнее расширение поверх стабилизированного package API.
Первой поддерживаемой extension point является tool pack: она уже имеет
capabilities, side-effect metadata и независимый contract suite. Статическая
регистрация встроенных модулей остаётся полноценным поддерживаемым способом
композиции.

Критерии готовности:

- опубликованный CLI содержит документированный `ant/plugin-api` с TypeScript
  контрактами plugin manifest, activation context и external tool pack без
  импорта внутренних `@ant/*` packages;
- manifest имеет schema version, стабильный plugin id, plugin version,
  совместимый диапазон host API, entrypoint и явный список permissions;
- loader обнаруживает только явно установленные плагины из user registry,
  валидирует manifest до исполнения кода и запрещает выход entrypoint за корень
  установленного plugin package;
- несовместимая API version, неизвестная permission, конфликт plugin id,
  отсутствующий entrypoint и malformed manifest диагностируются до activation;
- установка поддерживает локальный каталог или npm-compatible tarball, копирует
  его атомарно в user plugin directory и не исполняет package lifecycle scripts;
- install требует явного подтверждения всех запрошенных permissions; registry
  хранит source, version, approved permissions и enabled state без секретов;
- повторная установка служит контролируемым update: новая версия сначала
  валидируется и только затем атомарно заменяет предыдущую; remove обратимо
  удаляет registry entry и установленный package;
- плагины считаются доверенным кодом в процессе ANT, что явно отражено в CLI и
  документации; permissions ограничивают выдаваемые host capabilities, но не
  заявляют о sandbox/isolation, которых фактически нет;
- activation получает только workspace, logger, approved permissions и
  стабильную host API version; plugin не получает application internals или
  composition root;
- активированные external tool packs проходят тот же `ToolRegistry` validation,
  что и встроенный pack; конфликт tool names, owner id или capabilities
  обнаруживается до пользовательского хода;
- ошибка одного optional plugin изолируется: остальные плагины и штатный CLI
  продолжают запуск, а startup diagnostics содержат plugin id, version, state и
  безопасное сообщение ошибки без повреждения settings и sessions;
- CLI предоставляет `plugins list`, `plugins inspect`, `plugins install`,
  `plugins enable`, `plugins disable` и `plugins remove`, не требующие model API
  key и не запускающие agent session;
- reference plugin fixture устанавливается, обнаруживается и выполняет tool call
  в end-to-end тесте из упакованного CLI без изменения исходников платформы;
- contract, architecture и security regression tests покрывают traversal,
  symlink escape, permission escalation, несовместимость API, partial install,
  broken activation и cleanup;
- README описывает создание, проверку, установку и доверие plugin, а `check`,
  lint, format check, полный test suite, build и pack verification проходят.

Вне объёма этапа:

- sandbox, отдельный процесс или защита от злонамеренного JavaScript после
  явного доверия пользователя;
- загрузка plugins напрямую из сети или собственный package registry;
- динамические model provider, frontend и session-store plugins до появления
  реальных внешних реализаций и отдельных permission models;
- автоматическое обновление plugin без явной команды пользователя.

Результат этапа 9:

- CLI публикует независимый `ant/plugin-api` с host API version, manifest и
  activation/tool-pack contracts, а также reusable validator для авторских
  contract tests;
- manifest validation проверяет schema, стабильные ids и versions,
  совместимость API, известные permissions и безопасный относительный
  entrypoint до исполнения plugin code;
- file registry хранит только явно установленные plugins, approved permissions
  и enabled state; duplicate ids и повреждённая schema диагностируются;
- installer принимает локальные npm-compatible directories и tarballs,
  отключает lifecycle scripts, отклоняет symlinks, сохраняет runtime
  dependencies и атомарно устанавливает/обновляет plugin;
- remove переносит package в recoverable `.trash`, enable/disable не меняют
  package, а команды list/inspect/install/enable/disable/remove выполняются без
  model API key;
- loader проверяет registry/manifest consistency, permissions и canonical entry
  path, изолирует broken activation и выдаёт plugin только approved workspace,
  logger, permissions и API version;
- external tool packs проходят общий ownership, duplicate-name, non-empty и
  capability contract, затем регистрируются тем же `ToolRegistry`, что и
  встроенный coding pack; конфликтный pack изолируется до пользовательского
  хода;
- startup diagnostics показывают version/state каждого установленного plugin,
  не раскрывая внутреннюю ошибку broken plugin;
- packed-CLI integration test устанавливает reference plugin из tarball,
  импортирует публичный `ant/plugin-api`, выполняет реальный external tool call
  через production composition и продолжает versioned session;
- README документирует trust model без ложного обещания sandbox, manifest,
  permissions, lifecycle commands и минимальный TypeScript authoring flow.
- относительно baseline `aad515e` release tarball уменьшился с 120 948 до
  69 313 bytes (-43%), unpacked payload — с 538 499 до 290 727 bytes (-46%), а
  медианный `--version` startup в локальном 10-run замере снизился с 213 до
  177 ms; внешние runtime dependencies при этом остаются обычными npm
  dependencies, как до перехода на workspaces.

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
- [x] Этап 5. Версионированный session contract
- [x] Этап 6. Декомпозиция terminal frontend
- [x] Этап 7. Lifecycle и contract tests
- [x] Этап 8. npm workspaces
- [x] Этап 9. Динамические внешние плагины
