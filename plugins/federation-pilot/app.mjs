import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { mountFederation } from './lifecycle.mjs';
const PLUGIN_ID = typeof __BB_PLUGIN_ID__ === 'string' ? __BB_PLUGIN_ID__ : 'federation-pilot';
export default definePluginApp(app => {
  app.contentScripts.register({id:'federation-transport',mount:context=>mountFederation(context,window,PLUGIN_ID)});
});
