export type Language = 'ru' | 'en';
export const copy = {
  ru: {
    title:'VPN Guard', description:'Управляет запуском Codex, Claude, Cursor и Devin на выбранных машинах. Kimi и Z.ai продолжают работать.',
    language:'Язык', machines:'Машины', machinesHelp:'Выберите машины для защиты. Статус VPN читается на каждой из них отдельно.',
    connected:'VPN подключён',disconnected:'VPN отключён',unknown:'VPN неизвестен',outside:'Вне защиты',unavailable:'Недоступна',
    control:'Управление',observe:'Наблюдение',enforce:'Защита по VPN',refresh:'Обновить',
    modeHelp:'Наблюдение не блокирует работу. Защита по VPN удерживает новые сообщения и останавливает защищённые треды при потере VPN.',
    block:'Заблокировать',unblock:'Снять блок',blocked:'Ручной блок включён',notBlocked:'Ручной блок выключен',
    blockHelp:'Ручной блок действует даже при подключённом VPN и в режиме наблюдения. Он сохраняется после перезапуска. Снятие блока возвращает выбранный режим; остановленные задачи не запускаются повторно.',
    stopped:'Остановленных тредов',native:'Дополнительная глобальная блокировка',
    nativeHelp:'Отключает встроенные плагины Codex и Claude на ВСЕХ машинах при ручном блоке или потере VPN в режиме защиты. Cursor и Devin не отключаются этим способом. Уже открытые соединения могут продолжать работать.',
    suspend:'Отключать встроенные плагины глобально',owned:'Отключены Guard',ambiguous:'Нужна ручная проверка',none:'Нет',
    restoreHelp:'Восстановление только вручную. BB не отличает повторное ручное отключение от отключения Guard: перед восстановлением проверьте настройки плагинов.',
    restore:'Восстановить',ack:'Проверено: снять отметку',limits:'Границы защиты',
    limitText:'«Отправить сейчас» обходит очередь. Уже выполняющиеся скрипты, сетевые запросы и bridge-процессы не гарантированно останавливаются. Другие ACP ID не защищены. Это управление BB, а не сетевой firewall. Обнаружение потери VPN занимает до 5 секунд плюс время проверки машины и остановки.',
    errorDetails:'Технические подробности',error:'Не удалось выполнить действие',loading:'Загрузка',mode:'Режим',
  },
  en: {
    title:'VPN Guard',description:'Controls Codex, Claude, Cursor and Devin on selected machines. Kimi and Z.ai remain available.',
    language:'Language',machines:'Machines',machinesHelp:'Select protected machines. Each machine supplies its own VPN status.',
    connected:'VPN connected',disconnected:'VPN disconnected',unknown:'VPN unknown',outside:'Outside scope',unavailable:'Unavailable',
    control:'Controls',observe:'Observe',enforce:'Enforce VPN',refresh:'Refresh',
    modeHelp:'Observe does not block work. Enforce VPN holds new messages and stops protected threads when VPN is unavailable.',
    block:'Block',unblock:'Unblock',blocked:'Manual block is on',notBlocked:'Manual block is off',
    blockHelp:'Manual block applies even with connected VPN and in Observe mode. It survives restart. Unblock returns to the selected mode; stopped tasks are not replayed.',
    stopped:'Stopped threads',native:'Additional global suspension',
    nativeHelp:'Disables native Codex and Claude plugins on ALL machines during manual block or VPN loss in Enforce mode. Cursor and Devin are not disabled this way. Existing connections may continue.',
    suspend:'Suspend native plugins globally',owned:'Disabled by Guard',ambiguous:'Needs manual review',none:'None',
    restoreHelp:'Restore is manual. BB cannot distinguish a redundant manual disable from Guard ownership: review plugin settings before restoring.',
    restore:'Restore',ack:'Reviewed: clear entry',limits:'Protection limits',
    limitText:'Send-now bypasses admission. Running scripts, network requests and bridge processes are not guaranteed stopped. Other ACP IDs are outside scope. This controls BB, not a network firewall. VPN-loss detection takes up to 5 seconds plus host-check and stop latency.',
    errorDetails:'Technical details',error:'Action failed',loading:'Loading',mode:'Mode',
  },
} as const;

export function readableError(message:string,language:Language):string {
  const fallback=language==='ru'?'Не удалось выполнить действие. Проверьте подробности ошибки.':'Action failed. Check the error details.';
  if(language==='en') return fallback;
  const translations:[string,string][]=[
    ['Select at least one machine before enforcement.','Сначала выберите хотя бы одну машину.'],
    ['A newly selected machine is not enrolled.','Выбранная машина не подключена к BB.'],
    ['Release the manual block before restoring native plugins.','Сначала снимите ручной блок, затем восстанавливайте плагины.'],
    ['Selected machines must be connected before restoring native plugins.','Для восстановления плагинов VPN должен быть подключён на всех выбранных машинах.'],
    ['Global native plugin suspension needs explicit acknowledgment.','Подтвердите глобальное отключение встроенных плагинов.'],
  ];
  return translations.find(([source])=>message.includes(source))?.[1]??fallback;
}
