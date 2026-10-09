/** Shared account-card layout; colours follow the host's light/dark theme. */
export const accountSettingsCss = `
.pool-settings { --pool-control:36px; --pool-field:224px; --pool-number:112px; --pool-action:160px; font-size:14px; line-height:1.5; }
.pool-settings-section { border-top:1px solid var(--border,#ddd); padding-top:16px; display:grid; gap:12px; min-width:0; }
.pool-settings-heading { margin:0; font-size:14px; line-height:20px; font-weight:600; }
.pool-settings-help { margin:0; color:var(--muted-foreground,#666); font-size:12px; line-height:18px; }
.pool-settings-field { display:grid; gap:6px; min-width:0; font-size:14px; }
.pool-settings-control { box-sizing:border-box; width:100%; min-width:0; height:var(--pool-control); border:1px solid var(--input,#ddd); border-radius:6px; background:var(--background,white); color:inherit; padding:6px 10px; font:inherit; font-size:14px; }
.pool-settings-control:focus-visible { outline:2px solid var(--ring,#888); outline-offset:2px; }
.pool-settings-control:disabled, fieldset:disabled .pool-settings-control { opacity:.5; cursor:not-allowed; }
.pool-settings-fields { display:grid; gap:12px; border:0; margin:0; padding:0; min-width:0; }
.pool-settings-inline, .pool-settings-project { display:grid; grid-template-columns:minmax(0,1fr) var(--pool-field) 36px; align-items:center; gap:6px 8px; }
.pool-settings-project { padding:8px 0; border-bottom:1px solid var(--border,#ddd); }
.pool-settings-project-name { overflow-wrap:anywhere; font-size:14px; line-height:20px; }
.pool-settings-inline > .pool-settings-control { grid-column:2; }
.pool-settings-inline > .pool-settings-help { grid-column:1/-1; }
.pool-settings-number > .pool-settings-control { width:var(--pool-number); justify-self:start; font-variant-numeric:tabular-nums; }
.pool-settings-project-add > .pool-settings-control { grid-column:2/-1; }
.pool-settings-toggle { display:flex; align-items:center; gap:8px; font-size:14px; line-height:20px; min-height:var(--pool-control); }
.pool-settings-toggle input { appearance:none; box-sizing:border-box; margin:0; width:16px; height:16px; border:1px solid var(--input,#999); border-radius:3px; background:var(--background,white); flex:none; position:relative; }
.pool-settings-toggle input:checked { background:var(--foreground,#333); border-color:var(--foreground,#333); }
.pool-settings-toggle input:checked:after { content:''; position:absolute; left:4px; top:1px; width:5px; height:9px; border:solid var(--background,white); border-width:0 2px 2px 0; transform:rotate(45deg); }
.pool-settings-toggle input:focus-visible { outline:2px solid var(--ring,#888); outline-offset:2px; }
.pool-settings-status { min-height:18px; font-size:12px; line-height:18px; color:var(--muted-foreground,#666); margin:0; }
.pool-settings-error { font-size:12px; line-height:18px; color:var(--destructive-text,#b42318); }
.pool-settings-schedule { display:grid; gap:12px; padding:12px 0; border-top:1px solid var(--border,#ddd); border-bottom:1px solid var(--border,#ddd); }
.pool-settings-days { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:4px; }
.pool-settings-days, .pool-settings-times { grid-column:2/-1; }
.pool-settings-days .pool-settings-toggle { font-size:12px; gap:4px; }
.pool-settings-times { display:grid; grid-template-columns:var(--pool-number) var(--pool-number); gap:12px; }
.pool-settings-schedule-actions { display:flex; flex-wrap:wrap; gap:8px; }
.pool-settings button:not([aria-label='Закрыть']) { box-sizing:border-box; height:var(--pool-control); min-height:var(--pool-control); width:var(--pool-action); padding:6px 10px; border:1px solid var(--input,#ddd); border-radius:6px; font:inherit; font-size:12px; line-height:18px; justify-self:start; }
.pool-settings .pool-settings-remove { width:36px!important; padding:0!important; font-size:18px!important; }
.pool-settings button[aria-label='Закрыть'] { width:36px; height:var(--pool-control); padding:0; }
.pool-settings footer, .pool-settings .pool-settings-footer { display:flex; flex-wrap:wrap; justify-content:flex-start; gap:8px; }
/* All setting labels and controls share the same left edge at every width. */
.pool-settings-inline { grid-template-columns:minmax(0,1fr); justify-items:start; }
.pool-settings-inline > .pool-settings-control { grid-column:1; }
.pool-settings-control { width:var(--pool-field); max-width:100%; }
.pool-settings-project { grid-template-columns:minmax(0,var(--pool-field)) 36px; justify-content:start; }
.pool-settings-project-name { grid-column:1/-1; }
.pool-settings-project-add > .pool-settings-control { grid-column:1; width:calc(var(--pool-field) + 44px); }
.pool-settings-days, .pool-settings-times { grid-column:1; min-width:0; }
.pool-settings-days { display:flex; flex-wrap:wrap; gap:8px 16px; }
.pool-settings-times { display:flex; flex-wrap:wrap; gap:12px; }
.pool-settings-times .pool-settings-control { width:var(--pool-number); }
.pool-settings-times .pool-settings-field { min-width:0; }
.pool-settings-schedule-fields .pool-settings-control { width:100%; }
.pool-settings-project { grid-template-columns:minmax(0,1fr) 36px; }
.pool-settings-project > .pool-settings-control { width:100%; }
.pool-settings-inline:not(.pool-settings-number) > .pool-settings-control { width:100%; }
.pool-settings-interval { display:grid; width:100%; min-width:0; grid-template-columns:minmax(0,1fr) 96px 12px 96px 36px; align-items:center; gap:8px; }
.pool-settings-time-separator { text-align:center; }
@media(max-width:400px) {
 .pool-settings-interval { grid-template-columns:minmax(0,1fr) 64px 8px 64px 28px; gap:4px; }
 .pool-settings-interval .pool-settings-control { padding:4px; font-size:12px; }
 .pool-settings-interval input::-webkit-calendar-picker-indicator { display:none; }
 .pool-settings-interval .pool-settings-remove { width:28px!important; }
}
@media(pointer:coarse) { .pool-settings { --pool-control:40px; } .pool-settings-control, .pool-settings-interval .pool-settings-control { font-size:16px; } }
`;

export function AccountSettingsStyle() {
  return <style>{accountSettingsCss}</style>;
}
