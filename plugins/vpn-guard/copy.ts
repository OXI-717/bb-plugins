export type Language = 'ru' | 'en';
export const copy = {
  ru: {
    statusUnavailable:'Статус недоступен',
    noNativeRecovery:'Нет пауз от Guard',threadUnit:'тредов',
    nativeScope:'Действует на всех машинах: только встроенные Codex и Claude.',nativeDetails:'Область и ограничения отключения',
    verifiedPolicy:'Обязательная проверка VPN',
    cachedStatus:'Последние данные не подтверждены. Обновите состояние перед изменениями.',stateUnavailable:'Состояние защиты ещё не подтверждено.',
    nativeState:'Плагины BB',machineSettings:'Настройки машин',noMachines:'Машины для защиты не выбраны.',controlHelp:'Как работает блокировка',enforceHelp:'Потеря или неизвестный VPN → блок агентов.',observeHelp:'Наблюдение: блокировка по VPN выключена.',controllerOptional:'Контроллер не подключён. Это необязательная интеграция; управление автоматизациями здесь недоступно.',policyOnly:'Это настройка автоматического отключения. Её выключение не включает плагины обратно.',restorePlugins:'Восстановить плагины',restoreBlocked:'Сначала снимите ручной блок и дождитесь подтверждённого VPN на выбранных машинах.',
    restoreInventory:'Сохранённые расписания',reviewedSchedules:'Проверил изменённые или неоднозначные паузы',guardHold:'Пауза от VPN Guard',manualHold:'Ручная пауза',emergencyHold:'Аварийная остановка',overview:'Общее состояние',pool:'Пул',automations:'Автоматизации',recovery:'Восстановление',linked:'Подключено',notLinked:'Не подключено',partial:'Блокировка или действие выполнены не полностью',paused:'На паузе',available:'Доступны',pendingRecovery:'Ожидает ручного возобновления',pausedSchedules:'Расписаний на паузе',activeRun:'Активный или непроверенный запуск',pauseAutomations:'Приостановить',resumeAutomations:'Возобновить',restoreAutomationsHelp:'Возобновляются только расписания, приостановленные контроллером. Ручные и защитные блоки независимы. Уже выполняющиеся скрипты могут продолжаться.',legacyPause:'Есть отдельный замок автоматизаций или аварийный STOP.',controllerSetup:'Подключение контроллера',controllerPath:'Исполняемый файл контроллера на сервере BB',connectController:'Подключить',disconnectController:'Отключить',verifiedIpv4:'IPv4 подтверждён',unverifiedVpn:'Трафик не подтверждён',

    serverScopeWarning:'Машина сервера не выбрана или не определена: ручной блок Guard не защищает сетевые вызовы пула на ней.',poolHelp:'В Pooler включите «Подчиняться VPN Guard»: тогда ручной блок закроет также сетевые вызовы пула. Без этой связи Guard управляет только тредами BB.',title:'VPN Guard', description:'Управляет запуском Codex, Claude, Cursor и Devin на выбранных машинах. Kimi и Z.ai продолжают работать.',
    language:'Язык', machines:'Машины', machinesHelp:'Выберите машины для защиты, включая сервер пула. Статус VPN читается на каждой из них отдельно.',
    connected:'VPN подключён',disconnected:'VPN отключён',unknown:'VPN неизвестен',outside:'Вне защиты',unavailable:'Недоступна',
    control:'Управление',observe:'Наблюдение',enforce:'Защита по VPN',refresh:'Обновить',
    modeHelp:'Наблюдение не блокирует работу. Защита по VPN удерживает новые сообщения и останавливает защищённые треды при потере VPN.',
    block:'Заблокировать',unblock:'Снять блок',blocked:'Ручной блок включён',notBlocked:'Ручной блок выключен',
    blockHelp:'Ручной блок действует даже при подключённом VPN и в режиме наблюдения. Он сохраняется после перезапуска. Снятие блока возвращает выбранный режим; остановленные задачи не запускаются повторно.',
    stopped:'Остановлено',native:'Блокировка встроенных плагинов',
    nativeHelp:'Отключает встроенные плагины Codex и Claude на ВСЕХ машинах при ручном блоке или потере VPN в режиме защиты. Cursor и Devin не отключаются этим способом. Уже открытые соединения могут продолжать работать.',
    suspend:'Автоматически отключать встроенные плагины',owned:'Отключены Guard',ambiguous:'Нужна ручная проверка',none:'Нет',
    restoreHelp:'Восстановление только вручную. BB не отличает повторное ручное отключение от отключения Guard: перед восстановлением проверьте настройки плагинов.',
    restore:'Восстановить',ack:'Подтвердить',limits:'Границы защиты',
    limitText:'«Отправить сейчас» обходит очередь. Уже выполняющиеся скрипты, сетевые запросы и bridge-процессы не гарантированно останавливаются. Другие ACP ID, кроме перечисленных Cursor/Devin и их Pool-алиасов, не защищены. Это управление BB, а не сетевой firewall. Обнаружение потери VPN занимает до 5 секунд плюс время проверки машины и остановки.',
    errorDetails:'Технические подробности',error:'Не удалось выполнить действие',loading:'Загрузка',mode:'Режим',
  },
  en: {
    statusUnavailable:'Status unavailable',
    noNativeRecovery:'None paused by Guard',threadUnit:'threads',
    nativeScope:'Applies to all machines: native Codex and Claude only.',nativeDetails:'Suspension scope and limits',
    verifiedPolicy:'VPN verification required',
    cachedStatus:'Cached state is unverified. Refresh status before making changes.',stateUnavailable:'Protection state is not confirmed yet.',
    nativeState:'Native plugins',machineSettings:'Machine settings',noMachines:'No protected machines selected.',controlHelp:'How blocking works',enforceHelp:'Lost or unknown VPN evidence blocks protected agents.',observeHelp:'Observe only. Automatic VPN blocking is off.',controllerOptional:'Controller not connected. This integration is optional; automation controls are unavailable here.',policyOnly:'This setting controls automatic suspension. Turning it off does not restore plugins.',restorePlugins:'Restore plugins',restoreBlocked:'Release the manual block and wait for confirmed VPN on selected machines.',
    restoreInventory:'Saved schedules',reviewedSchedules:'Reviewed changed or ambiguous pauses',guardHold:'VPN Guard hold',manualHold:'Manual pause',emergencyHold:'Emergency stop',overview:'Overall status',pool:'Pool',automations:'Automations',recovery:'Recovery',linked:'Linked',notLinked:'Not linked',partial:'Protection or action incomplete',paused:'Paused',available:'Available',pendingRecovery:'Manual resume required',pausedSchedules:'Paused schedules',activeRun:'Active or unverified run',pauseAutomations:'Pause',resumeAutomations:'Resume',restoreAutomationsHelp:'Only controller-owned schedules resume. Manual and protection holds are independent. Running scripts may continue.',legacyPause:'A separate automation lock or emergency STOP remains.',controllerSetup:'Controller setup',controllerPath:'Controller executable on BB server host',connectController:'Connect',disconnectController:'Disconnect',verifiedIpv4:'IPv4 verified',unverifiedVpn:'Traffic unverified',

    serverScopeWarning:'The server machine is not selected or unknown: Guard manual block does not cover pool network calls there.',poolHelp:'Enable Follow VPN Guard in Pooler to also gate its provider-network calls. Without linkage, Guard controls BB threads only.',title:'VPN Guard',description:'Controls Codex, Claude, Cursor and Devin on selected machines. Kimi and Z.ai remain available.',
    language:'Language',machines:'Machines',machinesHelp:'Select protected machines, including the pool server. Each machine supplies its own VPN status.',
    connected:'VPN connected',disconnected:'VPN disconnected',unknown:'VPN unknown',outside:'Outside scope',unavailable:'Unavailable',
    control:'Controls',observe:'Observe',enforce:'Enforce VPN',refresh:'Refresh',
    modeHelp:'Observe does not block work. Enforce VPN holds new messages and stops protected threads when VPN is unavailable.',
    block:'Block',unblock:'Unblock',blocked:'Manual block is on',notBlocked:'Manual block is off',
    blockHelp:'Manual block applies even with connected VPN and in Observe mode. It survives restart. Unblock returns to the selected mode; stopped tasks are not replayed.',
    stopped:'Stopped threads',native:'Additional global suspension',
    nativeHelp:'Disables native Codex and Claude plugins on ALL machines during manual block or VPN loss in Enforce mode. Cursor and Devin are not disabled this way. Existing connections may continue.',
    suspend:'Automatically suspend native plugins',owned:'Disabled by Guard',ambiguous:'Needs manual review',none:'None',
    restoreHelp:'Restore is manual. BB cannot distinguish a redundant manual disable from Guard ownership: review plugin settings before restoring.',
    restore:'Restore',ack:'Confirm',limits:'Protection limits',
    limitText:'Send-now bypasses admission. Running scripts, network requests and bridge processes are not guaranteed stopped. Other ACP IDs are outside scope. This controls BB, not a network firewall. VPN-loss detection takes up to 5 seconds plus host-check and stop latency.',
    errorDetails:'Technical details',error:'Action failed',loading:'Loading',mode:'Mode',
  },
} as const;

export function readableError(message:string,language:Language):string {
  const fallback=language==='ru'?'Не удалось выполнить действие. Проверьте подробности ошибки.':'Action failed. Check the error details.';
  if(language==='en') return fallback;
  const translations:[string,string][]=[
    ['Select the BB server host before connecting automation protection','Выберите машину сервера BB перед подключением автоматизаций.'],
    ['An absolute automation controller path is required','Укажите абсолютный путь к контроллеру автоматизаций.'],
    ['Automation controller is not configured','Контроллер автоматизаций не подключён.'],
    ['Release protection blocks and verify VPN before resuming','Снимите защитные блоки и проверьте VPN перед возобновлением.'],
    ['Automation action incomplete; inspect controller status','Действие выполнено не полностью. Проверьте состояние контроллера.'],
    ['Select at least one machine before enforcement.','Сначала выберите хотя бы одну машину.'],
    ['A newly selected machine is not enrolled.','Выбранная машина не подключена к BB.'],
    ['Release the manual block before restoring native plugins.','Сначала снимите ручной блок, затем восстанавливайте плагины.'],
    ['Selected machines must be connected before restoring native plugins.','Для восстановления плагинов VPN должен быть подключён на всех выбранных машинах.'],
    ['Global native plugin suspension needs explicit acknowledgment.','Подтвердите глобальное отключение встроенных плагинов.'],
  ];
  return translations.find(([source])=>message.includes(source))?.[1]??fallback;
}
